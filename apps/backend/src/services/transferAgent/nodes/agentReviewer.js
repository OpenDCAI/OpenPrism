/**
 * agentReviewer — Reviewer node for the agentic transfer.
 *
 * The Reviewer inspects the target project after the Generator has made changes,
 * checking for venue compliance, correctness, and completeness.
 * It produces a structured review result with verdict ('pass' or 'revise').
 *
 * All venue-specific constraints are loaded from reviewerChecklist skill —
 * the prompt skeleton here is venue-agnostic.
 *
 * Tools available: readFile, grepFile, listProjectTree, raiseQuestion
 */

import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { buildVenueSkillFromState } from '../skills/index.js';
import { buildReviewChecklist } from '../skills/reviewerChecklist.js';
import { createReviewerTools } from '../tools/index.js';
import { NeuripsPhase, progressUpdate } from '../progressMeta.js';
import { extractJSON } from '../utils.js';
import { bumpLiveProgress, runAgentToolCall, recordUnknownToolTrace } from '../toolTrace.js';
import { traceLlmInvoke, chatOpenAiTraceRawFields } from '../llmCallTrace.js';
import { unmaskWorkspaceWithKV } from '../mock/mockService.js';

const MAX_TOOL_ROUNDS = 20;
const MAX_STALLED_ROUNDS = 6;

/**
 * Run the Reviewer agent.
 *
 * Inspects the current state of target files and produces a review verdict.
 */
export async function agentReviewer(state, config) {
  const iteration = state.currentIteration || 0;
  const intake = state.transferIntake || {};
  const lp = config?.configurable?._liveProgress;

  // Build tools
  const ctx = {
    sourceReadRoot: state.sourceReadRoot || state.sourceProjectRoot,
    workspaceRoot: state.workspaceRoot || state.targetProjectRoot,
    jobId: state.jobId,
    mockEnabled: state.mockEnabled,
    mockMapPath: state.mockMapPath,
  };
  const tools = createReviewerTools(ctx);

  // Build LLM
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.1,
    ...chatOpenAiTraceRawFields(),
  });
  const llmWithTools = llm.bindTools(tools);

  // Build system prompt (venue-specific skill)
  const skill = await buildVenueSkillFromState(state);

  // Load venue-specific review checklist
  const venueId = (intake.venue || state.transferGraphKind || 'neurips').toLowerCase();
  const venueUpper = venueId.toUpperCase();
  const checklist = buildReviewChecklist(venueId, { intake });

  // ── Build user message (venue-agnostic skeleton) ──

  const userMessage = `You are the REVIEWER (iteration ${iteration}). Inspect the target ${venueUpper} project and determine if the migration is complete and correct.

Target main file: "${state.targetMainFile}"

REVIEW CHECKLIST — check each item using tools:

1. STRUCTURE & COMPILATION READINESS:
   - \\documentclass{article} (not revtex, amsart, llncs, etc.)
   ${checklist.structure}
   - \\begin{document} ... \\end{document} present and well-formed

2. CONTENT COMPLETENESS:
   - All source sections mapped to target (compare with source)
   - Mathematical content, equations preserved
   - \\cite{}, \\ref{}, \\label{} references intact
   - No placeholder text like "TODO", "INSERT HERE", "FIXME" in the body

3. FIGURE/TABLE COMPLIANCE:
   ${checklist.figures}

4. BIBLIOGRAPHY:
   - Bibliography mechanism is consistent (bibtex natbib, or \\input{.bbl})
   ${checklist.bibliography}

5. ASSETS:
   - All referenced images exist in target project
   - Required .sty/.cls/.bst files present

${checklist.policy}

7. ${checklist.blind}

INSTRUCTIONS:
1. Use readFile to read the target main .tex file
2. Use grepFile to check for specific patterns
3. Use listProjectTree to verify asset files exist
4. Compare key sections with the source if needed
5. If you discover an issue requiring user decision, use raiseQuestion

After your review, output a JSON result in <REVIEW_RESULT> tags:

<REVIEW_RESULT>
{
  "verdict": "pass" or "revise",
  "issues": [
    {
      "category": "structure|content|figures|bibliography|assets|policy|blind",
      "severity": "high|medium|low",
      "description": "What's wrong",
      "suggestion": "How to fix it"
    }
  ],
  "suggestions": ["General improvement suggestions"],
  "summary": "Brief overall assessment"
}
</REVIEW_RESULT>

Rules for verdict:
- "pass" = no high-severity issues, the file is submission-ready
- "revise" = has high or multiple medium-severity issues that must be fixed`;

  // Run tool-calling loop
  const messages = [
    { role: 'system', content: skill },
    { role: 'user', content: userMessage },
  ];

  let reviewResult = null;
  let stalledRounds = 0;
  const projectRoot = state.workspaceRoot || state.targetProjectRoot;
  const jobId = state.jobId;
  // Reviewer must inspect full paper text (unmasked).
  if (state.mockEnabled && state.mockMapPath && projectRoot) {
    await unmaskWorkspaceWithKV({ workspaceRoot: projectRoot, mockMapPath: state.mockMapPath });
  }

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (lp) {
        lp.activeRole = 'reviewer';
        lp.toolName = 'llm';
        lp.toolArgs = '';
        lp.toolRound = round;
        lp.maxToolRounds = MAX_TOOL_ROUNDS;
        bumpLiveProgress(lp);
      }
      const traceCtx = projectRoot && jobId
        ? { projectRoot, jobId, agent: 'reviewer', iteration, round }
        : null;
      const response = await traceLlmInvoke(traceCtx, messages, () => llmWithTools.invoke(messages));
      messages.push(response);

    // Check for tool calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      stalledRounds = 0;
      for (const toolCall of response.tool_calls) {
        const tool = tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          await recordUnknownToolTrace({
            config,
            lp,
            projectRoot,
            jobId,
            agent: 'reviewer',
            iteration,
            round,
            toolName: toolCall.name,
          });
          messages.push({
            role: 'tool',
            content: `[ERROR] Unknown tool: ${toolCall.name}`,
            tool_call_id: toolCall.id,
          });
          continue;
        }
        if (lp) lp.maxToolRounds = MAX_TOOL_ROUNDS;
          let result;
          try {
            result = await runAgentToolCall({
              config,
              lp,
              projectRoot,
              jobId,
              agent: 'reviewer',
              iteration,
              round,
              toolCall,
              mockMapPath: state.mockMapPath,
              remockOnWrite: false,
              invokeFn: () => tool.invoke(toolCall.args),
            });
          } catch (err) {
            result = `[ERROR] Tool ${toolCall.name} failed: ${err?.message || String(err)}`;
          }
        messages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }
      continue;
    }

    // No tool calls — extract review result
    const content =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : '';
    const compact = (content || '').trim();

    const reviewMatch = content.match(
      /<REVIEW_RESULT>([\s\S]*?)<\/REVIEW_RESULT>/,
    );
    if (reviewMatch) {
      try {
        reviewResult = JSON.parse(reviewMatch[1].trim());
      } catch {
        reviewResult = extractJSON(reviewMatch[1]);
      }
    }

      if (!reviewResult) {
        const noProgress = !compact || compact === '.';
        stalledRounds = noProgress ? stalledRounds + 1 : 0;
        const forceJsonOnly = stalledRounds >= 3;
        messages.push({
          role: 'user',
          content: forceJsonOnly
            ? 'STOP free-form text. Return ONLY <REVIEW_RESULT>{...}</REVIEW_RESULT> with valid JSON and no extra commentary. If uncertain, set verdict to "revise" and explain blockers in issues[].'
            : 'Please output your review result as a JSON object inside <REVIEW_RESULT> tags.',
        });
        if (stalledRounds >= MAX_STALLED_ROUNDS) break;
        continue;
      }

      break;
    }
  } finally {
    if (state.mockEnabled && state.mockMapPath && projectRoot) {
      await unmaskWorkspaceWithKV({ workspaceRoot: projectRoot, mockMapPath: state.mockMapPath });
    }
  }

  // Fallback
  if (!reviewResult) {
    reviewResult = {
      verdict: 'revise',
      issues: [
        {
          category: 'policy',
          severity: 'high',
          description: 'Reviewer did not produce a structured <REVIEW_RESULT> within the allowed rounds.',
          suggestion: 'Re-run reviewer with stricter JSON-only response constraints and re-check the target files.',
        },
      ],
      suggestions: [],
      summary: 'Reviewer could not complete structured review; fail-closed to revise.',
      _reviewerError: true,
    };
  }

  // Ensure verdict is valid
  if (!['pass', 'revise'].includes(reviewResult.verdict)) {
    reviewResult.verdict = reviewResult.issues?.some(
      (i) => i.severity === 'high',
    )
      ? 'revise'
      : 'pass';
  }

  const isPass = reviewResult.verdict === 'pass';
  const nextIteration = isPass ? iteration : iteration + 1;

  return {
    reviewResult,
    currentIteration: nextIteration,
    agentPhase: isPass ? 'finalized' : 'planning',
    ...progressUpdate(
      'agentReviewer',
      NeuripsPhase.agent_reviewing,
      `Iteration ${iteration}: verdict=${reviewResult.verdict}, ${(reviewResult.issues || []).length} issues. ${reviewResult.summary || ''}`,
      isPass ? 'info' : 'warn',
    ),
  };
}
