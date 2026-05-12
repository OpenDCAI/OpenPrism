import { promises as fs } from 'fs';
import path from 'path';
import { ensureDir } from '../../utils/fsUtils.js';
import { briefToolArgs } from './utils.js';

export const MAX_TOOL_TRACE_RECENT = 200;

/**
 * Monotonic counter on liveProgress so SSE clients detect updates when the same tool runs twice in a row.
 */
export function bumpLiveProgress(lp) {
  if (!lp) return;
  lp.seq = (lp.seq ?? 0) + 1;
  lp.lastUpdate = Date.now();
}

function jsonlEnabled() {
  const v = process.env.OPENPRISM_TOOL_TRACE_JSONL;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

export function pushToolTraceRecent(job, entry) {
  if (!job?.toolTraceRecent) return;
  job.toolTraceRecent.push(entry);
  while (job.toolTraceRecent.length > MAX_TOOL_TRACE_RECENT) {
    job.toolTraceRecent.shift();
  }
}

async function appendToolTraceJsonl(projectRoot, jobId, record) {
  if (!jsonlEnabled() || !projectRoot || !jobId) return;
  try {
    const dir = path.join(projectRoot, '.agent_runs', jobId);
    await ensureDir(dir);
    const file = path.join(dir, 'tool_trace.jsonl');
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (e) {
    console.warn('[toolTrace] append failed', e?.message || e);
  }
}

/**
 * Execute a bound agent tool with JSONL + in-memory trace and liveProgress bumps.
 * @param {object} opts
 * @param {object} [opts.config] - LangGraph runnable config
 * @param {object} [opts.lp] - job.liveProgress
 * @param {string} [opts.projectRoot] - target workspace root (for .agent_runs)
 * @param {string} opts.jobId
 * @param {'planner'|'generator'|'reviewer'} opts.agent
 * @param {number} opts.iteration
 * @param {number} opts.round
 * @param {{ id: string, name: string, args: object }} opts.toolCall
 * @param {() => Promise<unknown>} opts.invokeFn
 */
export async function runAgentToolCall(opts) {
  const {
    config,
    lp,
    projectRoot,
    jobId,
    agent,
    iteration,
    round,
    toolCall,
    invokeFn,
  } = opts;

  const recordTool = typeof config?.configurable?._recordToolTrace === 'function'
    ? config.configurable._recordToolTrace
    : null;

  const toolName = toolCall.name;
  const argsBrief = briefToolArgs(toolName, toolCall.args);
  const t0 = Date.now();
  const activeRole = agent === 'planner' ? 'planner' : agent === 'generator' ? 'generator' : 'reviewer';

  const base = {
    ts: t0,
    agent,
    iteration,
    round,
    tool: toolName,
    argsBrief,
    toolCallId: toolCall.id,
  };

  if (lp) {
    lp.activeRole = activeRole;
    lp.toolName = toolName;
    lp.toolArgs = argsBrief;
    lp.toolRound = round;
    bumpLiveProgress(lp);
  }

  await appendToolTraceJsonl(projectRoot, jobId, { ...base, phase: 'start' });

  try {
    const result = await invokeFn();
    const durationMs = Date.now() - t0;
    const endEntry = {
      ...base,
      ts: Date.now(),
      phase: 'end',
      durationMs,
      ok: true,
    };
    await appendToolTraceJsonl(projectRoot, jobId, endEntry);
    if (recordTool) recordTool(endEntry);
    if (lp) bumpLiveProgress(lp);
    return result;
  } catch (err) {
    const durationMs = Date.now() - t0;
    const endEntry = {
      ...base,
      ts: Date.now(),
      phase: 'end',
      durationMs,
      ok: false,
      error: err?.message || String(err),
    };
    await appendToolTraceJsonl(projectRoot, jobId, endEntry);
    if (recordTool) recordTool(endEntry);
    if (lp) bumpLiveProgress(lp);
    throw err;
  }
}

/**
 * Record a failed tool resolution (unknown tool name) without invoking.
 */
export async function recordUnknownToolTrace(opts) {
  const {
    config,
    lp,
    projectRoot,
    jobId,
    agent,
    iteration,
    round,
    toolName,
  } = opts;

  const recordTool = typeof config?.configurable?._recordToolTrace === 'function'
    ? config.configurable._recordToolTrace
    : null;

  const base = {
    ts: Date.now(),
    agent,
    iteration,
    round,
    tool: toolName,
    argsBrief: '',
    phase: 'end',
    durationMs: 0,
    ok: false,
    error: 'Unknown tool',
  };

  if (lp) {
    lp.activeRole = agent === 'planner' ? 'planner' : agent === 'generator' ? 'generator' : 'reviewer';
    lp.toolName = toolName;
    lp.toolArgs = '(unknown)';
    lp.toolRound = round;
    bumpLiveProgress(lp);
  }

  await appendToolTraceJsonl(projectRoot, jobId, base);
  if (recordTool) recordTool(base);
}
