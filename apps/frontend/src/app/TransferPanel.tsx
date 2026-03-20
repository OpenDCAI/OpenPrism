import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  transferStart,
  mineruTransferStart,
  mineruTransferUploadPdf,
  listTemplates,
  listTemplateFiles,
  getProjectTree,
} from '../api/client';
import type {
  LLMConfig,
  TemplateMeta,
} from '../api/client';

interface TransferPanelJobState {
  jobId: string;
  status: string;
  progressLog: string[];
  error?: string | null;
  currentNode?: string | null;
}

interface TransferPanelProps {
  projectId: string;
  jobState?: TransferPanelJobState | null;
  onJobStart?: (job: TransferPanelJobState) => void;
}

type TransferMode = 'legacy' | 'mineru';
type MineruSource = 'project' | 'upload';

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk'] as const;
const TERMINAL_STATUS = new Set(['success', 'failed', 'error']);
const MAX_VISIBLE_LOG_LINES = 80;
const MAX_LOG_LINE_CHARS = 180;

export default function TransferPanel({ projectId, jobState, onJobStart }: TransferPanelProps) {
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
  const [targetMainFile, setTargetMainFile] = useState('');
  const [targetMainFiles, setTargetMainFiles] = useState<string[]>([]);
  const [engine, setEngine] = useState('pdflatex');

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

  const readMineruConfigFromStorage = (): { mineruApiBase: string; mineruToken: string } => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { mineruApiBase: '', mineruToken: '' };
      const p = JSON.parse(raw);
      return {
        mineruApiBase: p.mineruApiBase || '',
        mineruToken: p.mineruToken || '',
      };
    } catch { return { mineruApiBase: '', mineruToken: '' }; }
  };

  const saveMineruConfigToStorage = (apiBase: string, token: string) => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      const p = raw ? JSON.parse(raw) : {};
      p.mineruApiBase = apiBase;
      p.mineruToken = token;
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(p));
    } catch { /* ignore */ }
  };

  // MinerU API config — initialized from localStorage
  const [mineruApiBase, setMineruApiBase] = useState(() => readMineruConfigFromStorage().mineruApiBase);
  const [mineruToken, setMineruToken] = useState(() => readMineruConfigFromStorage().mineruToken);

  // Dropdown open states
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const [targetMainDropdownOpen, setTargetMainDropdownOpen] = useState(false);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);

  // Job state
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState<string>('idle');
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  // Template list for target selection
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  // Refs for click-outside
  const sourceRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLDivElement>(null);
  const targetMainRef = useRef<HTMLDivElement>(null);
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

  // Sync job state from parent monitor
  useEffect(() => {
    if (!jobState) return;
    if (jobId && jobState.jobId !== jobId) return;

    if (!jobId) setJobId(jobState.jobId);
    setStatus(jobState.status || 'idle');
    setProgressLog(jobState.progressLog || []);
    setError(jobState.error || '');

    if (TERMINAL_STATUS.has(jobState.status)) {
      setRunning(false);
    }
  }, [jobState, jobId]);

  const selectedTemplate = templates.find(tp => tp.id === targetTemplateId);
  const selectedTemplateName = selectedTemplate?.label || '';
  const selectedTargetMainFile = targetMainFile || selectedTemplate?.mainFile || '';

  const activeJobState = jobState && (!jobId || jobState.jobId === jobId) ? jobState : null;
  const viewStatus = activeJobState?.status || status;
  const viewLog = (activeJobState?.progressLog || progressLog).slice(-MAX_VISIBLE_LOG_LINES);
  const viewError = activeJobState?.error || error;
  const viewCurrentNode = activeJobState?.currentNode || null;
  const formatLogLine = (line: string) => {
    const text = String(line || '');
    if (text.length <= MAX_LOG_LINE_CHARS) return text;
    return `${text.slice(0, MAX_LOG_LINE_CHARS)}...`;
  };

  // Load target template tex files and pick a default target main file
  useEffect(() => {
    if (!targetTemplateId) {
      setTargetMainFiles([]);
      setTargetMainFile('');
      return;
    }

    const manifestDefault = templates.find(tp => tp.id === targetTemplateId)?.mainFile || '';
    let cancelled = false;
    listTemplateFiles(targetTemplateId)
      .then((res) => {
        if (cancelled) return;
        const files = (res.files || []).filter(f => f.toLowerCase().endsWith('.tex'));
        setTargetMainFiles(files);

        if (files.includes(manifestDefault)) {
          setTargetMainFile(manifestDefault);
          return;
        }
        if (files.length > 0) {
          setTargetMainFile(files[0]);
          return;
        }
        setTargetMainFile(manifestDefault || 'main.tex');
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = manifestDefault || 'main.tex';
        setTargetMainFiles([]);
        setTargetMainFile(fallback);
      });

    return () => { cancelled = true; };
  }, [targetTemplateId, templates]);

  // Click outside to close dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sourceRef.current && !sourceRef.current.contains(e.target as Node)) setSourceDropdownOpen(false);
      if (templateRef.current && !templateRef.current.contains(e.target as Node)) setTemplateDropdownOpen(false);
      if (targetMainRef.current && !targetMainRef.current.contains(e.target as Node)) setTargetMainDropdownOpen(false);
      if (engineRef.current && !engineRef.current.contains(e.target as Node)) setEngineDropdownOpen(false);
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

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
    if (!selectedTargetMainFile) return;
    setError('');
    setProgressLog([]);
    setRunning(true);
    setStatus('starting');

    try {
      if (transferMode === 'mineru') {
        saveMineruConfigToStorage(mineruApiBase, mineruToken);
        const mineruConfig = (mineruApiBase || mineruToken)
          ? {
            ...(mineruApiBase ? { apiBase: mineruApiBase } : {}),
            ...(mineruToken ? { token: mineruToken } : {}),
          }
          : undefined;

        const res = await mineruTransferStart({
          sourceProjectId: mineruSource === 'project' ? projectId : undefined,
          sourceMainFile: mineruSource === 'project' ? sourceMainFile : undefined,
          targetTemplateId,
          targetMainFile: selectedTargetMainFile,
          engine,
          llmConfig: buildLlmConfig(),
          mineruConfig,
        });
        setJobId(res.jobId);
        onJobStart?.({
          jobId: res.jobId,
          status: mineruSource === 'upload' ? 'waiting_upload' : 'running',
          progressLog: [],
          error: null,
          currentNode: null,
        });

        if (mineruSource === 'upload' && uploadedPdf) {
          setStatus('uploading_pdf');
          await mineruTransferUploadPdf(res.jobId, uploadedPdf);
        }

        setRunning(false);
        setStatus('running');
      } else {
        if (!sourceMainFile) return;
        const res = await transferStart({
          sourceProjectId: projectId,
          sourceMainFile,
          targetTemplateId,
          targetMainFile: selectedTargetMainFile,
          engine,
          llmConfig: buildLlmConfig(),
        });

        setJobId(res.jobId);
        setRunning(false);
        setStatus('running');
        onJobStart?.({
          jobId: res.jobId,
          status: 'running',
          progressLog: [],
          error: null,
          currentNode: null,
        });
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start transfer');
      setRunning(false);
      setStatus('error');
    }
  }, [
    transferMode,
    mineruSource,
    uploadedPdf,
    targetTemplateId,
    sourceMainFile,
    projectId,
    engine,
    selectedTargetMainFile,
    mineruApiBase,
    mineruToken,
    onJobStart,
  ]);

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
  const activeTransfer = viewStatus && !TERMINAL_STATUS.has(viewStatus) && viewStatus !== 'idle';

  const canStart = (() => {
    if (running || activeTransfer || !targetTemplateId || !selectedTargetMainFile) return false;
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
                  onClick={() => {
                    setTargetTemplateId(tmpl.id);
                    setTemplateDropdownOpen(false);
                    setTargetMainDropdownOpen(false);
                  }}
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

      {/* Target main file selection */}
      <div className="field">
        <label>{t('目标主文件')}</label>
        <div className="ios-select-wrapper" ref={targetMainRef}>
          <button
            className="ios-select-trigger"
            disabled={!targetTemplateId}
            onClick={() => setTargetMainDropdownOpen(!targetMainDropdownOpen)}
          >
            <span>{selectedTargetMainFile || 'main.tex'}</span>
            {chevronSvg(targetMainDropdownOpen)}
          </button>
          {targetMainDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {targetMainFiles.map(file => (
                <div
                  key={file}
                  className={`ios-dropdown-item ${selectedTargetMainFile === file ? 'active' : ''}`}
                  onClick={() => { setTargetMainFile(file); setTargetMainDropdownOpen(false); }}
                >
                  {file}
                  {selectedTargetMainFile === file && checkSvg}
                </div>
              ))}
              {targetMainFiles.length === 0 && (
                <div className="ios-dropdown-item" style={{ color: 'var(--muted)', pointerEvents: 'none' }}>
                  {t('未找到 .tex 文件')}
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

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        {t('排版检查 (VLM) 暂未开放；当前转换仅执行内容迁移、资源复制和编译修复。')}
      </div>

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
        </div>
      )}

      {/* Start button */}
      <button
        className="btn primary"
        style={{ width: '100%', marginBottom: 12 }}
        disabled={!canStart}
        onClick={handleStart}
      >
        {running || activeTransfer ? t('转换中...') : t('开始转换')}
      </button>

      {/* Status */}
      {viewStatus !== 'idle' && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <strong>{t('状态')}:</strong> {viewStatus}
          {viewCurrentNode && (
            <span style={{ marginLeft: 8, color: 'var(--muted)' }}>
              ({t('节点')}: {viewCurrentNode})
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {viewError && (
        <div style={{ fontSize: 12, color: '#d32f2f', marginBottom: 8 }}>{viewError}</div>
      )}

      {/* Progress log */}
      {viewLog.length > 0 && (
        <div style={{
          fontSize: 11, fontFamily: 'monospace',
          background: 'rgba(120, 98, 83, 0.06)', borderRadius: 8,
          padding: 8, maxHeight: 140, overflowY: 'auto' as const,
        }}>
          {viewLog.map((line, i) => (
            <div
              key={i}
              className="transfer-log-line"
              style={{ marginBottom: 2 }}
              title={line}
            >
              {formatLogLine(line)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
