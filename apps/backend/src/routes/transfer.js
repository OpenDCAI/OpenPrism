import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { buildTransferGraph } from '../services/transferAgent/graph.js';
import { buildNeuripsLatexGraph } from '../services/transferAgent/graphNeurips.js';
import { buildNeuripsAgentGraph } from '../services/transferAgent/graphNeuripsAgent.js';
import { buildMineruTransferGraph } from '../services/transferAgent/graphMineru.js';
import { buildMineruAgentGraph } from '../services/transferAgent/graphMineruAgent.js';
import { resolveLLMConfig } from '../services/llmService.js';
import { resolveMineruConfig } from '../services/mineruService.js';
import { readTemplateManifest } from '../services/templateService.js';
import { DATA_DIR, TEMPLATE_DIR } from '../config/constants.js';
import { ensureDir, readJson, writeJson, copyDir } from '../utils/fsUtils.js';
import {
  transferDebugLog,
  transferDebugProgressDelta,
  transferDebugEntriesDelta,
  announceTransferDebugOnce,
} from '../services/transferAgent/transferDebugLog.js';
import { pushToolTraceRecent } from '../services/transferAgent/toolTrace.js';
import { TransferNodeError } from '../services/transferAgent/transferNodeError.js';

// In-memory job store: jobId → { graph, state, status, progressLog }
const jobs = new Map();

const INVOKE_OPTS = { recursionLimit: 120 };

function isGraphInterruptErr(e) {
  return e !== undefined && ['GraphInterrupt', 'NodeInterrupt'].includes(e?.name);
}

function logTransferStepResult(jobId, job, st) {
  if (!st || typeof st !== 'object') return;
  announceTransferDebugOnce();
  transferDebugProgressDelta(jobId, job, st.progressLog);
  transferDebugEntriesDelta(jobId, job, st.progressLogEntries);
  transferDebugLog(jobId, 'log', 'step snapshot', {
    status: st.status,
    lastCompletedNode: st.lastCompletedNode,
    currentPhase: st.currentPhase,
    transferGraphKind: st.transferGraphKind,
    completedNodesLen: Array.isArray(st.completedNodes) ? st.completedNodes.length : 0,
    pendingQA: Array.isArray(st.pendingQA) ? st.pendingQA.length : st.pendingQA ? 1 : 0,
    compileOk: st.compileResult?.ok,
    compileExit: st.compileResult?.status,
    verifyBuildOk: st.verifyBuildResult?.ok,
    verifyPattern: st.verifyBuildResult?.pattern,
    layoutCheckOk: st.layoutCheckResult?.ok,
  });
  if (st.compileResult && !st.compileResult.ok && st.compileResult.log) {
    transferDebugLog(
      jobId,
      'error',
      'compile failed — log tail',
      String(st.compileResult.log).slice(-12000),
    );
  }
  if (st.verifyBuildResult && !st.verifyBuildResult.ok) {
    transferDebugLog(jobId, 'warn', 'verifyBuild failed', st.verifyBuildResult);
    if (st.compileResult?.log) {
      transferDebugLog(
        jobId,
        'warn',
        'compile log tail (for verify debug)',
        String(st.compileResult.log).slice(-8000),
      );
    }
  }
}

function buildTransferApiPayload(job, state) {
  const st = state || job.state || {};
  const log = st.progressLog || job.progressLog || [];
  return {
    status: st.status || job.status || 'running',
    progressLog: Array.isArray(log) ? log : [],
    progressLogEntries: st.progressLogEntries || [],
    currentNode: st.lastCompletedNode || '',
    phase: st.currentPhase || '',
    agentPhase: st.agentPhase || null,
    currentIteration: st.currentIteration ?? null,
    interruptedBeforeNode: st.interruptedBeforeNode || '',
    completedNodes: st.completedNodes || [],
    pendingQA: st.pendingQA ?? null,
    error: job.error || st.error || null,
    bundleNotes: st.bundleNotes || null,
    transferGraphKind: st.transferGraphKind || job.state?.transferGraphKind || 'legacy',
    liveProgress: job.liveProgress || null,
    toolTraceRecent: job.toolTraceRecent || [],
  };
}

export function registerTransferRoutes(fastify) {
  console.log('[transfer] Routes registered — ICML agent graph support: ENABLED (v2)');

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
      venue,
      doubleBlind,
      preprint,
      outputNotes,
    } = request.body || {};

    if (!sourceProjectId || !sourceMainFile || !targetTemplateId || !targetMainFile) {
      return reply.code(400).send({ error: 'Missing required fields.' });
    }

    // Validate template exists
    const { templates } = await readTemplateManifest();
    const template = templates.find(t => t.id === targetTemplateId);
    if (!template) {
      return reply.code(400).send({ error: `Unknown template: ${targetTemplateId}` });
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
    const templateRoot = path.join(TEMPLATE_DIR, targetTemplateId);
    await copyDir(templateRoot, projectRoot);

    const jobId = crypto.randomUUID();
    const useNeuripsGraph = targetTemplateId === 'neurips';
    const useAgentGraph = useNeuripsGraph || targetTemplateId === 'icml';
    const graph = useAgentGraph ? buildNeuripsAgentGraph() : buildTransferGraph();

    const transferIntake = {
      venue: venue || targetTemplateId || 'neurips',
      doubleBlind: doubleBlind !== false,
      preprint: !!preprint,
      outputNotes: outputNotes || '',
    };

    const initialState = {
      sourceProjectId,
      sourceMainFile,
      targetProjectId: newProjectId,
      targetMainFile,
      targetTemplateId,
      engine,
      layoutCheck,
      llmConfig: resolveLLMConfig(llmConfig),
      jobId,
      transferGraphKind: useAgentGraph ? targetTemplateId : 'legacy',
      transferIntake,
      userConfirmations: {},
    };

    jobs.set(jobId, {
      graph,
      state: initialState,
      status: 'pending',
      progressLog: [],
      hasStarted: false,
      iterator: null,
      liveProgress: null,
      toolTraceRecent: [],
      _transferDebugLogLen: 0,
      _transferDebugEntriesLen: 0,
    });

    announceTransferDebugOnce();
    transferDebugLog(jobId, 'log', 'POST /transfer/start (legacy)', {
      targetTemplateId,
      transferGraphKind: useAgentGraph ? targetTemplateId : 'legacy',
      newProjectId,
      sourceProjectId,
      sourceMainFile,
      targetMainFile,
      engine,
      layoutCheck,
    });

    return { jobId, newProjectId };
  });

  /**
   * POST /api/transfer/step
   * Body: { jobId }
   * Runs the graph one step forward.
   * Returns: { status, currentNode, progressLog }
   */
  fastify.post('/api/transfer/step', async (request, reply) => {
    const { jobId } = request.body || {};
    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    if (job.status === 'waiting_images') {
      return buildTransferApiPayload(job, job.state);
    }

    if (job.status === 'waiting_confirm') {
      return buildTransferApiPayload(job, job.state);
    }

    try {
      job.status = 'running';
      // Initialize live progress for tool-level granularity
      job.liveProgress = {
        activeRole: '',
        toolName: '',
        toolArgs: '',
        toolRound: 0,
        maxToolRounds: 0,
        seq: 0,
        lastUpdate: Date.now(),
      };
      const runConfig = {
        configurable: {
          thread_id: jobId,
          _liveProgress: job.liveProgress,
          _recordToolTrace: (entry) => {
            if (!job.toolTraceRecent) job.toolTraceRecent = [];
            pushToolTraceRecent(job, entry);
          },
        },
        ...INVOKE_OPTS,
      };
      const input = job.hasStarted ? null : job.state;
      let result;
      try {
        // Use graph.stream() instead of graph.invoke() for node-level granularity.
        // streamMode 'values' yields the full accumulated state after each node completes,
        // allowing the SSE poll to pick up intermediate progress.
        const stream = await job.graph.stream(input, { ...runConfig, streamMode: 'values' });
        for await (const snapshot of stream) {
          // snapshot is the full accumulated state after this node completed
          job.state = { ...job.state, ...snapshot };
          job.progressLog = job.state.progressLog || job.progressLog || [];
          job.hasStarted = true;
          transferDebugLog(jobId, 'log', `stream node completed: ${job.state.lastCompletedNode || '?'}`);
        }
        result = job.state;
      } catch (invokeErr) {
        if (isGraphInterruptErr(invokeErr)) {
          const snap = await job.graph.getState(runConfig);
          const values = snap?.values || {};
          job.hasStarted = true;
          job.state = { ...job.state, ...values };
          job.progressLog = values.progressLog || job.progressLog || [];

          // Handle raiseQuestion interrupt from agentic nodes:
          // The interrupt() call passes { type: 'raiseQuestion', pendingQA: [...] }
          const interruptValues = snap?.tasks?.[0]?.interrupts?.[0]?.value;
          if (interruptValues?.type === 'raiseQuestion' && interruptValues.pendingQA) {
            job.state.pendingQA = interruptValues.pendingQA;
            job.state.status = 'waiting_confirm';
            job.status = 'waiting_confirm';
          } else {
            job.status = values.status || job.state.status || 'running';
          }

          job.error = undefined;
          transferDebugLog(jobId, 'log', 'LangGraph interrupt — paused before next node (checkpoint saved)');
          logTransferStepResult(jobId, job, job.state);
          return buildTransferApiPayload(job, job.state);
        }
        throw invokeErr;
      }
      // Also check for interrupt after stream completes normally (some LangGraph versions
      // don't throw on interrupt when using stream)
      try {
        const snap = await job.graph.getState(runConfig);
        const interruptValues = snap?.tasks?.[0]?.interrupts?.[0]?.value;
        if (interruptValues?.type === 'raiseQuestion' && interruptValues.pendingQA) {
          job.state.pendingQA = interruptValues.pendingQA;
          job.state.status = 'waiting_confirm';
          job.status = 'waiting_confirm';
          job.error = undefined;
          transferDebugLog(jobId, 'log', 'LangGraph interrupt detected after stream (checkpoint saved)');
          logTransferStepResult(jobId, job, job.state);
          return buildTransferApiPayload(job, job.state);
        }
      } catch { /* getState may fail if graph fully completed — that's fine */ }

      job.hasStarted = true;
      job.state = result;
      job.progressLog = result.progressLog || [];
      job.status = result.status || 'running';
      job.error = undefined;
      // Clear live progress when step finishes
      job.liveProgress = null;

      logTransferStepResult(jobId, job, result);

      return buildTransferApiPayload(job, result);
    } catch (err) {
      const msg = err?.message || String(err || 'Unknown error');
      job.status = 'error';
      job.error = msg;
      transferDebugLog(jobId, 'error', `POST /transfer/step failed: ${msg}`, err?.stack);
      const payload = {
        error: msg,
        ...buildTransferApiPayload(job, job.state),
      };
      if (err instanceof TransferNodeError) {
        payload.failedNode = err.node;
        payload.failedPhase = err.phase;
        payload.failedDetail = err.detail;
        if (err.debugRelPath) payload.failedDebugPath = err.debugRelPath;
        if (typeof err.inputChars === 'number') payload.failedInputChars = err.inputChars;
      }
      return reply.code(500).send(payload);
    }
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

    // Inject images into checkpointed state so the next /step can resume from checkLayout.
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
    job.status = 'running';

    transferDebugLog(jobId, 'log', `submit-images: ${(images || []).length} page(s)`);

    return { ok: true };
  });

  /**
   * POST /api/transfer/submit-confirm
   * Body: { jobId, answers: { [qaId]: string | string[] } }
   */
  fastify.post('/api/transfer/submit-confirm', async (request, reply) => {
    const { jobId, answers = {} } = request.body || {};
    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    if (job.status !== 'waiting_confirm') {
      return reply.code(400).send({ error: 'Job is not waiting for confirmations.' });
    }

    const prev = job.state?.userConfirmations || {};
    const merged = { ...prev, ...answers };
    const updated = { userConfirmations: merged, status: 'running', pendingQA: null };

    try {
      if (job.hasStarted && typeof job.graph.updateState === 'function') {
        await job.graph.updateState(
          { configurable: { thread_id: jobId }, ...INVOKE_OPTS },
          updated,
        );
      }
    } catch { /* fallback below */ }

    job.state = { ...job.state, ...updated };
    job.status = 'running';

    transferDebugLog(jobId, 'log', 'submit-confirm', { answerKeys: Object.keys(answers || {}) });

    return { ok: true };
  });

  /**
   * GET /api/transfer/status/:jobId
   * Returns current job status and progress log.
   */
  fastify.get('/api/transfer/status/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    return {
      transferGraphKind: job.state?.transferGraphKind || 'legacy',
      ...buildTransferApiPayload(job, job.state),
    };
  });

  /**
   * GET /api/transfer/stream/:jobId
   * SSE endpoint — pushes real-time progress events to the frontend.
   *
   * Events emitted:
   *   event: progress   — full payload (same shape as /status)
   *   event: done        — final payload when job finishes (success/failed/error)
   *
   * The connection stays open and polls the in-memory job state
   * every 500 ms, emitting an event whenever the state has changed
   * (new completedNodes, phase change, status change, new log entries).
   */
  fastify.get('/api/transfer/stream/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const job = jobs.get(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found.' });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Tracking: only send when something changed
    let lastCompletedLen = 0;
    let lastEntriesLen = 0;
    let lastStatus = '';
    let lastPhase = '';
    let lastNode = '';
    let lastLpToolName = '';
    let lastLpToolArgs = '';
    let lastLpToolRound = -1;
    let lastLpActiveRole = '';
    let lastLpSeq = -1;
    let lastToolTraceLen = -1;
    let closed = false;

    request.raw.on('close', () => { closed = true; });

    function sendEvent(eventName, data) {
      if (closed) return;
      try {
        reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { closed = true; }
    }

    // Send initial state immediately
    const initialPayload = {
      transferGraphKind: job.state?.transferGraphKind || 'legacy',
      ...buildTransferApiPayload(job, job.state),
    };
    sendEvent('progress', initialPayload);
    lastCompletedLen = (initialPayload.completedNodes || []).length;
    lastEntriesLen = (initialPayload.progressLogEntries || []).length;
    lastStatus = initialPayload.status;
    lastPhase = initialPayload.phase;
    lastNode = initialPayload.currentNode;
    if (initialPayload.liveProgress) {
      lastLpToolName = initialPayload.liveProgress.toolName || '';
      lastLpToolArgs = initialPayload.liveProgress.toolArgs || '';
      lastLpToolRound = initialPayload.liveProgress.toolRound ?? -1;
      lastLpActiveRole = initialPayload.liveProgress.activeRole || '';
      lastLpSeq = initialPayload.liveProgress.seq ?? -1;
    }
    lastToolTraceLen = (initialPayload.toolTraceRecent || []).length;

    // Poll loop
    const interval = setInterval(() => {
      if (closed) { clearInterval(interval); return; }

      const j = jobs.get(jobId);
      if (!j) { sendEvent('done', { status: 'not_found' }); clearInterval(interval); reply.raw.end(); return; }

      const payload = {
        transferGraphKind: j.state?.transferGraphKind || 'legacy',
        ...buildTransferApiPayload(j, j.state),
      };

      const completedLen = (payload.completedNodes || []).length;
      const entriesLen = (payload.progressLogEntries || []).length;
      const lp = payload.liveProgress;

      const lpSeq = lp?.seq ?? -1;
      const traceLen = (payload.toolTraceRecent || []).length;
      const changed =
        payload.status !== lastStatus ||
        payload.phase !== lastPhase ||
        payload.currentNode !== lastNode ||
        completedLen !== lastCompletedLen ||
        entriesLen !== lastEntriesLen ||
        traceLen !== lastToolTraceLen ||
        (lp && (
          lpSeq !== lastLpSeq ||
          lp.toolName !== lastLpToolName ||
          lp.toolArgs !== lastLpToolArgs ||
          lp.toolRound !== lastLpToolRound ||
          lp.activeRole !== lastLpActiveRole
        ));

      if (changed) {
        sendEvent('progress', payload);
        lastCompletedLen = completedLen;
        lastEntriesLen = entriesLen;
        lastStatus = payload.status;
        lastPhase = payload.phase;
        lastNode = payload.currentNode;
        lastToolTraceLen = traceLen;
        if (lp) {
          lastLpToolName = lp.toolName;
          lastLpToolArgs = lp.toolArgs || '';
          lastLpToolRound = lp.toolRound;
          lastLpActiveRole = lp.activeRole;
          lastLpSeq = lpSeq;
        }
      }

      // Terminal states — send done and close
      if (['success', 'failed', 'error'].includes(payload.status)) {
        sendEvent('done', payload);
        clearInterval(interval);
        if (!closed) reply.raw.end();
      }
    }, 500);

    // Keep-alive: send comment every 15s to prevent proxy timeout
    const keepAlive = setInterval(() => {
      if (closed) { clearInterval(keepAlive); return; }
      try { reply.raw.write(': keepalive\n\n'); } catch { closed = true; }
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(interval);
      clearInterval(keepAlive);
    });
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

    const templateRoot = path.join(TEMPLATE_DIR, targetTemplateId);
    await copyDir(templateRoot, projectRoot);

    // Build MinerU transfer graph — use agent hybrid for supported venues
    const jobId = crypto.randomUUID();
    const useAgentBackend = ['neurips', 'icml'].includes(targetTemplateId);
    const graph = useAgentBackend ? buildMineruAgentGraph() : buildMineruTransferGraph();

    const initialState = {
      sourceProjectId: sourceProjectId || '',
      sourceMainFile: sourceMainFile || '',
      targetProjectId: newProjectId,
      targetMainFile,
      targetTemplateId,
      engine,
      layoutCheck,
      llmConfig: resolveLLMConfig(llmConfig),
      mineruConfig: resolveMineruConfig(mineruConfig),
      transferMode: 'mineru',
      jobId,
      transferGraphKind: ['neurips', 'icml'].includes(targetTemplateId) ? targetTemplateId : 'legacy',
      transferIntake: {
        venue: targetTemplateId || 'neurips',
        doubleBlind: true,
        preprint: false,
        outputNotes: '',
      },
      userConfirmations: {},
    };

    jobs.set(jobId, {
      graph,
      state: initialState,
      status: 'pending',
      progressLog: [],
      hasStarted: false,
      iterator: null,
      liveProgress: null,
      toolTraceRecent: [],
      _transferDebugLogLen: 0,
      _transferDebugEntriesLen: 0,
    });

    announceTransferDebugOnce();
    transferDebugLog(jobId, 'log', 'POST /transfer/start-mineru', {
      targetTemplateId,
      newProjectId,
      transferGraphKind: ['neurips', 'icml'].includes(targetTemplateId) ? targetTemplateId : 'legacy',
      hasSourceProject: !!sourceProjectId,
    });

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

    for await (const part of parts) {
      if (part.fieldname === 'jobId' && part.type === 'field') {
        jobId = part.value;
      } else if (part.fieldname === 'pdf' && part.type === 'file') {
        const chunks = [];
        for await (const chunk of part.file) {
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

    // Save PDF to target project directory
    const pdfPath = path.join(job.state.targetProjectId
      ? path.join(DATA_DIR, job.state.targetProjectId)
      : DATA_DIR, '_uploaded_source.pdf');
    await ensureDir(path.dirname(pdfPath));
    await fs.writeFile(pdfPath, pdfBuffer);

    // Set sourcePdfPath in state so compileSource skips compilation
    job.state.sourcePdfPath = pdfPath;

    return { ok: true, pdfPath };
  });

} // end registerTransferRoutes
