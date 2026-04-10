import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  transferStart,
  transferStep,
  transferSubmitImages,
  transferSubmitConfirm,
  transferStream,
  transferStatus,
  mineruTransferStart,
  mineruTransferUploadPdf,
  listTemplates,
  getProjectTree,
} from '../api/client';
import type {
  LLMConfig,
  TemplateMeta,
  FileItem,
  TransferQaItem,
  TransferProgressEntry,
  TransferStepResult,
  LiveProgress,
  ToolTraceEntry,
} from '../api/client';

interface TransferPanelProps {
  projectId: string;
  onJobUpdate?: (job: {
    jobId: string;
    status: string;
    progressLog: string[];
    error?: string;
    phase?: string;
    currentNode?: string;
    completedNodes?: string[];
    pendingQA?: TransferQaItem[] | null;
    progressLogEntries?: TransferProgressEntry[];
  }) => void;
}

type TransferMode = 'legacy' | 'mineru';
type MineruSource = 'project' | 'upload';

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk'] as const;

function formatTransferStepFailure(err: unknown): string {
  const e = err as Error & {
    failedNode?: string;
    failedPhase?: string;
    failedDetail?: string;
    failedDebugPath?: string;
    failedInputChars?: number;
  };
  const msg = e?.message || String(err || 'Step failed');
  const bits: string[] = [];
  if (e.failedNode) bits.push(`节点 ${e.failedNode}`);
  if (e.failedPhase) bits.push(`阶段 ${e.failedPhase}`);
  if (e.failedDetail) bits.push(`原因 ${e.failedDetail}`);
  if (typeof e.failedInputChars === 'number') bits.push(`输入 ${e.failedInputChars} 字符`);
  if (e.failedDebugPath) bits.push(`调试文件 ${e.failedDebugPath}`);
  return bits.length ? `${msg}\n${bits.join(' · ')}` : msg;
}

/** NeurIPS 图阶段时间线（与后端 currentPhase 对齐） */
const NEURIPS_PHASE_STEPS: { id: string; label: string }[] = [
  { id: 'intake', label: '摄入' },
  { id: 'source_analysis', label: '源稿/模板分析' },
  { id: 'migration_plan', label: '迁移计划' },
  { id: 'qa_plan', label: '计划确认 QA' },
  { id: 'preamble', label: '导言' },
  { id: 'body', label: '正文' },
  { id: 'figures', label: '图表' },
  { id: 'assets', label: '资源复制' },
  { id: 'bibliography', label: '参考文献' },
  { id: 'blind_qa', label: '双盲 QA' },
  { id: 'blind', label: '匿名处理' },
  { id: 'policy', label: '政策核对' },
  { id: 'finalize', label: '完成（本地编译）' },
];

/** NeurIPS Agent 模式时间线 */
const NEURIPS_AGENT_STEPS: { id: string; label: string }[] = [
  { id: 'agent_planning', label: '🧠 规划' },
  { id: 'agent_generating', label: '⚡ 执行' },
  { id: 'agent_reviewing', label: '🔍 审查' },
  { id: 'finalize', label: '✅ 完成' },
];

export default function TransferPanel({ projectId, onJobUpdate }: TransferPanelProps) {
  const { t } = useTranslation();

  // Transfer mode
  const [transferMode, setTransferMode] = useState<TransferMode>('mineru');
  const [mineruSource, setMineruSource] = useState<MineruSource>('project');
  const [uploadedPdf, setUploadedPdf] = useState<File | null>(null);

  // Source file selection
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [sourceMainFile, setSourceMainFile] = useState('');
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);

  // Target selection
  const [targetTemplateId, setTargetTemplateId] = useState('');
  const [engine, setEngine] = useState('pdflatex');
  const [layoutCheck, setLayoutCheck] = useState(false);
  const [neuripsDoubleBlind, setNeuripsDoubleBlind] = useState(true);
  const [neuripsPreprint, setNeuripsPreprint] = useState(false);
  const [neuripsOutputNotes, setNeuripsOutputNotes] = useState('');

  // LLM config — read from shared localStorage (set via ProjectPage / EditorPage settings)
  const SETTINGS_KEY = 'openprism-settings-v1';
  const readLLMFromStorage = (): { llmEndpoint: string; llmApiKey: string; llmModel: string } => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { llmEndpoint: '', llmApiKey: '', llmModel: '' };
      const p = JSON.parse(raw);
      return { llmEndpoint: p.llmEndpoint || '', llmApiKey: p.llmApiKey || '', llmModel: p.llmModel || '' };
    } catch { return { llmEndpoint: '', llmApiKey: '', llmModel: '' }; }
  };

  const readMineruConfigFromStorage = (): { mineruApiBase: string; mineruToken: string; mineruRasterToPdf: boolean } => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { mineruApiBase: '', mineruToken: '', mineruRasterToPdf: true };
      const p = JSON.parse(raw);
      return {
        mineruApiBase: p.mineruApiBase || '',
        mineruToken: p.mineruToken || '',
        // 默认开启：与 LaTeX 中优先使用 PDF 矢量/嵌入图一致；可在界面关闭
        mineruRasterToPdf: p.mineruRasterToPdf !== false,
      };
    } catch { return { mineruApiBase: '', mineruToken: '', mineruRasterToPdf: true }; }
  };

  const saveMineruConfigToStorage = (apiBase: string, token: string, rasterToPdf?: boolean) => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      const p = raw ? JSON.parse(raw) : {};
      p.mineruApiBase = apiBase;
      p.mineruToken = token;
      if (typeof rasterToPdf === 'boolean') p.mineruRasterToPdf = rasterToPdf;
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(p));
    } catch { /* ignore */ }
  };

  // MinerU API config — initialized from localStorage
  const [mineruApiBase, setMineruApiBase] = useState(() => readMineruConfigFromStorage().mineruApiBase);
  const [mineruToken, setMineruToken] = useState(() => readMineruConfigFromStorage().mineruToken);
  const [mineruRasterToPdf, setMineruRasterToPdf] = useState(() => readMineruConfigFromStorage().mineruRasterToPdf);

  // Dropdown open states
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);

  // Job state
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState<string>('idle');
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [progressLogEntries, setProgressLogEntries] = useState<TransferProgressEntry[]>([]);
  const [currentNode, setCurrentNode] = useState('');
  const [currentPhase, setCurrentPhase] = useState('');
  const [agentPhase, setAgentPhase] = useState<string | null>(null);
  const [currentIteration, setCurrentIteration] = useState<number | null>(null);
  const [completedNodes, setCompletedNodes] = useState<string[]>([]);
  const [pendingQA, setPendingQA] = useState<TransferQaItem[] | null>(null);
  const [qaAnswers, setQaAnswers] = useState<Record<string, string | string[]>>({});
  const [qaSubmitting, setQaSubmitting] = useState(false);
  const [logFilterNode, setLogFilterNode] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [transferGraphKind, setTransferGraphKind] = useState<string>('');
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  const [toolTraceRecent, setToolTraceRecent] = useState<ToolTraceEntry[]>([]);
  const [toolTraceOpen, setToolTraceOpen] = useState(false);

  // SSE stream ref
  const sseRef = useRef<EventSource | null>(null);
  const JOB_STORAGE_KEY = 'openprism-active-job';

  // Template list for target selection
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  // Refs for click-outside
  const sourceRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  // Load source .tex files on mount
  useEffect(() => {
    getProjectTree(projectId)
      .then(res => {
        const texFiles = (res.items || [])
          .filter(f => f.type === 'file' && f.path.endsWith('.tex'))
          .map(f => f.path);
        setSourceFiles(texFiles);
        if (texFiles.length > 0) {
          const main = texFiles.find(f => f === 'main.tex' || f.endsWith('/main.tex'));
          setSourceMainFile(main || texFiles[0]);
        }
      })
      .catch(() => {});
  }, [projectId]);

  // Load templates on mount
  useEffect(() => {
    if (!templatesLoaded) {
      listTemplates()
        .then(res => {
          setTemplates(res.templates || []);
          setTemplatesLoaded(true);
        })
        .catch(() => {});
    }
  }, [templatesLoaded]);

  // Click outside to close dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sourceRef.current && !sourceRef.current.contains(e.target as Node)) setSourceDropdownOpen(false);
      if (templateRef.current && !templateRef.current.contains(e.target as Node)) setTemplateDropdownOpen(false);
      if (engineRef.current && !engineRef.current.contains(e.target as Node)) setEngineDropdownOpen(false);
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedTemplateName = templates.find(tp => tp.id === targetTemplateId)?.label || '';
  const selectedTemplate = templates.find(tp => tp.id === targetTemplateId);

  const buildLlmConfig = (): Partial<LLMConfig> | undefined => {
    const { llmEndpoint, llmApiKey, llmModel } = readLLMFromStorage();
    if (!llmEndpoint && !llmApiKey && !llmModel) return undefined;
    return {
      ...(llmEndpoint ? { endpoint: llmEndpoint } : {}),
      ...(llmApiKey ? { apiKey: llmApiKey } : {}),
      ...(llmModel ? { model: llmModel } : {}),
    };
  };

  const handleStart = useCallback(async () => {
    if (!targetTemplateId) return;
    const targetMainFile = selectedTemplate?.mainFile || 'main.tex';
    setError('');
    setProgressLog([]);
    setProgressLogEntries([]);
    setCurrentNode('');
    setCurrentPhase('');
    setCompletedNodes([]);
    setPendingQA(null);
    setQaAnswers({});
    setToolTraceRecent([]);
    setToolTraceOpen(false);
    setLiveProgress(null);
    setRunning(true);
    setStatus('starting');

    try {
      if (transferMode === 'mineru') {
        // MinerU mode — persist config to localStorage
        saveMineruConfigToStorage(mineruApiBase, mineruToken, mineruRasterToPdf);
        const mineruConfig = {
          ...(mineruApiBase ? { apiBase: mineruApiBase } : {}),
          ...(mineruToken ? { token: mineruToken } : {}),
          rasterToPdf: mineruRasterToPdf,
        };

        const res = await mineruTransferStart({
          sourceProjectId: mineruSource === 'project' ? projectId : undefined,
          sourceMainFile: mineruSource === 'project' ? sourceMainFile : undefined,
          targetTemplateId,
          targetMainFile,
          engine,
          layoutCheck,
          llmConfig: buildLlmConfig(),
          mineruConfig,
        });
        setJobId(res.jobId);
        try { sessionStorage.setItem(JOB_STORAGE_KEY, JSON.stringify({ jobId: res.jobId })); } catch { /* ignore */ }
        onJobUpdate?.({
          jobId: res.jobId,
          status: 'starting',
          progressLog: [],
          progressLogEntries: [],
          currentNode: '',
          phase: '',
          completedNodes: [],
          pendingQA: null,
        });

        // If uploading PDF, upload it before running graph
        if (mineruSource === 'upload' && uploadedPdf) {
          setStatus('uploading_pdf');
          await mineruTransferUploadPdf(res.jobId, uploadedPdf);
        }

        setStatus('started');
        await runGraph(res.jobId);
      } else {
        // Legacy mode
        if (!sourceMainFile) return;
        const res = await transferStart({
          sourceProjectId: projectId,
          sourceMainFile,
          targetTemplateId,
          targetMainFile,
          engine,
          layoutCheck,
          llmConfig: buildLlmConfig(),
          ...(targetTemplateId === 'neurips'
            ? {
              venue: 'neurips',
              doubleBlind: neuripsDoubleBlind,
              preprint: neuripsPreprint,
              outputNotes: neuripsOutputNotes,
            }
            : {}),
        });
        setJobId(res.jobId);
        try { sessionStorage.setItem(JOB_STORAGE_KEY, JSON.stringify({ jobId: res.jobId })); } catch { /* ignore */ }
        onJobUpdate?.({
          jobId: res.jobId,
          status: 'starting',
          progressLog: [],
          progressLogEntries: [],
          currentNode: '',
          phase: '',
          completedNodes: [],
          pendingQA: null,
        });
        setStatus('started');
        await runGraph(res.jobId);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start transfer');
      setRunning(false);
      setStatus('error');
    }
  }, [transferMode, mineruSource, uploadedPdf, targetTemplateId, sourceMainFile, projectId, engine, layoutCheck, selectedTemplate, mineruApiBase, mineruToken, mineruRasterToPdf, neuripsDoubleBlind, neuripsPreprint, neuripsOutputNotes, onJobUpdate]);

  const pushJobUpdate = useCallback((jid: string, res: TransferStepResult) => {
    setProgressLog(res.progressLog || []);
    setProgressLogEntries(res.progressLogEntries || []);
    setCurrentNode(res.currentNode || '');
    setCurrentPhase(res.phase || '');
    setAgentPhase(res.agentPhase ?? null);
    setCurrentIteration(res.currentIteration ?? null);
    setCompletedNodes(res.completedNodes || []);
    setPendingQA(res.pendingQA ?? null);
    setStatus(res.status);
    if (res.transferGraphKind) setTransferGraphKind(res.transferGraphKind);
    setLiveProgress(res.liveProgress ?? null);
    setToolTraceRecent(res.toolTraceRecent || []);
    onJobUpdate?.({
      jobId: jid,
      status: res.status,
      progressLog: res.progressLog || [],
      error: res.error,
      phase: res.phase,
      currentNode: res.currentNode,
      completedNodes: res.completedNodes,
      pendingQA: res.pendingQA ?? null,
      progressLogEntries: res.progressLogEntries,
    });
  }, [onJobUpdate]);

  /** Connect SSE stream for real-time progress updates */
  const connectSSE = useCallback((jid: string) => {
    // Close any existing SSE connection
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }

    const es = transferStream(
      jid,
      // onProgress
      (data) => {
        pushJobUpdate(jid, data);
        // Handle terminal-like states from SSE
        if (data.status === 'waiting_images' || data.status === 'waiting_confirm') {
          setRunning(false);
        }
      },
      // onDone
      (data) => {
        pushJobUpdate(jid, data);
        setRunning(false);
        sseRef.current = null;
        if (data.status === 'success' || data.status === 'failed') {
          try { sessionStorage.removeItem(JOB_STORAGE_KEY); } catch { /* ignore */ }
        }
      },
      // onError
      () => {
        // SSE reconnects automatically; only log
      },
    );
    sseRef.current = es;
  }, [pushJobUpdate]);

  /** Drive the graph forward step by step, with SSE providing real-time updates */
  const runGraph = useCallback(async (jid: string) => {
    // Connect SSE for real-time progress display
    connectSSE(jid);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await transferStep(jid);
        pushJobUpdate(jid, res);

        if (res.status === 'waiting_images') { setRunning(false); return; }
        if (res.status === 'waiting_confirm') {
          setRunning(false);
          return;
        }
        if (res.status === 'success' || res.status === 'failed') {
          setRunning(false);
          try { sessionStorage.removeItem(JOB_STORAGE_KEY); } catch { /* ignore */ }
          return;
        }
        if (res.error) {
          const bits: string[] = [];
          if (res.failedNode) bits.push(`节点 ${res.failedNode}`);
          if (res.failedPhase) bits.push(`阶段 ${res.failedPhase}`);
          if (res.failedDetail) bits.push(`原因 ${res.failedDetail}`);
          if (typeof res.failedInputChars === 'number') bits.push(`输入 ${res.failedInputChars} 字符`);
          if (res.failedDebugPath) bits.push(`调试文件 ${res.failedDebugPath}`);
          setError(bits.length ? `${res.error}\n${bits.join(' · ')}` : res.error);
          setRunning(false);
          return;
        }

        await new Promise(r => setTimeout(r, 400));
      } catch (err: unknown) {
        const display = formatTransferStepFailure(err);
        setError(display);
        setRunning(false);
        setStatus('error');
        onJobUpdate?.({
          jobId: jid,
          status: 'error',
          progressLog: [],
          error: display,
        });
        return;
      }
    }
  }, [onJobUpdate, pushJobUpdate, connectSSE]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    };
  }, []);

  // Recover active job from sessionStorage on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(JOB_STORAGE_KEY);
      if (!saved) return;
      const { jobId: savedJobId } = JSON.parse(saved);
      if (!savedJobId) return;

      // Try to recover state from backend
      transferStatus(savedJobId).then((res) => {
        if (!res || res.status === 'not_found') {
          sessionStorage.removeItem(JOB_STORAGE_KEY);
          return;
        }
        setJobId(savedJobId);
        pushJobUpdate(savedJobId, res);

        const isTerminal = ['success', 'failed', 'error'].includes(res.status);
        if (!isTerminal) {
          // Job still running — reconnect SSE and resume driving
          setRunning(true);
          connectSSE(savedJobId);
          // If waiting for user input, don't drive
          if (res.status !== 'waiting_images' && res.status !== 'waiting_confirm') {
            runGraph(savedJobId);
          } else {
            setRunning(false);
          }
        }
      }).catch(() => {
        sessionStorage.removeItem(JOB_STORAGE_KEY);
      });
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmitQa = useCallback(async () => {
    if (!jobId || !pendingQA?.length) return;
    setQaSubmitting(true);
    setError('');
    try {
      await transferSubmitConfirm(jobId, qaAnswers);
      setPendingQA(null);
      setRunning(true);
      setStatus('running');
      await runGraph(jobId);
    } catch (err: any) {
      setError(err.message || 'Confirm submit failed');
    } finally {
      setQaSubmitting(false);
    }
  }, [jobId, pendingQA, qaAnswers, runGraph]);

  const chevronSvg = (open: boolean) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={open ? 'rotate' : ''}>
      <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  const checkSvg = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  const modeLabel = transferMode === 'mineru' ? 'MinerU (PDF→MD→LaTeX)' : t('经典模式 (LaTeX→LaTeX)');

  const canStart = (() => {
    if (running || !targetTemplateId) return false;
    if (transferMode === 'legacy') return !!sourceMainFile;
    if (transferMode === 'mineru') {
      if (mineruSource === 'project') return !!sourceMainFile;
      if (mineruSource === 'upload') return !!uploadedPdf;
    }
    return false;
  })();

  return (
    <div className="transfer-panel">
      {/* Transfer mode selection */}
      <div className="field">
        <label>{t('转换模式')}</label>
        <div className="ios-select-wrapper" ref={modeRef}>
          <button className="ios-select-trigger" onClick={() => setModeDropdownOpen(!modeDropdownOpen)}>
            <span>{modeLabel}</span>
            {chevronSvg(modeDropdownOpen)}
          </button>
          {modeDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              <div
                className={`ios-dropdown-item ${transferMode === 'mineru' ? 'active' : ''}`}
                onClick={() => { setTransferMode('mineru'); setModeDropdownOpen(false); }}
              >
                MinerU (PDF→MD→LaTeX)
                {transferMode === 'mineru' && checkSvg}
              </div>
              <div
                className={`ios-dropdown-item ${transferMode === 'legacy' ? 'active' : ''}`}
                onClick={() => { setTransferMode('legacy'); setModeDropdownOpen(false); }}
              >
                {t('经典模式 (LaTeX→LaTeX)')}
                {transferMode === 'legacy' && checkSvg}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* MinerU mode: source selection (project or upload) */}
      {transferMode === 'mineru' && (
        <div className="field">
          <label>{t('输入来源')}</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              className={`btn ${mineruSource === 'project' ? 'primary' : ''}`}
              style={{ flex: 1, fontSize: 12 }}
              onClick={() => setMineruSource('project')}
            >
              {t('从当前项目编译')}
            </button>
            <button
              className={`btn ${mineruSource === 'upload' ? 'primary' : ''}`}
              style={{ flex: 1, fontSize: 12 }}
              onClick={() => setMineruSource('upload')}
            >
              {t('上传 PDF')}
            </button>
          </div>
        </div>
      )}

      {/* Source file selection — shown for legacy mode or MinerU project mode */}
      {(transferMode === 'legacy' || (transferMode === 'mineru' && mineruSource === 'project')) && (
        <div className="field">
          <label>{t('源文件')}</label>
          <div className="ios-select-wrapper" ref={sourceRef}>
            <button className="ios-select-trigger" onClick={() => setSourceDropdownOpen(!sourceDropdownOpen)}>
              <span>{sourceMainFile || t('选择源文件...')}</span>
              {chevronSvg(sourceDropdownOpen)}
            </button>
            {sourceDropdownOpen && (
              <div className="ios-dropdown dropdown-down">
                {sourceFiles.map(f => (
                  <div
                    key={f}
                    className={`ios-dropdown-item ${sourceMainFile === f ? 'active' : ''}`}
                    onClick={() => { setSourceMainFile(f); setSourceDropdownOpen(false); }}
                  >
                    {f}
                    {sourceMainFile === f && checkSvg}
                  </div>
                ))}
                {sourceFiles.length === 0 && (
                  <div className="ios-dropdown-item" style={{ color: 'var(--muted)', pointerEvents: 'none' }}>
                    {t('未找到 .tex 文件')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* PDF upload — shown for MinerU upload mode */}
      {transferMode === 'mineru' && mineruSource === 'upload' && (
        <div className="field">
          <label>{t('上传 PDF 文件')}</label>
          <input
            ref={pdfInputRef}
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) setUploadedPdf(file);
            }}
          />
          <button
            className="btn"
            style={{ width: '100%', fontSize: 12, marginBottom: 4 }}
            onClick={() => pdfInputRef.current?.click()}
          >
            {uploadedPdf ? uploadedPdf.name : t('选择 PDF 文件...')}
          </button>
        </div>
      )}

      {/* Target template selection */}
      <div className="field">
        <label>{t('目标模板')}</label>
        <div className="ios-select-wrapper" ref={templateRef}>
          <button className="ios-select-trigger" onClick={() => setTemplateDropdownOpen(!templateDropdownOpen)}>
            <span>{selectedTemplateName || t('选择目标模板...')}</span>
            {chevronSvg(templateDropdownOpen)}
          </button>
          {templateDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {templates.map(tmpl => (
                <div
                  key={tmpl.id}
                  className={`ios-dropdown-item ${targetTemplateId === tmpl.id ? 'active' : ''}`}
                  onClick={() => { setTargetTemplateId(tmpl.id); setTemplateDropdownOpen(false); }}
                >
                  {tmpl.label}
                  {targetTemplateId === tmpl.id && checkSvg}
                </div>
              ))}
              {templates.length === 0 && (
                <div className="ios-dropdown-item" style={{ color: 'var(--muted)', pointerEvents: 'none' }}>
                  {t('暂无可选模板')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Engine selection */}
      <div className="field">
        <label>{t('编译引擎')}</label>
        <div className="ios-select-wrapper" ref={engineRef}>
          <button className="ios-select-trigger" onClick={() => setEngineDropdownOpen(!engineDropdownOpen)}>
            <span>{engine}</span>
            {chevronSvg(engineDropdownOpen)}
          </button>
          {engineDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {ENGINES.map(eng => (
                <div
                  key={eng}
                  className={`ios-dropdown-item ${engine === eng ? 'active' : ''}`}
                  onClick={() => { setEngine(eng); setEngineDropdownOpen(false); }}
                >
                  {eng}
                  {engine === eng && checkSvg}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Layout check toggle */}
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input type="checkbox" checked={layoutCheck} onChange={e => setLayoutCheck(e.target.checked)} />
        {t('启用排版检查 (VLM)')}
      </label>

      {transferMode === 'legacy' && targetTemplateId === 'neurips' && (
        <div style={{ fontSize: 12, marginBottom: 12, padding: 10, borderRadius: 8, background: 'rgba(120, 98, 83, 0.08)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>NeurIPS 投稿选项</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <input type="checkbox" checked={neuripsDoubleBlind} onChange={e => setNeuripsDoubleBlind(e.target.checked)} />
            双盲匿名（默认）
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <input type="checkbox" checked={neuripsPreprint} onChange={e => setNeuripsPreprint(e.target.checked)} />
            预印本模式 preprint（非匿名）
          </label>
          <label style={{ display: 'block', marginBottom: 4 }}>备注（可选）</label>
          <textarea
            className="input"
            style={{ width: '100%', minHeight: 48, fontSize: 12 }}
            value={neuripsOutputNotes}
            onChange={e => setNeuripsOutputNotes(e.target.value)}
            placeholder="例如：保留某宏包、图表特殊处理…"
          />
        </div>
      )}

      {/* MinerU API config — shown only in MinerU mode */}
      {transferMode === 'mineru' && (
        <div style={{ marginBottom: 12 }}>
          <div className="field">
            <label>MinerU API</label>
            <div className="ios-select-wrapper">
              <input
                type="text"
                className="ios-select-trigger"
                placeholder="https://mineru.net/api/v4"
                value={mineruApiBase}
                onChange={e => setMineruApiBase(e.target.value)}
                style={{ paddingRight: 12 }}
              />
            </div>
          </div>
          <div className="field">
            <label>MinerU Token</label>
            <div className="ios-select-wrapper">
              <input
                type="password"
                className="ios-select-trigger"
                placeholder={t('输入 MinerU API Token...')}
                value={mineruToken}
                onChange={e => setMineruToken(e.target.value)}
                style={{ paddingRight: 12 }}
              />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={mineruRasterToPdf}
              onChange={e => {
                const v = e.target.checked;
                setMineruRasterToPdf(v);
                try {
                  const raw = window.localStorage.getItem(SETTINGS_KEY);
                  const p = raw ? JSON.parse(raw) : {};
                  p.mineruRasterToPdf = v;
                  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(p));
                } catch { /* ignore */ }
              }}
            />
            将 MinerU 栅格图转为单页 PDF（重写 Markdown 引用；推荐开启，否则 LaTeX 多为 .jpg/.png）
          </label>
        </div>
      )}

      {/* LLM Config — managed in header settings */}

      {/* Start button */}
      <button
        className="btn primary"
        style={{ width: '100%', marginBottom: 12 }}
        disabled={!canStart}
        onClick={handleStart}
      >
        {running ? t('转换中...') : t('开始转换')}
      </button>

      {/* Status */}
      {status !== 'idle' && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <strong>{t('状态')}:</strong> {status}
          {currentNode && (
            <span style={{ marginLeft: 8, color: 'var(--muted)' }}>
              节点: {currentNode}{currentPhase ? ` · 阶段: ${currentPhase}` : ''}
              {agentPhase && ` · Agent: ${agentPhase}`}
              {currentIteration != null && currentIteration > 0 && ` · 迭代 #${currentIteration}`}
            </span>
          )}
          {status === 'waiting_images' && (
            <span style={{ marginLeft: 8, color: '#b8860b' }}>（等待截图）</span>
          )}
          {status === 'waiting_confirm' && (
            <span style={{ marginLeft: 8, color: '#1565c0' }}>（等待问卷）</span>
          )}
        </div>
      )}

      {/* Live progress — tool-level granularity */}
      {running && liveProgress && liveProgress.activeRole && (
        <div style={{
          fontSize: 11, marginBottom: 8, padding: '6px 10px', borderRadius: 6,
          background: 'rgba(21, 101, 192, 0.06)', border: '1px solid rgba(21, 101, 192, 0.15)',
          fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>
            {liveProgress.activeRole === 'planner' ? '🧠 Planner'
              : liveProgress.activeRole === 'generator' ? '⚡ Generator'
              : liveProgress.activeRole === 'reviewer' ? '🔍 Reviewer'
              : liveProgress.activeRole}
          </span>
          <span style={{ color: 'var(--muted)' }}>
            {liveProgress.toolName === 'llm' ? '思考中...' : liveProgress.toolName}
          </span>
          {liveProgress.toolName !== 'llm' && liveProgress.toolArgs && (
            <span style={{
              color: 'var(--muted)',
              flex: '1 1 160px',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={liveProgress.toolArgs}
            >
              {liveProgress.toolArgs}
            </span>
          )}
          {typeof liveProgress.seq === 'number' && (
            <span style={{ color: 'var(--muted)', fontSize: 10, opacity: 0.85 }}>#{liveProgress.seq}</span>
          )}
          {liveProgress.maxToolRounds > 0 && (
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', flexShrink: 0 }}>
              round {liveProgress.toolRound + 1}/{liveProgress.maxToolRounds}
            </span>
          )}
        </div>
      )}

      {/* Agent tool trace (ring buffer from backend) */}
      {toolTraceRecent.length > 0 && (
        <div style={{ fontSize: 11, marginBottom: 10 }}>
          <button
            type="button"
            className="btn"
            style={{ padding: '4px 10px', fontSize: 11, marginBottom: toolTraceOpen ? 6 : 0 }}
            onClick={() => setToolTraceOpen(o => !o)}
          >
            {chevronSvg(toolTraceOpen)}
            <span style={{ marginLeft: 4 }}>工具调用记录</span>
            <span style={{ color: 'var(--muted)', marginLeft: 6 }}>({toolTraceRecent.length})</span>
          </button>
          {toolTraceOpen && (
            <div style={{
              maxHeight: 220,
              overflow: 'auto',
              border: '1px solid rgba(0,0,0,0.08)',
              borderRadius: 6,
              fontFamily: 'ui-monospace, monospace',
            }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                <thead>
                  <tr style={{ background: 'rgba(0,0,0,0.04)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>时间</th>
                    <th style={{ padding: 4 }}>角色</th>
                    <th style={{ padding: 4 }}>tool</th>
                    <th style={{ padding: 4 }}>参数</th>
                    <th style={{ padding: 4 }}>ms</th>
                    <th style={{ padding: 4 }}>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {[...toolTraceRecent].slice(-30).reverse().map((e, i) => (
                    <tr key={`${e.ts}-${e.tool}-${i}`} style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                      <td style={{ padding: 4, whiteSpace: 'nowrap' }}>{new Date(e.ts).toLocaleTimeString()}</td>
                      <td style={{ padding: 4 }}>{e.agent}</td>
                      <td style={{ padding: 4 }}>{e.tool}</td>
                      <td style={{ padding: 4, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.argsBrief}>{e.argsBrief}</td>
                      <td style={{ padding: 4 }}>{e.durationMs != null ? e.durationMs : '—'}</td>
                      <td style={{ padding: 4, color: e.ok ? '#2e7d32' : '#c62828' }}>{e.ok ? 'ok' : (e.error || 'fail')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* NeurIPS phase timeline */}
      {['neurips', 'icml'].includes(targetTemplateId) && status !== 'idle' && status !== 'starting' && (() => {
        // Use transferGraphKind from backend to determine mode (not agentPhase which is only set mid-run)
        const isAgentMode = transferGraphKind === 'neurips' || agentPhase != null || currentPhase?.startsWith('agent_');
        const steps = isAgentMode ? NEURIPS_AGENT_STEPS : NEURIPS_PHASE_STEPS;
        return (
          <div style={{ fontSize: 11, marginBottom: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              进度
              {isAgentMode && currentIteration != null && (
                <span style={{ fontWeight: 400, marginLeft: 8, color: 'var(--muted)' }}>
                  迭代 #{currentIteration}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {steps.map((step) => {
                const phaseIdx = steps.findIndex((s) => s.id === currentPhase);
                const stepIdx = steps.findIndex((s) => s.id === step.id);
                const past = phaseIdx >= 0 && stepIdx >= 0 && stepIdx < phaseIdx;
                const active = currentPhase === step.id;
                return (
                  <span
                    key={step.id}
                    style={{
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: active ? 'rgba(21, 101, 192, 0.15)' : past ? 'rgba(46, 125, 50, 0.12)' : 'rgba(0,0,0,0.05)',
                      border: active ? '1px solid #1565c0' : '1px solid transparent',
                      fontSize: 10,
                    }}
                  >
                    {step.label}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* QA (human in the loop) */}
      {status === 'waiting_confirm' && pendingQA && pendingQA.length > 0 && (
        <div style={{ fontSize: 12, marginBottom: 12, padding: 10, borderRadius: 8, border: '1px solid rgba(21, 101, 192, 0.35)' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>请确认</div>
          {pendingQA.map((q) => (
            <div key={q.id} style={{ marginBottom: 12 }}>
              <div style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}>{q.prompt}</div>
              {q.type === 'single' && q.options && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {q.options.map((opt) => (
                    <label key={opt} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <input
                        type="radio"
                        name={`qa-${q.id}`}
                        checked={qaAnswers[q.id] === opt}
                        onChange={() => setQaAnswers((p) => ({ ...p, [q.id]: opt }))}
                      />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
              )}
              {q.type === 'text' && (
                <textarea
                  className="input"
                  style={{ width: '100%', minHeight: 56, fontSize: 12 }}
                  value={typeof qaAnswers[q.id] === 'string' ? (qaAnswers[q.id] as string) : ''}
                  onChange={(e) => setQaAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <button
            type="button"
            className="btn primary"
            style={{ width: '100%' }}
            disabled={qaSubmitting}
            onClick={() => void handleSubmitQa()}
          >
            {qaSubmitting ? t('提交中...') : t('提交回答并继续')}
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: '#d32f2f', marginBottom: 8 }}>{error}</div>
      )}

      {/* Log filter */}
      {(progressLog.length > 0 || progressLogEntries.length > 0) && (
        <div style={{ fontSize: 11, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>日志过滤</span>
          <input
            className="input"
            style={{ flex: 1, fontSize: 11, padding: '4px 8px' }}
            placeholder="节点名前缀，如 applyPreamble"
            value={logFilterNode}
            onChange={(e) => setLogFilterNode(e.target.value)}
          />
        </div>
      )}

      {/* Progress log */}
      {(progressLog.length > 0 || progressLogEntries.length > 0) && (
        <div style={{
          fontSize: 11, fontFamily: 'monospace',
          background: 'rgba(120, 98, 83, 0.06)', borderRadius: 8,
          padding: 8, maxHeight: 300, overflowY: 'auto' as const,
        }}>
          {progressLogEntries.length > 0
            ? progressLogEntries
              .filter((e) => !logFilterNode.trim() || (e.node || '').includes(logFilterNode.trim()))
              .map((e, i) => (
                <div
                  key={i}
                  style={{
                    marginBottom: 2,
                    color: e.level === 'error' ? '#c62828' : e.level === 'warn' ? '#b8860b' : undefined,
                  }}
                >
                  {e.node ? `[${e.node}] ` : ''}{e.message || ''}
                </div>
              ))
            : progressLog
              .filter((line) => !logFilterNode.trim() || line.includes(logFilterNode.trim()))
              .map((line, i) => (
                <div key={i} style={{ marginBottom: 2 }}>{line}</div>
              ))}
        </div>
      )}
    </div>
  );
}
