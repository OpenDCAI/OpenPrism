import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { buildTransferGraph } from '../services/transferAgent/graph.js';
import { buildMineruTransferGraph } from '../services/transferAgent/graphMineru.js';
import { resolveLLMConfig } from '../services/llmService.js';
import { resolveMineruConfig, MINERU_MAX_FILE_BYTES } from '../services/mineruService.js';
import { registerJobProgressSink, unregisterJobProgressSink } from '../services/transferAgent/runtimeProgress.js';
import { readTemplateManifest } from '../services/templateService.js';
import { DATA_DIR, TEMPLATE_DIR } from '../config/constants.js';
import { ensureDir, readJson, writeJson, copyDir } from '../utils/fsUtils.js';

const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_PROGRESS_LOG_LINES = 2000;
const TERMINAL_STATUSES = new Set(['success', 'failed', 'error']);
const LAYOUT_CHECK_ENABLED = false;

// In-memory job store: jobId → job record
const jobs = new Map();

function normalizeProgressLog(progressLog) {
  if (!progressLog) return [];
  const raw = Array.isArray(progressLog) ? progressLog : [progressLog];
  return raw
    .map(v => String(v || '').trim())
    .filter(Boolean);
}

function appendProgressLog(job, progressLog) {
  const lines = normalizeProgressLog(progressLog);
  if (!lines.length) return;

  for (const line of lines) {
    if (job.progressLog[job.progressLog.length - 1] !== line) {
      job.progressLog.push(line);
    }
  }

  if (job.progressLog.length > MAX_PROGRESS_LOG_LINES) {
    job.progressLog = job.progressLog.slice(-MAX_PROGRESS_LOG_LINES);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isLikelyPdfUpload(fileName, mimeType) {
  const normalizedName = String(fileName || '').trim().toLowerCase();
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  return normalizedName.endsWith('.pdf') || normalizedMime === 'application/pdf';
}

function scheduleCleanup(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TTL_MS);
}

function serializeJob(job) {
  return {
    status: job.status,
    progressLog: job.progressLog || [],
    error: job.error || null,
    currentNode: job.currentNode || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    transferMode: job.state?.transferMode || 'legacy',
  };
}

function mergeNodeChunk(job, chunk) {
  if (!chunk || typeof chunk !== 'object') return;
  const entries = Object.entries(chunk).filter(([k]) => k !== '__metadata__');
  for (const [nodeName, update] of entries) {
    job.currentNode = nodeName;
    if (update && typeof update === 'object' && !Array.isArray(update)) {
      job.state = { ...job.state, ...update };
      appendProgressLog(job, update.progressLog);
      if (update.status) job.status = update.status;
      if (update.error) job.error = String(update.error);
    } else {
      appendProgressLog(job, `[${nodeName}] ${String(update)}`);
    }
  }
}

async function executeJob(jobId, fastify) {
  const job = jobs.get(jobId);
  if (!job || job.running || job.status === 'waiting_upload') return;
  if (TERMINAL_STATUSES.has(job.status)) return;

  job.running = true;
  job.updatedAt = nowIso();
  if (!job.startedAt) job.startedAt = job.updatedAt;
  if (job.status !== 'waiting_images') {
    job.status = 'running';
  }
  if (!job.currentNode && !job.hasStarted) {
    job.currentNode = job.state?.transferMode === 'mineru' ? 'compileSource' : 'analyzeSource';
  }
  job.error = null;

  const runConfig = { configurable: { thread_id: jobId } };
  const input = job.hasStarted ? null : job.state;
  registerJobProgressSink(jobId, (progressLog) => {
    appendProgressLog(job, progressLog);
    job.updatedAt = nowIso();
  });

  try {
    const stream = await job.graph.stream(input, runConfig);
    for await (const chunk of stream) {
      mergeNodeChunk(job, chunk);
      job.updatedAt = nowIso();
    }

    job.hasStarted = true;

    try {
      if (typeof job.graph.getState === 'function') {
        const snapshot = await job.graph.getState(runConfig);
        const values = snapshot?.values;
        if (values && typeof values === 'object') {
          job.state = { ...job.state, ...values };
          const snapshotLines = normalizeProgressLog(values.progressLog);
          if (snapshotLines.length > job.progressLog.length) {
            job.progressLog = snapshotLines.slice(-MAX_PROGRESS_LOG_LINES);
          }
          if (values.status) job.status = values.status;
          if (values.error) job.error = String(values.error);
        }
      }
    } catch {
      // Ignore state snapshot read errors.
    }

    if (!job.status || job.status === 'running' || job.status === 'pending') {
      const nextStatus = job.state?.status;
      if (nextStatus) job.status = nextStatus;
    }

    if (TERMINAL_STATUSES.has(job.status)) {
      job.finishedAt = nowIso();
      scheduleCleanup(jobId);
    }
  } catch (err) {
    const msg = err?.message || String(err || 'Unknown error');
    job.status = 'error';
    job.error = msg;
    job.finishedAt = nowIso();
    appendProgressLog(job, `[job] Error: ${msg}`);
    scheduleCleanup(jobId);
    fastify.log.error({ err, jobId }, 'Transfer job execution failed');
  } finally {
    unregisterJobProgressSink(jobId);
    job.running = false;
    job.updatedAt = nowIso();
  }
}

function scheduleJobRun(jobId, fastify) {
  const job = jobs.get(jobId);
  if (!job || job.running) return;
  setImmediate(() => {
    executeJob(jobId, fastify).catch((err) => {
      fastify.log.error({ err, jobId }, 'Failed to schedule transfer job run');
    });
  });
}

export function registerTransferRoutes(fastify) {

  /**
   * POST /api/transfer/start
   * Body: { sourceProjectId, sourceMainFile, targetTemplateId, targetMainFile,
   *         engine?, layoutCheck?, llmConfig? }
   * Creates a new project from the target template, then starts the transfer.
   * Returns: { jobId, newProjectId }
   */
  fastify.post('/api/transfer/start', async (request, reply) => {
    const {
      sourceProjectId, sourceMainFile,
      targetTemplateId, targetMainFile,
      engine = 'pdflatex',
      layoutCheck = false,
      llmConfig,
    } = request.body || {};
    const effectiveLayoutCheck = LAYOUT_CHECK_ENABLED && Boolean(layoutCheck);

    if (!sourceProjectId || !sourceMainFile || !targetTemplateId || !targetMainFile) {
      return reply.code(400).send({ error: 'Missing required fields.' });
    }

    // Validate template exists
    const { templates } = await readTemplateManifest();
    const template = templates.find(t => t.id === targetTemplateId);
    if (!template) {
      return reply.code(400).send({ error: `Unknown template: ${targetTemplateId}` });
    }
    const templateRoot = path.join(TEMPLATE_DIR, targetTemplateId);
    const templateMainAbs = path.join(templateRoot, targetMainFile);
    try {
      await fs.access(templateMainAbs);
    } catch {
      return reply.code(400).send({
        error: `Template main file not found: ${targetMainFile} (template: ${targetTemplateId})`,
      });
    }

    // Create a new project from the template
    await ensureDir(DATA_DIR);
    const newProjectId = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, newProjectId);
    await ensureDir(projectRoot);

    // Read source project name for the new project name
    let sourceName = 'Untitled';
    try {
      const srcMeta = await readJson(path.join(DATA_DIR, sourceProjectId, 'project.json'));
      sourceName = srcMeta.name || 'Untitled';
    } catch { /* ignore */ }

    const meta = {
      id: newProjectId,
      name: `${sourceName} (${template.label})`,
      createdAt: new Date().toISOString(),
    };
    await writeJson(path.join(projectRoot, 'project.json'), meta);

    // Copy template files into the new project
    await copyDir(templateRoot, projectRoot);

    // Build transfer graph
    const jobId = crypto.randomUUID();
    const graph = buildTransferGraph();
    const initialProgressLog = [];
    if (layoutCheck && !effectiveLayoutCheck) {
      initialProgressLog.push('[start] Layout check is temporarily disabled. Proceeding without VLM review.');
    }

    const initialState = {
      sourceProjectId,
      sourceMainFile,
      targetProjectId: newProjectId,
      targetMainFile,
      engine,
      layoutCheck: effectiveLayoutCheck,
      llmConfig: resolveLLMConfig(llmConfig),
      transferMode: 'legacy',
      jobId,
    };

    jobs.set(jobId, {
      graph,
      state: initialState,
      status: 'pending',
      progressLog: initialProgressLog,
      hasStarted: false,
      running: false,
      error: null,
      currentNode: null,
      startedAt: null,
      updatedAt: nowIso(),
      finishedAt: null,
      cleanupTimer: null,
    });

    scheduleJobRun(jobId, fastify);
    return { jobId, newProjectId };
  });

  /**
   * POST /api/transfer/step
   * Body: { jobId }
   * Compatibility route for older clients.
   * Starts background execution if needed and returns current status.
   */
  fastify.post('/api/transfer/step', { logLevel: 'warn' }, async (request, reply) => {
    const { jobId } = request.body || {};
    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    if (!job.running
      && !TERMINAL_STATUSES.has(job.status)
      && job.status !== 'waiting_upload'
      && job.status !== 'waiting_images') {
      scheduleJobRun(jobId, fastify);
    }

    return serializeJob(job);
  });

  /**
   * POST /api/transfer/submit-images
   * Body: { jobId, images: [{ page, base64, mime }] }
   * Frontend submits PDF page screenshots for VLM layout check.
   */
  fastify.post('/api/transfer/submit-images', async (request, reply) => {
    const { jobId, images } = request.body || {};
    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    if (job.status !== 'waiting_images') {
      return reply.code(400).send({ error: 'Job is not waiting for images.' });
    }

    // Inject images into checkpointed state so background execution can resume from checkLayout.
    const updated = { pageImages: images || [], status: 'running' };
    try {
      if (job.hasStarted && typeof job.graph.updateState === 'function') {
        await job.graph.updateState(
          { configurable: { thread_id: jobId } },
          updated,
        );
      }
    } catch {
      // Fallback to in-memory state mutation if checkpoint update fails.
    }
    job.state = { ...job.state, ...updated };
    job.status = 'pending';
    job.updatedAt = nowIso();
    appendProgressLog(job, `[submit-images] Received ${Array.isArray(images) ? images.length : 0} page images, resuming transfer.`);
    scheduleJobRun(jobId, fastify);

    return { ok: true };
  });

  /**
   * GET /api/transfer/status/:jobId
   * Returns current job status and progress log.
   */
  fastify.get('/api/transfer/status/:jobId', { logLevel: 'warn' }, async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    return serializeJob(job);
  });

  /**
   * POST /api/transfer/start-mineru
   * Body: { sourceProjectId?, sourceMainFile?, targetTemplateId, targetMainFile,
   *         engine?, layoutCheck?, llmConfig?, mineruConfig? }
   * MinerU-based transfer: PDF → Markdown → LaTeX.
   * If sourceProjectId is provided, compiles source to PDF first.
   * If not, expects PDF to be uploaded via /api/transfer/upload-pdf.
   * Returns: { jobId, newProjectId }
   */
  fastify.post('/api/transfer/start-mineru', async (request, reply) => {
    const {
      sourceProjectId, sourceMainFile,
      targetTemplateId, targetMainFile,
      engine = 'pdflatex',
      layoutCheck = false,
      llmConfig,
      mineruConfig,
    } = request.body || {};
    const effectiveLayoutCheck = LAYOUT_CHECK_ENABLED && Boolean(layoutCheck);

    if (!targetTemplateId || !targetMainFile) {
      return reply.code(400).send({ error: 'Missing targetTemplateId or targetMainFile.' });
    }
    if (!!sourceProjectId !== !!sourceMainFile) {
      return reply.code(400).send({
        error: 'sourceProjectId and sourceMainFile must be provided together, or both omitted.',
      });
    }

    // Validate template
    const { templates } = await readTemplateManifest();
    const template = templates.find(t => t.id === targetTemplateId);
    if (!template) {
      return reply.code(400).send({ error: `Unknown template: ${targetTemplateId}` });
    }
    const templateRoot = path.join(TEMPLATE_DIR, targetTemplateId);
    const templateMainAbs = path.join(templateRoot, targetMainFile);
    try {
      await fs.access(templateMainAbs);
    } catch {
      return reply.code(400).send({
        error: `Template main file not found: ${targetMainFile} (template: ${targetTemplateId})`,
      });
    }

    // Create new project from template
    await ensureDir(DATA_DIR);
    const newProjectId = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, newProjectId);
    await ensureDir(projectRoot);

    let sourceName = 'Untitled';
    if (sourceProjectId) {
      try {
        const srcMeta = await readJson(path.join(DATA_DIR, sourceProjectId, 'project.json'));
        sourceName = srcMeta.name || 'Untitled';
      } catch { /* ignore */ }
    }

    const meta = {
      id: newProjectId,
      name: `${sourceName} (${template.label})`,
      createdAt: new Date().toISOString(),
    };
    await writeJson(path.join(projectRoot, 'project.json'), meta);

    await copyDir(templateRoot, projectRoot);

    // Build MinerU transfer graph
    const jobId = crypto.randomUUID();
    const graph = buildMineruTransferGraph();
    const resolvedMineruConfig = resolveMineruConfig(mineruConfig);
    if (!resolvedMineruConfig.token) {
      return reply.code(400).send({ error: 'MinerU token not configured.' });
    }
    const initialProgressLog = [];
    if (layoutCheck && !effectiveLayoutCheck) {
      initialProgressLog.push('[start-mineru] Layout check is temporarily disabled. Proceeding without VLM review.');
    }
    if (!sourceProjectId) {
      initialProgressLog.push('[start-mineru] Waiting for PDF upload before execution.');
    }

    const initialState = {
      sourceProjectId: sourceProjectId || '',
      sourceMainFile: sourceMainFile || '',
      targetProjectId: newProjectId,
      targetMainFile,
      engine,
      layoutCheck: effectiveLayoutCheck,
      llmConfig: resolveLLMConfig(llmConfig),
      mineruConfig: resolvedMineruConfig,
      transferMode: 'mineru',
      jobId,
    };

    jobs.set(jobId, {
      graph,
      state: initialState,
      status: sourceProjectId ? 'pending' : 'waiting_upload',
      progressLog: initialProgressLog,
      hasStarted: false,
      running: false,
      error: null,
      currentNode: null,
      startedAt: null,
      updatedAt: nowIso(),
      finishedAt: null,
      cleanupTimer: null,
    });

    if (sourceProjectId) {
      scheduleJobRun(jobId, fastify);
    }

    return { jobId, newProjectId };
  });

  /**
   * POST /api/transfer/upload-pdf
   * Multipart: { jobId, pdf: File }
   * Upload a PDF for MinerU-based transfer (when no source project).
   */
  fastify.post('/api/transfer/upload-pdf', async (request, reply) => {
    const parts = request.parts();
    let jobId = '';
    let pdfBuffer = null;
    let pdfFileName = '';
    let pdfMimeType = '';

    for await (const part of parts) {
      if (part.fieldname === 'jobId' && part.type === 'field') {
        jobId = part.value;
      } else if (part.fieldname === 'pdf' && part.type === 'file') {
        pdfFileName = part.filename || '';
        pdfMimeType = part.mimetype || '';
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of part.file) {
          totalBytes += chunk.length;
          if (totalBytes > MINERU_MAX_FILE_BYTES) {
            return reply.code(400).send({
              error: `PDF exceeds MinerU upload limit (${MINERU_MAX_FILE_BYTES} bytes).`,
            });
          }
          chunks.push(chunk);
        }
        pdfBuffer = Buffer.concat(chunks);
      }
    }

    if (!jobId) {
      return reply.code(400).send({ error: 'Missing jobId.' });
    }

    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }
    if (job.state?.transferMode !== 'mineru') {
      return reply.code(400).send({ error: 'Job is not a MinerU transfer job.' });
    }

    if (!pdfBuffer) {
      return reply.code(400).send({ error: 'No PDF file uploaded.' });
    }
    if (!isLikelyPdfUpload(pdfFileName, pdfMimeType)) {
      return reply.code(400).send({ error: 'Uploaded file must be a PDF.' });
    }
    if (!pdfBuffer.length) {
      return reply.code(400).send({ error: 'Uploaded PDF is empty.' });
    }

    // Save PDF to target project directory
    const pdfPath = path.join(job.state.targetProjectId
      ? path.join(DATA_DIR, job.state.targetProjectId)
      : DATA_DIR, '_uploaded_source.pdf');
    await ensureDir(path.dirname(pdfPath));
    await fs.writeFile(pdfPath, pdfBuffer);

    // Set sourcePdfPath in state so compileSource skips compilation
    job.state.sourcePdfPath = pdfPath;
    job.status = 'pending';
    job.updatedAt = nowIso();
    appendProgressLog(job, `[upload-pdf] Uploaded source PDF (${pdfBuffer.length} bytes).`);
    scheduleJobRun(jobId, fastify);

    return { ok: true, pdfPath };
  });

} // end registerTransferRoutes
