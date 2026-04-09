/**
 * Console logging for transfer agent debugging.
 *
 * - Default ON when NODE_ENV !== 'production'
 * - OPENPRISM_TRANSFER_DEBUG=1|true|yes — force ON
 * - OPENPRISM_TRANSFER_DEBUG=0|false|no — force OFF
 */

const env = process.env.OPENPRISM_TRANSFER_DEBUG;

export function isTransferDebugEnabled() {
  if (env === '0' || env === 'false' || env === 'no') return false;
  if (env === '1' || env === 'true' || env === 'yes') return true;
  return process.env.NODE_ENV !== 'production';
}

function shortJobId(jobId) {
  if (!jobId) return '—';
  const s = String(jobId);
  return s.length > 8 ? `${s.slice(0, 8)}…` : s;
}

/**
 * @param {string} [jobId]
 * @param {'log'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {unknown} [detail]  — object/array printed on next line(s)
 */
export function transferDebugLog(jobId, level, message, detail) {
  if (!isTransferDebugEnabled()) return;
  const prefix = `[OpenPrism:transfer:${shortJobId(jobId)}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const ts = new Date().toISOString();
  fn(`${ts} ${prefix} ${message}`);
  if (detail !== undefined && detail !== null) {
    fn(detail);
  }
}

/**
 * Emit new progress lines since last call (by array length).
 */
export function transferDebugProgressDelta(jobId, job, nextLogArray) {
  if (!isTransferDebugEnabled()) return;
  const log = Array.isArray(nextLogArray) ? nextLogArray : [];
  const prevLen = job._transferDebugLogLen ?? 0;
  if (log.length <= prevLen) {
    job._transferDebugLogLen = log.length;
    return;
  }
  const added = log.slice(prevLen);
  job._transferDebugLogLen = log.length;
  transferDebugLog(jobId, 'log', `progress +${added.length} line(s):`);
  added.forEach((line) => transferDebugLog(jobId, 'log', `  | ${line}`));
}

/**
 * Structured entries (NeurIPS / progressMeta).
 */
export function transferDebugEntriesDelta(jobId, job, entries) {
  if (!isTransferDebugEnabled()) return;
  const arr = Array.isArray(entries) ? entries : [];
  const prevLen = job._transferDebugEntriesLen ?? 0;
  if (arr.length <= prevLen) {
    job._transferDebugEntriesLen = arr.length;
    return;
  }
  const added = arr.slice(prevLen);
  job._transferDebugEntriesLen = arr.length;
  transferDebugLog(jobId, 'log', `progressLogEntries +${added.length}:`, added);
}

let _announced;
export function announceTransferDebugOnce() {
  if (_announced || !isTransferDebugEnabled()) return;
  _announced = true;
  console.log(
    '[OpenPrism:transfer] 控制台调试已开启：每次 /transfer/step 会打印进度增量与状态快照；'
    + '关闭请设 OPENPRISM_TRANSFER_DEBUG=0',
  );
}
