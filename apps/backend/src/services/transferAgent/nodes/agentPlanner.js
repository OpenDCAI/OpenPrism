/**
 * agentPlanner — Planner node for the NeurIPS agentic transfer.
 *
 * The Planner autonomously explores source and target projects using tools,
 * then produces a structured migration plan. On subsequent iterations
 * (when Reviewer sends back issues), it revises the plan accordingly.
 *
 * Tools available: readFile, grepFile, listProjectTree, raiseQuestion
 */

import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { buildVenueSkillFromState } from '../skills/index.js';
import { createReadOnlyTools } from '../tools/index.js';
import { NeuripsPhase, progressUpdate } from '../progressMeta.js';
import { briefToolArgs } from '../utils.js';
import { analyzeSource, buildSourceProfile } from './analyzeSource.js';
import { analyzeTarget } from './analyzeTarget.js';

const MAX_TOOL_ROUNDS = 20;

/**
 * Run the Planner agent.
 *
 * On iteration 0: performs source/target analysis, then calls LLM with tools
 * to explore and produce a migration plan.
 *
 * On iteration N>0: receives reviewer feedback, revises the plan.
 */
export async function agentPlanner(state, config) {
  const iteration = state.currentIteration || 0;
  const lp = config?.configurable?._liveProgress;

  // --- First iteration: run source + target analysis ---
  let analysisState = {};
  if (iteration === 0) {
    // Reuse existing analysis logic (no LLM, pure heuristic)
    const sourceResult = await analyzeSource(state);
    const targetResult = await analyzeTarget({ ...state, ...sourceResult });
    analysisState = { ...sourceResult, ...targetResult };
  }

  const mergedState = { ...state, ...analysisState };

  // Build tools with project roots
  const ctx = {
    sourceReadRoot: mergedState.sourceReadRoot || mergedState.sourceProjectRoot,
    workspaceRoot: mergedState.workspaceRoot || mergedState.targetProjectRoot,
    jobId: mergedState.jobId,
  };
  const tools = createReadOnlyTools(ctx);

  // Build LLM
  const { endpoint, apiKey, model } = resolveLLMConfig(mergedState.llmConfig);
  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });
  const llmWithTools = llm.bindTools(tools);

  // Build system prompt
  const skill = await buildVenueSkillFromState(mergedState);

  // Build user message for this iteration
  const isMineruMode = mergedState.transferMode === 'mineru';
  const sourceDesc = isMineruMode
    ? `The source content has been parsed from PDF by MinerU into Markdown format.
   - Markdown content is available in the target project under _mineru_output/
   - Images extracted from the PDF are also in _mineru_output/
   - You should read the Markdown content and convert it to LaTeX for the target template.
   - The source project may also have the original .tex files for reference.`
    : `Source main file: "${mergedState.sourceMainFile}"`;

  let userMessage;
  if (iteration === 0) {
    userMessage = `You are the PLANNER. Your job is to explore the source and target projects and produce a detailed migration plan.

${isMineruMode ? 'SOURCE MODE: MinerU (PDF → Markdown → LaTeX)\n' : ''}INSTRUCTIONS:
1. Use listProjectTree to see what files exist in both projects
2. Use readFile to examine key files (${isMineruMode ? 'look for Markdown files in _mineru_output/ and' : `source main file: "${mergedState.sourceMainFile}",`} target main file: "${mergedState.targetMainFile}")
3. Analyze the source paper's structure, ${isMineruMode ? 'sections, figures, tables, equations, and references from the Markdown' : 'packages, bibliography mechanism, figures, and special formatting'}
4. Study the target template structure (follow the venue-specific rules in your system prompt)
5. If you need user input on ambiguous decisions (e.g., float strategy, content dropping), use raiseQuestion

After exploring, output your migration plan as a JSON object wrapped in <MIGRATION_PLAN> tags:

<MIGRATION_PLAN>
{
  "sectionMapping": [
    { "sourceSection": "...", "targetSection": "...", "action": "map|merge|create|drop" }
  ],
  "assetStrategy": {
    "bibFiles": ["files to copy"],
    "images": ["image files to copy"],
    "styles": ["style files to copy"],
    "bibCommand": "bibliography|addbibresource|input_bbl"
  },
  "preambleStrategy": "description of how to handle preamble migration",
  "bodyStrategy": "description of how to handle body migration",
  "bibliographyStrategy": "description of bibliography handling",
  "blindStrategy": "description of double-blind compliance steps (if applicable)",
  "figureStrategy": "description of figure/table normalization",
  "risks": ["potential issues to watch for"],
  "notes": "any special instructions"
}
</MIGRATION_PLAN>`;
  } else {
    const review = mergedState.reviewResult || {};
    const issues = (review.issues || [])
      .map((iss, i) => `  ${i + 1}. [${iss.severity || 'medium'}] ${iss.description}`)
      .join('\n');
    const suggestions = (review.suggestions || []).join('\n  - ');

    userMessage = `You are the PLANNER (revision iteration ${iteration}).

The Reviewer found the following issues with the previous migration:

ISSUES:
${issues || '  (none)'}

SUGGESTIONS:
  - ${suggestions || '(none)'}

PREVIOUS PLAN:
${JSON.stringify(mergedState.migrationPlan || {}, null, 2)}

Please revise the migration plan to address these issues. Use tools to inspect the current state of target files if needed.

Output the revised plan in <MIGRATION_PLAN> tags (same JSON format as before).`;
  }

  // Run tool-calling loop
  const messages = [
    { role: 'system', content: skill },
    { role: 'user', content: userMessage },
  ];

  let plan = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (lp) { lp.activeRole = 'planner'; lp.toolName = 'llm'; lp.toolArgs = ''; lp.toolRound = round; lp.maxToolRounds = MAX_TOOL_ROUNDS; lp.lastUpdate = Date.now(); }
    const response = await llmWithTools.invoke(messages);
    messages.push(response);

    // Check for tool calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const toolCall of response.tool_calls) {
        const tool = tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          messages.push({
            role: 'tool',
            content: `[ERROR] Unknown tool: ${toolCall.name}`,
            tool_call_id: toolCall.id,
          });
          continue;
        }
        if (lp) { lp.toolName = toolCall.name; lp.toolArgs = briefToolArgs(toolCall.name, toolCall.args); lp.lastUpdate = Date.now(); }
        const result = await tool.invoke(toolCall.args);
        messages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }
      continue;
    }

    // No tool calls — extract plan from response
    const content =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : '';

    const planMatch = content.match(
      /<MIGRATION_PLAN>([\s\S]*?)<\/MIGRATION_PLAN>/,
    );
    if (planMatch) {
      try {
        plan = JSON.parse(planMatch[1].trim());
      } catch {
        // Try to extract JSON more aggressively
        const { extractJSON } = await import('../utils.js');
        plan = extractJSON(planMatch[1]);
      }
    }

    if (!plan) {
      // Ask the LLM to output the plan properly
      messages.push({
        role: 'user',
        content:
          'Please output your migration plan as a JSON object inside <MIGRATION_PLAN> tags.',
      });
      continue;
    }

    break;
  }

  // Fallback plan if LLM didn't produce one
  if (!plan) {
    plan = {
      sectionMapping: [],
      assetStrategy: {},
      notes: 'Planner failed to produce a structured plan after max rounds.',
      _plannerError: true,
    };
  }

  return {
    ...analysisState,
    migrationPlan: plan,
    transferPlan: plan, // backward compat
    agentPhase: 'generating',
    ...progressUpdate(
      'agentPlanner',
      NeuripsPhase.agent_planning,
      `Iteration ${iteration}: migration plan ${plan._plannerError ? 'FAILED' : 'ready'} (${(plan.sectionMapping || []).length} section mappings).`,
    ),
  };
}
