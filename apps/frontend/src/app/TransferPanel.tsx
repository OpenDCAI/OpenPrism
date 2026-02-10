import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  transferStart,
  transferStep,
  transferSubmitImages,
  listTemplates,
  getProjectTree,
} from '../api/client';
import type {
  LLMConfig,
  TemplateMeta,
  FileItem,
} from '../api/client';

interface TransferPanelProps {
  projectId: string;
  onJobUpdate?: (job: { jobId: string; status: string; progressLog: string[]; error?: string }) => void;
}

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'] as const;

export default function TransferPanel({ projectId, onJobUpdate }: TransferPanelProps) {
  const { t } = useTranslation();

  // Source file selection
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [sourceMainFile, setSourceMainFile] = useState('');
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);

  // Target selection
  const [targetTemplateId, setTargetTemplateId] = useState('');
  const [engine, setEngine] = useState('pdflatex');
  const [layoutCheck, setLayoutCheck] = useState(false);

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

  // Dropdown open states
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);

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
  const engineRef = useRef<HTMLDivElement>(null);

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
    if (!targetTemplateId || !sourceMainFile) return;
    const targetMainFile = selectedTemplate?.mainFile || 'main.tex';
    setError('');
    setProgressLog([]);
    setRunning(true);
    setStatus('starting');

    try {
      const res = await transferStart({
        sourceProjectId: projectId,
        sourceMainFile,
        targetTemplateId,
        targetMainFile,
        engine,
        layoutCheck,
        llmConfig: buildLlmConfig(),
      });
      setJobId(res.jobId);
      setStatus('started');
      await runGraph(res.jobId);
    } catch (err: any) {
      setError(err.message || 'Failed to start transfer');
      setRunning(false);
      setStatus('error');
    }
  }, [targetTemplateId, sourceMainFile, projectId, engine, layoutCheck, selectedTemplate]);

  const runGraph = useCallback(async (jid: string) => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await transferStep(jid);
        setProgressLog(res.progressLog || []);
        setStatus(res.status);
        onJobUpdate?.({ jobId: jid, status: res.status, progressLog: res.progressLog || [], error: res.error });

        if (res.status === 'waiting_images') { setRunning(false); return; }
        if (res.status === 'success' || res.status === 'failed') { setRunning(false); return; }
        if (res.error) { setError(res.error); setRunning(false); return; }

        // Brief pause before next poll
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        setError(err.message || 'Step failed');
        setRunning(false);
        setStatus('error');
        onJobUpdate?.({ jobId: jid, status: 'error', progressLog: [], error: err.message });
        return;
      }
    }
  }, [onJobUpdate]);

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

  return (
    <div className="transfer-panel">
      {/* Source file selection */}
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

      {/* LLM Config — managed in header settings */}

      {/* Start button */}
      <button
        className="btn primary"
        style={{ width: '100%', marginBottom: 12 }}
        disabled={running || !targetTemplateId || !sourceMainFile}
        onClick={handleStart}
      >
        {running ? t('转换中...') : t('开始转换')}
      </button>

      {/* Status */}
      {status !== 'idle' && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <strong>{t('状态')}:</strong> {status}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: '#d32f2f', marginBottom: 8 }}>{error}</div>
      )}

      {/* Progress log */}
      {progressLog.length > 0 && (
        <div style={{
          fontSize: 11, fontFamily: 'monospace',
          background: 'rgba(120, 98, 83, 0.06)', borderRadius: 8,
          padding: 8, maxHeight: 300, overflowY: 'auto' as const,
        }}>
          {progressLog.map((line, i) => (
            <div key={i} style={{ marginBottom: 2 }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
