const sinks = new Map();

export function registerJobProgressSink(jobId, sink) {
  if (!jobId || typeof sink !== 'function') return;
  sinks.set(jobId, sink);
}

export function unregisterJobProgressSink(jobId) {
  if (!jobId) return;
  sinks.delete(jobId);
}

export function pushJobProgress(jobId, progressLog) {
  const sink = sinks.get(jobId);
  if (!sink) return;
  try {
    sink(progressLog);
  } catch {
    // Ignore sink failures.
  }
}
