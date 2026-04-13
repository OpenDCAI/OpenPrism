import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { resolveLLMConfig, normalizeBaseURL } from '../../llmService.js';
import { extractJSON, validateSchema } from '../utils.js';
import { traceLlmInvoke, chatOpenAiTraceRawFields } from '../llmCallTrace.js';

/**
 * checkLayout node — sends page screenshots to VLM
 * for layout quality assessment.
 */
export async function checkLayout(state) {
  const { endpoint, apiKey, model } = resolveLLMConfig(state.llmConfig);
  const images = state.pageImages || [];

  if (!images.length) {
    return {
      layoutCheckResult: { ok: true, issues: [] },
      layoutAttempt: (state.layoutAttempt || 0) + 1,
      progressLog: '[checkLayout] No page images provided, skipping layout check.',
    };
  }

  const llm = new ChatOpenAI({
    modelName: model,
    openAIApiKey: apiKey,
    configuration: { baseURL: normalizeBaseURL(endpoint) },
    temperature: 0.2,
    ...chatOpenAiTraceRawFields(),
  });

  const contentParts = [
    { type: 'text', text: buildLayoutPrompt() },
  ];

  // Add each page image
  for (const img of images) {
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mime || 'image/png'};base64,${img.base64}` },
    });
  }

  const message = new HumanMessage({ content: contentParts });

  // Schema for layout check result
  const layoutSchema = {
    summary: { type: 'string', required: false },
    issues:  { type: 'array', required: true },
  };

  const MAX_RETRIES = 2;
  let result = null;
  let retries = 0;
  let messages = [message];

  const projectRoot = state.workspaceRoot || state.targetProjectRoot;
  const traceBase = projectRoot && state.jobId
    ? { projectRoot, jobId: state.jobId, node: 'checkLayout' }
    : null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const traceCtx = traceBase ? { ...traceBase, attempt } : null;
    const response = await traceLlmInvoke(traceCtx, messages, () => llm.invoke(messages));
    const raw = typeof response.content === 'string' ? response.content : '';

    const parsed = extractJSON(raw);
    if (parsed === null) {
      if (attempt < MAX_RETRIES) {
        messages = [
          message,
          { role: 'assistant', content: raw },
          { role: 'user', content:
            'Your previous response could not be parsed as valid JSON. '
            + 'Please output ONLY a valid JSON object with no extra text.' },
        ];
        retries++;
        continue;
      }
      // All retries exhausted — treat as parse failure, NOT as ok
      result = { ok: false, issues: [], parseError: true, raw };
      break;
    }

    const { valid, errors } = validateSchema(parsed, layoutSchema);
    if (!valid && attempt < MAX_RETRIES) {
      messages = [
        message,
        { role: 'assistant', content: raw },
        { role: 'user', content:
          `The JSON was parsed but has schema issues: ${errors.join('; ')}. `
          + 'Please fix and output ONLY the corrected JSON object.' },
      ];
      retries++;
      continue;
    }

    result = parsed;
    break;
  }

  if (!result) {
    result = { ok: false, issues: [], parseError: true };
  }

  const hasIssues = (result.issues || []).some(i => i.severity === 'high');

  return {
    layoutCheckResult: { ok: !hasIssues, ...result },
    layoutAttempt: (state.layoutAttempt || 0) + 1,
    progressLog: `[checkLayout] Found ${(result.issues || []).length} issues, ${hasIssues ? 'needs fix' : 'acceptable'}${retries > 0 ? ` (after ${retries} retries)` : ''}${result.parseError ? ' [JSON parse failed]' : ''}.`,
  };
}

function buildLayoutPrompt() {
  return `You are a LaTeX document layout reviewer.

Examine the PDF page screenshots and identify layout issues.

Return a JSON object:
{
  "summary": "brief overall assessment",
  "issues": [
    {
      "page": 1,
      "severity": "high|medium|low",
      "type": "overflow|overlap|spacing|alignment|missing_content",
      "description": "what is wrong",
      "suggestion": "how to fix in LaTeX"
    }
  ]
}

Focus on:
- Text overflow (content going beyond margins)
- Overlapping elements (figures/tables overlapping text)
- Missing content (blank pages, cut-off text)
- Severely broken formatting

Ignore minor aesthetic differences. Only flag issues that affect readability.
Output ONLY valid JSON.`;
}
