import { ChatOpenAI } from '@langchain/openai';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { invokeLLMForJSON } from '../utils.js';
import { loadNeuripsRulesFull, formatNeuripsHandbookBlock } from '../neuripsRules.js';
import { progressUpdate } from '../progressMeta.js';

/**
 * draftPlan node — LLM generates a structured transfer plan
 * mapping source sections to target template sections.
 */
export async function draftPlan(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
  });

  const isNeurips = state.transferGraphKind === 'neurips';
  const handbook = isNeurips
    ? formatNeuripsHandbookBlock(await loadNeuripsRulesFull())
    : '';

  const extraNeurips = isNeurips
    ? `
SOURCE_PROFILE (heuristic JSON):
${JSON.stringify(state.sourceProfile || {}, null, 2)}

TRANSFER_INTAKE:
${JSON.stringify(state.transferIntake || {}, null, 2)}
${handbook}
`
    : '';

  const neuripsStructure = isNeurips
    ? `,
  "dependencies": ["ordered strings, e.g. natbib before cite fixes"],
  "humanReview": ["items needing author judgment"],
  "preambleNotes": "short preamble migration notes",
  "bodyNotes": "short body migration notes"`
    : '';

  const prompt = `You are a LaTeX template migration planner.

Given a SOURCE paper outline and a TARGET template outline, produce a JSON migration plan.

SOURCE OUTLINE:
${JSON.stringify(state.sourceOutline, null, 2)}

TARGET OUTLINE:
${JSON.stringify(state.targetOutline, null, 2)}

SOURCE ASSETS:
${JSON.stringify(state.sourceAssets, null, 2)}

TARGET PREAMBLE (first 2000 chars):
${(state.targetPreamble || '').slice(0, 2000)}
${extraNeurips}

Produce a JSON object with this structure:
{
  "sectionMapping": [
    { "sourceSection": "...", "targetSection": "...", "action": "map|merge|create|drop" }
  ],
  "assetStrategy": {
    "bibFiles": ["copy list"],
    "images": ["copy list"],
    "bibCommand": "bibliography|addbibresource"
  },
  "notes": "any special instructions for the migration"${neuripsStructure}
}

Rules:
- Map each source section to the closest target section
- If target has no matching section, use action "create"
- If source section has no place in target, use action "drop" (rare)
- Preserve all citations, references, labels, and figure/table environments
${isNeurips ? '- Follow NeurIPS handbook above for anonymous mode, floats, bibliography, and page limits' : '- Keep the target preamble unchanged'}
- Output ONLY valid JSON, no markdown fences`;

  const planSchema = {
    sectionMapping: { type: 'array', required: true },
    assetStrategy: { type: 'object', required: true },
    notes: { type: 'string', required: false },
    dependencies: { type: 'array', required: false },
    humanReview: { type: 'array', required: false },
    preambleNotes: { type: 'string', required: false },
    bodyNotes: { type: 'string', required: false },
  };

  const { parsed, raw, retries } = await invokeLLMForJSON(
    llm,
    [{ role: 'user', content: prompt }],
    { schema: planSchema, maxRetries: 2, nodeName: 'draftPlan' },
  );

  const plan = parsed || { raw, parseError: true, sectionMapping: [], assetStrategy: {}, notes: '' };
  const retryNote = retries > 0 ? ` (after ${retries} retries)` : '';

  return {
    transferPlan: plan,
    ...progressUpdate(
      'draftPlan',
      'migration_plan',
      `Generated migration plan with ${plan.sectionMapping?.length || 0} section mappings${retryNote}.`,
    ),
  };
}
