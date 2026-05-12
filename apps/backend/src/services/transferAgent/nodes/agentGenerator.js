/**
 * agentGenerator — Generator node for the multi-venue agentic transfer (graphVenueAgent).
 *
 * The Generator takes the migration plan from the Planner and executes it
 * by reading source files, writing/patching target files, and copying assets.
 * It operates autonomously through tool calls, deciding the order and strategy
 * of modifications (preamble first, then body, then figures, then bibliography, etc.).
 *
 * Tools available: readFile, writeFile, applyDiff, grepFile, listProjectTree, copyAsset, measureFigures, compileProject
 */

import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { buildVenueSkillFromState } from '../skills/index.js';
import { createGeneratorTools } from '../tools/index.js';
import { NeuripsPhase, progressUpdate } from '../progressMeta.js';
import { bumpLiveProgress, runAgentToolCall, recordUnknownToolTrace } from '../toolTrace.js';

const MAX_TOOL_ROUNDS = 40;

/**
 * Run the Generator agent.
 *
 * Receives the migration plan and autonomously executes it through tool calls.
 */
export async function agentGenerator(state, config) {
  const iteration = state.currentIteration || 0;
  const plan = state.migrationPlan || state.transferPlan || {};
  const lp = config?.configurable?._liveProgress;

  // Build tools
  const ctx = {
    sourceReadRoot: state.sourceReadRoot || state.sourceProjectRoot,
    workspaceRoot: state.workspaceRoot || state.targetProjectRoot,
    jobId: state.jobId,
    enableSensitiveMask: !!state.enableSensitiveMask,
    sourceMaskManifest: state.sourceMaskManifest || [],
    sourceMaskedContents: state.sourceMaskedContents || {},
    targetProjectId: state.targetProjectId,
    targetMainFile: state.targetMainFile,
    engine: state.engine || 'pdflatex',
    llmConfig: state.llmConfig,
  };
  const tools = createGeneratorTools(ctx);

  // Build LLM
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });
  const llmWithTools = llm.bindTools(tools);

  // Build system prompt
  const skill = await buildVenueSkillFromState(state);

  // Build user message
  const reviewContext =
    iteration > 0 && state.reviewResult
      ? `\n\nREVIEWER FEEDBACK FROM PREVIOUS ITERATION:
${JSON.stringify(state.reviewResult, null, 2)}

Fix the issues identified by the Reviewer. Read the current state of files before making changes.`
      : '';

  const userConfirmations = state.userConfirmations || {};
  const hasConfirmations = Object.keys(userConfirmations).length > 0;

  const venue = (state.transferIntake?.venue || 'neurips').toUpperCase();
  const isMineruMode = state.transferMode === 'mineru';
  const sourceNote = isMineruMode
    ? `\nSOURCE MODE: MinerU (PDF → Markdown → LaTeX)
The source content is in Markdown format under _mineru_output/ in the target project.
Read the Markdown files and convert the content to LaTeX for the ${venue} template.
Images from the PDF are also in _mineru_output/ — use copyAsset to move them to the project root if needed.\n`
    : '';
  const userMessage = `You are the GENERATOR. Execute the migration plan by reading source files and writing/patching the target ${venue} project.
${sourceNote}
MIGRATION PLAN:
${JSON.stringify(plan, null, 2)}

${hasConfirmations ? `USER CONFIRMATIONS:\n${JSON.stringify(userConfirmations, null, 2)}\n` : ''}

Source main file: "${state.sourceMainFile}"
Target main file: "${state.targetMainFile}"
${reviewContext}

EXECUTION INSTRUCTIONS:
1. First, use listProjectTree("source") and listProjectTree("target") to see what's available
2. Use readFile to read both source and target main .tex files
3. Execute the migration following the CRITICAL CONSTRAINTS in your system prompt. General order:
   a. PREAMBLE: Read source preamble → generate venue-compliant preamble per your system prompt rules → writeFile or applyDiff
   b. BODY: Read source body → migrate content following section mapping → writeFile or applyDiff
   c. FIGURES/TABLES: Normalize figure environments per venue rules (single-column venues: figure*→figure; two-column venues: keep figure* for full-width)
   d. ASSETS: Use copyAsset to copy all referenced .bib, .bbl, images, .sty/.cls/.bst files
   e. BIBLIOGRAPHY: Align \\cite commands and bibliography mechanism per venue rules in your system prompt
   f. BLIND COMPLIANCE (if doubleBlind): Sanitize \\hypersetup{pdfauthor={}}, anonymize identifying content
   g. VENUE-SPECIFIC STRUCTURE: Follow any venue-specific structural requirements from your system prompt (e.g. checklist for NeurIPS, impact statement for ICML)
4. After each major step, re-read the file to verify your changes; use compileProject() to check the target builds (uses the user-selected engine; tool returns a short LLM summary of errors/warnings)

STRATEGY NOTES:
- For the initial full migration (iteration 0), prefer writeFile for the complete .tex rewrite
- For subsequent fix iterations, prefer applyDiff for surgical corrections
- Always use applyDiff if you're only changing a few lines
- Always readFile BEFORE writeFile or applyDiff to get the current file state

When you are done with all modifications, output:
<GENERATOR_DONE>Migration complete. Applied: [brief summary of what was done]</GENERATOR_DONE>`;

  // Run tool-calling loop
  const messages = [
    { role: 'system', content: skill },
    { role: 'user', content: userMessage },
  ];

  let summary = '';
  let toolCallCount = 0;
  const projectRoot = state.workspaceRoot || state.targetProjectRoot;
  const jobId = state.jobId;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (lp) {
      lp.activeRole = 'generator';
      lp.toolName = 'llm';
      lp.toolArgs = '';
      lp.toolRound = round;
      lp.maxToolRounds = MAX_TOOL_ROUNDS;
      bumpLiveProgress(lp);
    }
    const response = await llmWithTools.invoke(messages);
    messages.push(response);

    // Check for tool calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const toolCall of response.tool_calls) {
        const tool = tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          await recordUnknownToolTrace({
            config,
            lp,
            projectRoot,
            jobId,
            agent: 'generator',
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
        const result = await runAgentToolCall({
          config,
          lp,
          projectRoot,
          jobId,
          agent: 'generator',
          iteration,
          round,
          toolCall,
          invokeFn: () => tool.invoke(toolCall.args),
        });
        toolCallCount++;
        messages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }
      continue;
    }

    // No tool calls — check for completion signal
    const content =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : '';

    const doneMatch = content.match(
      /<GENERATOR_DONE>([\s\S]*?)<\/GENERATOR_DONE>/,
    );
    if (doneMatch) {
      summary = doneMatch[1].trim();
      break;
    }

    // If no done signal and no tool calls, it might be reasoning — let it continue
    // but ask it to either use tools or signal completion
    if (round > MAX_TOOL_ROUNDS - 5) {
      messages.push({
        role: 'user',
        content:
          'Please complete your remaining work and output <GENERATOR_DONE>summary</GENERATOR_DONE> when finished.',
      });
    }
  }

  if (!summary) {
    summary = `Generator completed after ${toolCallCount} tool calls (max rounds reached).`;
  }

  return {
    agentPhase: 'reviewing',
    ...progressUpdate(
      'agentGenerator',
      NeuripsPhase.agent_generating,
      `Iteration ${iteration}: ${summary} (${toolCallCount} tool calls).`,
    ),
  };
}
