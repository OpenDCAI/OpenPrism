import { promises as fs } from 'fs';
import path from 'path';
import { ensureDir } from '../../utils/fsUtils.js';

/**
 * Append one JSON line per LLM round-trip under:
 *   <projectRoot>/.agent_runs/<jobId>/llm_calls.jsonl
 *
 * - OPENPRISM_LLM_TRACE=0|false|no — disable
 * - OPENPRISM_LLM_TRACE=1|true|yes — force enable
 * - default: on when NODE_ENV !== 'production', off in production (set OPENPRISM_LLM_TRACE=1 to log there)
 *
 * Raw provider JSON (per round-trip) is appended under output.rawOpenAIResponse when trace is on, unless:
 * - OPENPRISM_LLM_LOG_RAW_RESPONSE=0|false|no — omit raw body (smaller llm_calls.jsonl)
 */
export function isLlmCallTraceEnabled() {
  const v = process.env.OPENPRISM_LLM_TRACE;
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return process.env.NODE_ENV !== 'production';
}

/** When true, trace rows include the full OpenAI-compatible completion object on output.rawOpenAIResponse. */
export function shouldLogRawOpenAiResponse() {
  if (!isLlmCallTraceEnabled()) return false;
  const v = process.env.OPENPRISM_LLM_LOG_RAW_RESPONSE;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

/**
 * Spread into `new ChatOpenAI({ ... })` for any LLM used with traceLlmInvoke / invokeLLMForJSON,
 * so LangChain keeps the provider payload on AIMessage.additional_kwargs.__raw_response.
 */
export function chatOpenAiTraceRawFields() {
  return shouldLogRawOpenAiResponse() ? { __includeRawResponse: true } : {};
}

function jsonSafeDeepClone(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { _nonSerializable: true, note: 'Could not JSON.stringify provider raw response' };
  }
}

function redactDataUrl(url) {
  if (typeof url !== 'string') return url;
  if (!url.startsWith('data:')) return url;
  return `[redacted data URL, ${url.length} chars]`;
}

/**
 * Normalize message content for logging (redact huge base64 image payloads).
 */
export function serializeContent(content) {
  if (content == null) return content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part == null || typeof part !== 'object') return part;
      if (part.type === 'image_url' && part.image_url && typeof part.image_url === 'object') {
        return {
          type: 'image_url',
          image_url: {
            ...part.image_url,
            url: redactDataUrl(part.image_url.url),
          },
        };
      }
      if (part.type === 'text' && typeof part.text === 'string') return part;
      return { ...part };
    });
  }
  return String(content);
}

/**
 * Serialize a LangChain message or plain OpenAI-style dict for JSONL.
 */
export function serializeLcMessage(msg) {
  if (msg == null) return null;

  if (typeof msg === 'object' && 'role' in msg && typeof msg._getType !== 'function') {
    const o = {
      role: msg.role,
      content: serializeContent(msg.content),
    };
    if (msg.tool_call_id) o.tool_call_id = msg.tool_call_id;
    if (msg.name) o.name = msg.name;
    if (msg.tool_calls) o.tool_calls = msg.tool_calls;
    return o;
  }

  let role = msg.role;
  if (!role && typeof msg._getType === 'function') {
    const t = msg._getType();
    const map = { human: 'user', ai: 'assistant', system: 'system', tool: 'tool' };
    role = map[t] || t;
  }
  const out = {
    role: role || 'unknown',
    content: serializeContent(msg.content),
  };
  const tc = msg.tool_calls?.length
    ? msg.tool_calls
    : (Array.isArray(msg.additional_kwargs?.tool_calls) && msg.additional_kwargs.tool_calls.length
      ? msg.additional_kwargs.tool_calls
      : undefined);
  if (tc) out.tool_calls = tc;
  if (msg.invalid_tool_calls?.length) out.invalid_tool_calls = msg.invalid_tool_calls;
  if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
  if (msg.name) out.name = msg.name;
  return out;
}

/**
 * OpenAI + LangChain sometimes leave parsed `tool_calls` empty but keep raw entries
 * under `additional_kwargs.tool_calls` (or only populate reasoning tokens without text).
 */
export function serializeLlmOutput(response) {
  if (response == null) return null;
  const ak = response.additional_kwargs;
  const rawFromAk = Array.isArray(ak?.tool_calls) ? ak.tool_calls : null;
  const toolCalls = response.tool_calls?.length
    ? response.tool_calls
    : rawFromAk?.length
      ? rawFromAk
      : undefined;
  const invalid = response.invalid_tool_calls?.length ? response.invalid_tool_calls : undefined;

  const rawResp = ak?.__raw_response;
  const includeRaw = shouldLogRawOpenAiResponse() && rawResp != null;
  const rawOpenAIResponse = includeRaw ? jsonSafeDeepClone(rawResp) : undefined;

  let additional_kwargs;
  if (ak && typeof ak === 'object') {
    const slice = {};
    if (ak.function_call != null) slice.function_call = ak.function_call;
    if (rawResp != null && !includeRaw) slice.__raw_response_omitted = true;
    if (Object.keys(slice).length) additional_kwargs = slice;
  }

  const content = serializeContent(response.content);
  const usageOut = response.usage_metadata?.output_tokens ?? response.response_metadata?.tokenUsage?.completionTokens;
  const looksEmpty =
    (content === '' || content == null)
    && !toolCalls?.length
    && !invalid?.length;
  const emptyHint =
    looksEmpty && usageOut > 0
      ? 'Model reported completion tokens but no visible content/tool_calls in LangChain AIMessage — common with reasoning-heavy GPT-5 outputs (see usage_metadata.output_token_details.reasoning).'
      : undefined;

  return {
    content,
    tool_calls: toolCalls?.length ? toolCalls : undefined,
    invalid_tool_calls: invalid,
    additional_kwargs,
    ...(rawOpenAIResponse !== undefined ? { rawOpenAIResponse } : {}),
    emptyHint,
    id: response.id,
    response_metadata: response.response_metadata,
    usage_metadata: response.usage_metadata,
  };
}

async function appendLlmCallJsonl(projectRoot, jobId, record) {
  if (!isLlmCallTraceEnabled() || !projectRoot || !jobId) return;
  try {
    const dir = path.join(projectRoot, '.agent_runs', jobId);
    await ensureDir(dir);
    const file = path.join(dir, 'llm_calls.jsonl');
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (e) {
    console.warn('[llmCallTrace] append failed', e?.message || e);
  }
}

/**
 * Run an LLM invoke and append input/output to llm_calls.jsonl.
 *
 * @param {object|null} traceCtx
 * @param {string} traceCtx.projectRoot
 * @param {string} traceCtx.jobId
 * @param {string} [traceCtx.node] — logical node / call site
 * @param {string} [traceCtx.agent] — planner | generator | reviewer
 * @param {number} [traceCtx.iteration]
 * @param {number} [traceCtx.round]
 * @param {number} [traceCtx.attempt] — retry attempt index
 * @param {unknown[]} messagesSnapshot — messages as passed to invoke (before call)
 * @param {() => Promise<unknown>} invokeFn
 */
export async function traceLlmInvoke(traceCtx, messagesSnapshot, invokeFn) {
  if (!traceCtx?.projectRoot || !traceCtx?.jobId || !isLlmCallTraceEnabled()) {
    return invokeFn();
  }

  const { projectRoot, jobId, ...meta } = traceCtx;
  const input = Array.isArray(messagesSnapshot)
    ? messagesSnapshot.map((m) => serializeLcMessage(m)).filter(Boolean)
    : [serializeLcMessage(messagesSnapshot)].filter(Boolean);

  const t0 = Date.now();
  try {
    const response = await invokeFn();
    await appendLlmCallJsonl(projectRoot, jobId, {
      ts: Date.now(),
      ok: true,
      durationMs: Date.now() - t0,
      input,
      output: serializeLlmOutput(response),
      ...meta,
    });
    return response;
  } catch (err) {
    await appendLlmCallJsonl(projectRoot, jobId, {
      ts: Date.now(),
      ok: false,
      durationMs: Date.now() - t0,
      input,
      error: err?.message || String(err),
      ...meta,
    });
    throw err;
  }
}
