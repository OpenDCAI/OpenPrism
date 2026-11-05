import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  transferStart,
  transferStep,
  transferSubmitImages,
  transferPdf,
  mineruTransferStart,
  mineruTransferUploadPdf,
  listTemplates,
  getProjectTree,
} from '../api/client';
import type {
  LLMConfig,
  TemplateMeta,
  FileItem,
  PageImage,
} from '../api/client';
import { Badge, Button, Icon, SegmentedControl, Select } from '@design';
import type { BadgeTone, SelectOption } from '@design';
import AiKeysForm from './AiKeysForm';
import { renderPdfPages } from './pageImages';

interface TransferPanelProps {
  projectId: string;
  onJobUpdate?: (job: { jobId: string; status: string; progressLog: string[]; error?: string; targetDeleted?: boolean }) => void;
}

type TransferMode = 'legacy' | 'mineru';
type MineruSource = 'project' | 'upload';

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk'] as const;

export default function TransferPanel({ projectId, onJobUpdate }: TransferPanelProps) {
  const { t } = useTranslation();

  // Transfer mode
  const [transferMode, setTransferMode] = useState<TransferMode>('mineru');
  const [mineruSource, setMineruSource] = useState<MineruSource>('project');
  const [uploadedPdf, setUploadedPdf] = useState<File | null>(null);

  // Source file selection
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [sourceMainFile, setSourceMainFile] = useState('');

  // Target selection
  const [targetTemplateId, setTargetTemplateId] = useState('');
  const [engine, setEngine] = useState('pdflatex');
  const [layoutCheck, setLayoutCheck] = useState(false);

  // Job state
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState<string>('idle');
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [captureNote, setCaptureNote] = useState('');
  const [running, setRunning] = useState(false);

  // Template list for target selection
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

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

  const selectedTemplate = templates.find(tp => tp.id === targetTemplateId);

  // The server holds the user's keys (AI settings): requests only say which profile to use.
  const llmConfig: Partial<LLMConfig> = { profile: 'llm' };

  const handleStart = useCallback(async () => {
    if (!targetTemplateId) return;
    const targetMainFile = selectedTemplate?.mainFile || 'main.tex';
    setError('');
    setWarning('');
    setCaptureNote('');
    setProgressLog([]);
    setRunning(true);
    setStatus('starting');

    try {
      if (transferMode === 'mineru') {
        // MinerU mode: the token (and its API base) are the user's saved MinerU key, held by the server
        const res = await mineruTransferStart({
          sourceProjectId: mineruSource === 'project' ? projectId : undefined,
          sourceMainFile: mineruSource === 'project' ? sourceMainFile : undefined,
          targetTemplateId,
          targetMainFile,
          engine,
          layoutCheck,
          llmConfig,
        });
        setJobId(res.jobId);

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
          llmConfig,
        });
        setJobId(res.jobId);
        setStatus('started');
        await runGraph(res.jobId);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start transfer');
      setRunning(false);
      setStatus('error');
    }
  }, [transferMode, mineruSource, uploadedPdf, targetTemplateId, sourceMainFile, projectId, engine, layoutCheck, selectedTemplate]);

  const runGraph = useCallback(async (jid: string) => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await transferStep(jid);
        setProgressLog(res.progressLog || []);
        setStatus(res.status);
        onJobUpdate?.({ jobId: jid, status: res.status, progressLog: res.progressLog || [], error: res.error, targetDeleted: res.targetDeleted });

        if (res.status === 'waiting_images') {
          // The server paused to look at the compiled PDF: render its pages here and send them back.
          let images: PageImage[] = [];
          try {
            setCaptureNote(t('Preparing page screenshots for the layout check…'));
            images = await renderPdfPages(await transferPdf(jid), {
              onProgress: (page, total) => setCaptureNote(t('Capturing page {{page}} of {{total}}…', { page, total })),
            });
          } catch (err: any) {
            // An empty list tells the server to skip the layout check rather than wait forever.
            setWarning(t('Could not capture page screenshots, so the layout check was skipped: {{message}}', { message: err.message || String(err) }));
          }
          setCaptureNote(t('Sending page screenshots…'));
          try { await transferSubmitImages(jid, images); } finally { setCaptureNote(''); }
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        if (res.status === 'failed') {
          setError([res.error || t('The transfer failed.'), res.targetDeleted ? t('The unfinished project was removed.') : ''].filter(Boolean).join(' '));
          setRunning(false);
          return;
        }
        if (res.status === 'success') { setRunning(false); return; }
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
  }, [onJobUpdate, t]);

  const canStart = (() => {
    if (running || !targetTemplateId) return false;
    if (transferMode === 'legacy') return !!sourceMainFile;
    if (transferMode === 'mineru') {
      if (mineruSource === 'project') return !!sourceMainFile;
      if (mineruSource === 'upload') return !!uploadedPdf;
    }
    return false;
  })();

  const modeOptions: SelectOption<TransferMode>[] = [
    { value: 'mineru', label: 'MinerU (PDF→MD→LaTeX)' },
    { value: 'legacy', label: t('经典模式 (LaTeX→LaTeX)') },
  ];
  const sourceOptions: SelectOption[] = sourceFiles.map(f => ({ value: f, label: f }));
  const templateOptions: SelectOption[] = templates.map(tmpl => ({ value: tmpl.id, label: tmpl.label }));
  const engineOptions: SelectOption[] = ENGINES.map(eng => ({ value: eng, label: eng }));

  const statusTone: BadgeTone =
    status === 'success' ? 'success'
      : status === 'failed' || status === 'error' ? 'danger'
        : status === 'waiting_images' ? 'warning'
          : 'info';

  return (
    <div className="tp">
      {/* Transfer mode selection */}
      <div className="op-field">
        <label className="op-field-label" htmlFor="tp-mode">{t('转换模式')}</label>
        <Select<TransferMode> id="tp-mode" value={transferMode} options={modeOptions} onChange={setTransferMode} />
      </div>

      {/* MinerU mode: source selection (project or upload) */}
      {transferMode === 'mineru' && (
        <div className="op-field">
          <span className="op-field-label">{t('输入来源')}</span>
          <SegmentedControl<MineruSource>
            block
            label={t('输入来源')}
            value={mineruSource}
            onChange={setMineruSource}
            options={[
              { value: 'project', label: t('从当前项目编译'), icon: 'file-text' },
              { value: 'upload', label: t('上传 PDF'), icon: 'upload' },
            ]}
          />
        </div>
      )}

      {/* Source file selection — shown for legacy mode or MinerU project mode */}
      {(transferMode === 'legacy' || (transferMode === 'mineru' && mineruSource === 'project')) && (
        <div className="op-field">
          <label className="op-field-label" htmlFor="tp-source">{t('源文件')}</label>
          <Select
            id="tp-source"
            value={sourceMainFile}
            options={sourceOptions}
            onChange={setSourceMainFile}
            placeholder={sourceFiles.length === 0 ? t('未找到 .tex 文件') : t('选择源文件...')}
            disabled={sourceFiles.length === 0}
            icon="file-text"
          />
        </div>
      )}

      {/* PDF upload — shown for MinerU upload mode */}
      {transferMode === 'mineru' && mineruSource === 'upload' && (
        <div className="op-field">
          <label className="op-field-label" htmlFor="tp-pdf">{t('上传 PDF 文件')}</label>
          <input
            ref={pdfInputRef}
            type="file"
            accept=".pdf"
            hidden
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) setUploadedPdf(file);
            }}
          />
          <Button
            id="tp-pdf"
            className="tp-file"
            icon={uploadedPdf ? 'file' : 'upload'}
            block
            onClick={() => pdfInputRef.current?.click()}
          >
            <span>{uploadedPdf ? uploadedPdf.name : t('选择 PDF 文件...')}</span>
          </Button>
        </div>
      )}

      <div className="tp-grid">
        {/* Target template selection */}
        <div className="op-field">
          <label className="op-field-label" htmlFor="tp-template">{t('目标模板')}</label>
          <Select
            id="tp-template"
            value={targetTemplateId}
            options={templateOptions}
            onChange={setTargetTemplateId}
            placeholder={templates.length === 0 ? t('暂无可选模板') : t('选择目标模板...')}
            disabled={templates.length === 0}
          />
        </div>

        {/* Engine selection */}
        <div className="op-field">
          <label className="op-field-label" htmlFor="tp-engine">{t('编译引擎')}</label>
          <Select id="tp-engine" value={engine} options={engineOptions} onChange={setEngine} />
        </div>
      </div>

      {/* Layout check toggle */}
      <label className="home-check">
        <input type="checkbox" checked={layoutCheck} onChange={e => setLayoutCheck(e.target.checked)} />
        {t('启用排版检查 (VLM)')}
      </label>

      {/* MinerU API config — shown only in MinerU mode */}
      {transferMode === 'mineru' && (
        <AiKeysForm profiles={['mineru']} />
      )}

      {/* LLM Config — managed in header settings */}

      {/* Start button */}
      <Button
        variant="primary"
        icon="arrow-left-right"
        block
        loading={running}
        disabled={!canStart}
        onClick={handleStart}
      >
        {running ? t('转换中...') : t('开始转换')}
      </Button>

      {/* Status */}
      {status !== 'idle' && (
        <div className="tp-status" role="status">
          <span>{t('状态')}</span>
          <Badge tone={statusTone} icon={running ? 'loader' : undefined} spin={running}>{status}</Badge>
        </div>
      )}

      {captureNote && (
        <p className="tp-status" role="status"><Icon name="loader" /><span>{captureNote}</span></p>
      )}

      {warning && (
        <p className="tp-error" role="status"><Icon name="alert-circle" /><span>{warning}</span></p>
      )}

      {/* Error */}
      {error && (
        <p className="tp-error" role="alert"><Icon name="alert-circle" /><span>{error}</span></p>
      )}

      {/* Progress log */}
      {progressLog.length > 0 && (
        <div className="tp-log">
          {progressLog.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
