import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  createProject,
  copyProject,
  deleteProject,
  importArxivSSE,
  importZip,
  listProjects,
  listTemplates,
  renameProject,
  archiveProject,
  trashProject,
  updateProjectTags,
  permanentDeleteProject,
  uploadTemplate,
  transferStatus,
  transferStream,
} from '../api/client';
import type { ProjectMeta, TemplateMeta, TemplateCategory, TransferProgressEntry, TransferStepResult } from '../api/client';
import TransferPanel from './TransferPanel';

type ViewFilter = 'all' | 'mine' | 'archived' | 'trash';
type SortBy = 'updatedAt' | 'name' | 'createdAt';

const SETTINGS_KEY = 'openprism-settings-v1';

interface LLMSettings {
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
}

const DEFAULT_LLM: LLMSettings = {
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
};

function loadLLMSettings(): LLMSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_LLM;
    const parsed = JSON.parse(raw);
    return {
      llmEndpoint: parsed.llmEndpoint ?? DEFAULT_LLM.llmEndpoint,
      llmApiKey: parsed.llmApiKey ?? DEFAULT_LLM.llmApiKey,
      llmModel: parsed.llmModel ?? DEFAULT_LLM.llmModel,
    };
  } catch {
    return DEFAULT_LLM;
  }
}

function saveLLMSettings(s: LLMSettings) {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...prev, ...s }));
  } catch {}
}

function formatRelativeTime(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  if (diff < 60_000) return t('刚刚');
  if (diff < 3_600_000) return t('{{n}} 分钟前', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('{{n}} 小时前', { n: Math.floor(diff / 3_600_000) });
  return t('{{n}} 天前', { n: Math.floor(diff / 86_400_000) });
}

export default function ProjectPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('');

  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('updatedAt');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tagsExpanded, setTagsExpanded] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createTemplate, setCreateTemplate] = useState('');
  const [renameState, setRenameState] = useState<{ id: string; value: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [arxivInput, setArxivInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ phase: string; percent: number } | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState<LLMSettings>(loadLLMSettings);

  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  const [galleryCat, setGalleryCat] = useState('all');
  const [galleryFeatured, setGalleryFeatured] = useState(false);
  const [gallerySearch, setGallerySearch] = useState('');
  const [tagEditId, setTagEditId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [newSidebarTag, setNewSidebarTag] = useState('');
  const [addingSidebarTag, setAddingSidebarTag] = useState(false);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);

  // Transfer modal state
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSource, setTransferSource] = useState<{ id: string; name: string } | null>(null);

  // Active transfer job (persists after modal close)
  const [activeJob, setActiveJob] = useState<{
    jobId: string; status: string; progressLog: string[]; error?: string;
    sourceName?: string;
    phase?: string;
    currentNode?: string;
    completedNodes?: string[];
    pendingQA?: unknown;
    progressLogEntries?: TransferProgressEntry[];
  } | null>(null);
  /** 右侧滑出进度面板 */
  const [transferProgressDrawerOpen, setTransferProgressDrawerOpen] = useState(false);

  // SSE ref for progress streaming recovery
  const recoverySSERef = useRef<EventSource | null>(null);

  // Recover active transfer job from sessionStorage on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('openprism-active-job');
      if (!saved) return;
      const { jobId: savedJobId } = JSON.parse(saved);
      if (!savedJobId) return;

      transferStatus(savedJobId).then((res: TransferStepResult) => {
        if (!res || !res.status) {
          sessionStorage.removeItem('openprism-active-job');
          return;
        }

        // Restore the floating progress window
        setActiveJob({
          jobId: savedJobId,
          status: res.status,
          progressLog: res.progressLog || [],
          error: res.error,
          phase: res.phase,
          currentNode: res.currentNode,
          completedNodes: res.completedNodes,
          progressLogEntries: res.progressLogEntries,
        });

        const isTerminal = ['success', 'failed', 'error'].includes(res.status);
        if (!isTerminal) {
          // Job still active — connect SSE for real-time updates to the floating window
          if (recoverySSERef.current) recoverySSERef.current.close();
          recoverySSERef.current = transferStream(
            savedJobId,
            (data) => {
              setActiveJob((prev) => ({
                ...prev,
                jobId: savedJobId,
                status: data.status,
                progressLog: data.progressLog || [],
                error: data.error,
                phase: data.phase,
                currentNode: data.currentNode,
                completedNodes: data.completedNodes,
                progressLogEntries: data.progressLogEntries,
              }));
            },
            (data) => {
              setActiveJob((prev) => ({
                ...prev,
                jobId: savedJobId,
                status: data.status,
                progressLog: data.progressLog || [],
                error: data.error,
                phase: data.phase,
                currentNode: data.currentNode,
                completedNodes: data.completedNodes,
                progressLogEntries: data.progressLogEntries,
              }));
              recoverySSERef.current = null;
              if (['success', 'failed'].includes(data.status)) {
                sessionStorage.removeItem('openprism-active-job');
                loadProjects();
              }
            },
          );
        }
      }).catch(() => {
        sessionStorage.removeItem('openprism-active-job');
      });
    } catch { /* ignore */ }

    return () => {
      if (recoverySSERef.current) { recoverySSERef.current.close(); recoverySSERef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Template upload state
  const templateZipRef = useRef<HTMLInputElement | null>(null);
  const [uploadingTemplate, setUploadingTemplate] = useState(false);

  const loadProjects = useCallback(async () => {
    const res = await listProjects();
    setProjects(res.projects || []);
  }, []);

  useEffect(() => {
    loadProjects().catch((err) => setStatus(t('加载项目失败: {{error}}', { error: String(err) })));
  }, [loadProjects, t]);

  useEffect(() => {
    listTemplates()
      .then((res) => {
        setTemplates(res.templates || []);
        setCategories(res.categories || []);
        if (res.templates?.length && !createTemplate) {
          setCreateTemplate(res.templates[0].id);
        }
      })
      .catch((err) => setStatus(t('模板加载失败: {{error}}', { error: String(err) })));
  }, [createTemplate, t]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    projects.forEach((p) => (p.tags || []).forEach((tag) => s.add(tag)));
    return Array.from(s).sort();
  }, [projects]);

  const filteredProjects = useMemo(() => {
    let list = projects;
    if (viewFilter === 'archived') list = list.filter((p) => p.archived && !p.trashed);
    else if (viewFilter === 'trash') list = list.filter((p) => p.trashed);
    else if (viewFilter === 'mine') list = list.filter((p) => !p.archived && !p.trashed);
    else list = list.filter((p) => !p.trashed);
    if (activeTag) list = list.filter((p) => (p.tags || []).includes(activeTag));
    const term = filter.trim().toLowerCase();
    if (term) list = list.filter((p) => p.name.toLowerCase().includes(term));
    list = [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'createdAt') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
    });
    return list;
  }, [projects, viewFilter, activeTag, filter, sortBy]);

  const viewCounts = useMemo(() => ({
    all: projects.filter((p) => !p.trashed).length,
    mine: projects.filter((p) => !p.archived && !p.trashed).length,
    archived: projects.filter((p) => p.archived && !p.trashed).length,
    trash: projects.filter((p) => p.trashed).length,
  }), [projects]);

  const galleryTemplates = useMemo(() => {
    let list = templates;
    if (galleryCat !== 'all') list = list.filter((tpl) => tpl.category === galleryCat);
    if (galleryFeatured) list = list.filter((tpl) => tpl.featured);
    const term = gallerySearch.trim().toLowerCase();
    if (term) list = list.filter((tpl) =>
      tpl.label.toLowerCase().includes(term) ||
      (tpl.description || '').toLowerCase().includes(term) ||
      (tpl.descriptionEn || '').toLowerCase().includes(term)
    );
    return list;
  }, [templates, galleryCat, galleryFeatured, gallerySearch]);

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name) {
      setStatus(t('请输入项目名称。'));
      return;
    }
    try {
      const created = await createProject({ name, template: createTemplate || undefined });
      setCreateOpen(false);
      setCreateName('');
      await loadProjects();
      navigate(`/editor/${created.id}`);
    } catch (err) {
      setStatus(t('创建失败: {{error}}', { error: String(err) }));
    }
  };

  const handleRename = async () => {
    if (!renameState) return;
    const name = renameState.value.trim();
    if (!name) {
      setRenameState(null);
      return;
    }
    try {
      await renameProject(renameState.id, name);
      setRenameState(null);
      await loadProjects();
    } catch (err) {
      setStatus(t('重命名失败: {{error}}', { error: String(err) }));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(t('删除项目 {{name}}？此操作不可撤销。', { name }))) return;
    try {
      await deleteProject(id);
      await loadProjects();
    } catch (err) {
      setStatus(t('删除失败: {{error}}', { error: String(err) }));
    }
  };

  const handleArchive = async (id: string, archived: boolean) => {
    try {
      await archiveProject(id, archived);
      await loadProjects();
    } catch (err) {
      setStatus(t('操作失败: {{error}}', { error: String(err) }));
    }
  };

  const handleTrash = async (id: string, trashed: boolean) => {
    try {
      await trashProject(id, trashed);
      await loadProjects();
    } catch (err) {
      setStatus(t('操作失败: {{error}}', { error: String(err) }));
    }
  };

  const handlePermanentDelete = async (id: string, name: string) => {
    if (!window.confirm(t('确定永久删除项目 {{name}}？此操作不可撤销。', { name }))) return;
    try {
      await permanentDeleteProject(id);
      await loadProjects();
    } catch (err) {
      setStatus(t('删除失败: {{error}}', { error: String(err) }));
    }
  };

  const handleEmptyTrash = async () => {
    if (!window.confirm(t('确定清空回收站？所有项目将被永久删除。'))) return;
    const trashItems = projects.filter((p) => p.trashed);
    for (const p of trashItems) {
      try { await permanentDeleteProject(p.id); } catch {}
    }
    await loadProjects();
  };

  const handleAddTag = async (id: string, tag: string) => {
    const proj = projects.find((p) => p.id === id);
    if (!proj) return;
    const tags = [...new Set([...(proj.tags || []), tag])];
    try {
      await updateProjectTags(id, tags);
      await loadProjects();
    } catch (err) {
      setStatus(t('操作失败: {{error}}', { error: String(err) }));
    }
  };

  const handleRemoveTag = async (id: string, tag: string) => {
    const proj = projects.find((p) => p.id === id);
    if (!proj) return;
    const tags = (proj.tags || []).filter((t) => t !== tag);
    try {
      await updateProjectTags(id, tags);
      await loadProjects();
    } catch (err) {
      setStatus(t('操作失败: {{error}}', { error: String(err) }));
    }
  };

  const handleCreateFromTemplate = async (tplId: string) => {
    const tpl = templates.find((t) => t.id === tplId);
    const name = createName.trim() || tpl?.label || 'Untitled';
    try {
      const created = await createProject({ name, template: tplId });
      setTemplateGalleryOpen(false);
      setCreateName('');
      await loadProjects();
      navigate(`/editor/${created.id}`);
    } catch (err) {
      setStatus(t('创建失败: {{error}}', { error: String(err) }));
    }
  };

  const handleUploadTemplate = async (file: File) => {
    const baseName = file.name.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const templateId = baseName.toLowerCase();
    const templateLabel = baseName;
    setUploadingTemplate(true);
    try {
      await uploadTemplate(templateId, templateLabel, file);
      const res = await listTemplates();
      setTemplates(res.templates || []);
      setCategories(res.categories || []);
      setStatus(t('模板上传成功'));
    } catch (err) {
      setStatus(t('模板上传失败: {{error}}', { error: String(err) }));
    } finally {
      setUploadingTemplate(false);
      if (templateZipRef.current) templateZipRef.current.value = '';
    }
  };

  const handleCopy = async (id: string, originalName: string) => {
    try {
      const res = await copyProject(id, `${originalName} (Copy)`);
      if (!res.ok || !res.project) throw new Error(res.error || 'Copy failed');
      await loadProjects();
    } catch (err) {
      setStatus(t('复制失败: {{error}}', { error: String(err) }));
    }
  };

  const handleImportZip = async (file: File) => {
    setImporting(true);
    try {
      const res = await importZip({ file, projectName: file.name.replace(/\.zip$/i, '') || t('Imported Project') });
      if (!res.ok || !res.project) {
        throw new Error(res.error || t('导入失败'));
      }
      setImportOpen(false);
      await loadProjects();
      navigate(`/editor/${res.project.id}`);
    } catch (err) {
      setStatus(t('Zip 导入失败: {{error}}', { error: String(err) }));
    } finally {
      setImporting(false);
    }
  };

  const handleImportArxiv = async () => {
    if (!arxivInput.trim()) {
      setStatus(t('请输入 arXiv URL 或 ID。'));
      return;
    }
    setImporting(true);
    setImportProgress({ phase: 'download', percent: 0 });
    try {
      const res = await importArxivSSE(
        { arxivIdOrUrl: arxivInput.trim() },
        (prog) => setImportProgress(prog)
      );
      if (!res.ok || !res.project) {
        throw new Error(res.error || t('导入失败'));
      }
      setArxivInput('');
      setImportOpen(false);
      await loadProjects();
      navigate(`/editor/${res.project.id}`);
    } catch (err) {
      setStatus(t('arXiv 导入失败: {{error}}', { error: String(err) }));
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };


  const navIcons: Record<ViewFilter, React.ReactNode> = {
    all: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4.5h12M2 4.5v8a1 1 0 001 1h10a1 1 0 001-1v-8M2 4.5l1.5-2h9l1.5 2"/></svg>,
    mine: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.5L9 2z"/><path d="M9 2v3.5h3.5M6 8.5h4M6 11h2.5"/></svg>,
    archived: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2.5" width="12" height="3" rx=".5"/><path d="M3 5.5v7.5a1 1 0 001 1h8a1 1 0 001-1V5.5"/><path d="M6.5 8.5h3"/></svg>,
    trash: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5h10M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5"/><path d="M4.5 4.5l.5 8.5a1 1 0 001 1h4a1 1 0 001-1l.5-8.5"/></svg>,
  };
  const navItems: { key: ViewFilter; label: string }[] = [
    { key: 'all', label: t('所有项目') },
    { key: 'mine', label: t('我的项目') },
    { key: 'archived', label: t('已归档') },
    { key: 'trash', label: t('回收站') },
  ];

  return (
    <div className="project-shell">
      {/* ── Sidebar ── */}
      <aside className="project-sidebar">
        <div className="sidebar-brand">
          <div className="brand-title">OpenPrism</div>
          <div className="brand-sub">{t('Projects Workspace')}</div>
        </div>

        <button className="sidebar-create-btn" onClick={() => setCreateOpen(true)}>
          + {t('新建项目')}
        </button>
        <div className="sidebar-actions-row">
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setImportOpen(true)}>{t('导入项目')}</button>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setTemplateGalleryOpen(true)}>{t('模板库')}</button>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <div
              key={item.key}
              className={`sidebar-nav-item${viewFilter === item.key && !activeTag ? ' active' : ''}`}
              onClick={() => { setViewFilter(item.key); setActiveTag(null); }}
            >
              <span className="sidebar-nav-icon">{navIcons[item.key]}</span>
              <span className="sidebar-nav-label">{item.label}</span>
              <span className="sidebar-nav-count">{viewCounts[item.key]}</span>
            </div>
          ))}
        </nav>

        <div className="sidebar-tags-section">
          <div className="sidebar-tags-header" onClick={() => setTagsExpanded(!tagsExpanded)}>
            <span>{tagsExpanded ? '\u25BE' : '\u25B8'} {t('整理标签')}</span>
          </div>
          {tagsExpanded && (
            <div className="sidebar-tags-list">
              {allTags.map((tag) => (
                <div
                  key={tag}
                  className={`sidebar-tag-item${activeTag === tag ? ' active' : ''}`}
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                >
                  <span className="tag-dot" />
                  <span>{tag}</span>
                </div>
              ))}
              {addingSidebarTag ? (
                <input
                  className="sidebar-tag-input"
                  autoFocus
                  value={newSidebarTag}
                  onChange={(e) => setNewSidebarTag(e.target.value)}
                  placeholder={t('输入标签名称')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSidebarTag.trim()) {
                      setAddingSidebarTag(false);
                      setNewSidebarTag('');
                    }
                    if (e.key === 'Escape') { setAddingSidebarTag(false); setNewSidebarTag(''); }
                  }}
                  onBlur={() => { setAddingSidebarTag(false); setNewSidebarTag(''); }}
                />
              ) : (
                <div className="sidebar-new-tag-btn" onClick={() => setAddingSidebarTag(true)}>
                  + {t('新建标签')}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* ── Main Content ── */}
      <div className="project-main">
        <header className="project-main-header">
          <h1 className="project-main-title">
            {activeTag ? `${t('标签')}: ${activeTag}` : navItems.find((n) => n.key === viewFilter)?.label || t('所有项目')}
          </h1>
          <div className="project-main-header-actions">
            {viewFilter === 'trash' && viewCounts.trash > 0 && (
              <button className="btn ghost" onClick={handleEmptyTrash}>{t('清空回收站')}</button>
            )}
            <div className="ios-select-wrapper">
              <button className="ios-select-trigger" onClick={() => setLangDropdownOpen(!langDropdownOpen)}>
                <span>{i18n.language === 'en-US' ? t('English') : t('中文')}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={langDropdownOpen ? 'rotate' : ''}>
                  <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              {langDropdownOpen && (
                <div className="ios-dropdown dropdown-down">
                  {([['zh-CN', t('中文')], ['en-US', t('English')]] as [string, string][]).map(([val, label]) => (
                    <div key={val} className={`ios-dropdown-item ${i18n.language === val ? 'active' : ''}`} onClick={() => { i18n.changeLanguage(val); setLangDropdownOpen(false); }}>
                      {label}
                      {i18n.language === val && (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button className="btn ghost" onClick={() => setSettingsOpen(true)}>{t('设置')}</button>
          </div>
        </header>

        {status && <div className="status-bar"><div>{status}</div></div>}

        <div className="project-toolbar">
          <input
            className="project-search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('搜索项目...')}
          />
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={() => setSortDropdownOpen(!sortDropdownOpen)}>
              <span>{sortBy === 'updatedAt' ? t('最近修改') : sortBy === 'name' ? t('按名称') : t('创建时间')}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={sortDropdownOpen ? 'rotate' : ''}>
                <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {sortDropdownOpen && (
              <div className="ios-dropdown dropdown-down">
                {([['updatedAt', t('最近修改')], ['name', t('按名称')], ['createdAt', t('创建时间')]] as [SortBy, string][]).map(([val, label]) => (
                  <div key={val} className={`ios-dropdown-item ${sortBy === val ? 'active' : ''}`} onClick={() => { setSortBy(val); setSortDropdownOpen(false); }}>
                    {label}
                    {sortBy === val && (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Project Table ── */}
        <div className="project-table-wrapper">
          <table className="project-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    checked={filteredProjects.length > 0 && selectedIds.size === filteredProjects.length}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedIds(new Set(filteredProjects.map((p) => p.id)));
                      else setSelectedIds(new Set());
                    }}
                  />
                </th>
                <th className="col-name">{t('名称')}</th>
                <th className="col-tags">{t('标签')}</th>
                <th className="col-modified">{t('最后修改')}</th>
                <th className="col-actions">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjects.map((project) => (
                <tr key={project.id} className={`project-table-row${selectedIds.has(project.id) ? ' selected' : ''}`}>
                  <td className="col-check">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(project.id)}
                      onChange={(e) => {
                        const next = new Set(selectedIds);
                        if (e.target.checked) next.add(project.id); else next.delete(project.id);
                        setSelectedIds(next);
                      }}
                    />
                  </td>
                  <td className="col-name">
                    {renameState?.id === project.id ? (
                      <input
                        className="inline-input"
                        autoFocus
                        value={renameState.value}
                        onChange={(e) => setRenameState({ ...renameState, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleRename(); }
                          if (e.key === 'Escape') { e.preventDefault(); setRenameState(null); }
                        }}
                        onBlur={() => setRenameState(null)}
                      />
                    ) : (
                      <span className="project-name-link" onClick={() => navigate(`/editor/${project.id}`)}>
                        {project.name}
                      </span>
                    )}
                  </td>
                  <td className="col-tags">
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                      {(project.tags || []).map((tag) => (
                        <span key={tag} className="project-tag-pill" onClick={() => setActiveTag(tag)}>
                          {tag}
                          {viewFilter !== 'trash' && (
                            <span style={{ marginLeft: 4, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); handleRemoveTag(project.id, tag); }}>&times;</span>
                          )}
                        </span>
                      ))}
                      {viewFilter !== 'trash' && (
                        tagEditId === project.id ? (
                          <input
                            className="sidebar-tag-input"
                            style={{ width: 80, fontSize: 12 }}
                            autoFocus
                            value={tagInput}
                            onChange={(e) => setTagInput(e.target.value)}
                            placeholder={t('添加标签')}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && tagInput.trim()) {
                                handleAddTag(project.id, tagInput.trim());
                                setTagInput('');
                                setTagEditId(null);
                              }
                              if (e.key === 'Escape') { setTagEditId(null); setTagInput(''); }
                            }}
                            onBlur={() => { setTagEditId(null); setTagInput(''); }}
                          />
                        ) : (
                          <span
                            className="project-tag-pill"
                            style={{ cursor: 'pointer', opacity: 0.5 }}
                            onClick={() => { setTagEditId(project.id); setTagInput(''); }}
                          >+</span>
                        )
                      )}
                    </div>
                  </td>
                  <td className="col-modified">
                    {formatRelativeTime(project.updatedAt || project.createdAt, t)}
                  </td>
                  <td className="col-actions">
                    <div className="col-actions-inner">
                      {viewFilter === 'trash' ? (<>
                        <button className="btn ghost" onClick={() => handleTrash(project.id, false)}>{t('恢复')}</button>
                        <button className="btn ghost" onClick={() => handlePermanentDelete(project.id, project.name)}>{t('永久删除')}</button>
                      </>) : (<>
                        <button className="btn ghost" onClick={() => navigate(`/editor/${project.id}`)}>{t('打开')}</button>
                        <button className="btn ghost" onClick={() => setRenameState({ id: project.id, value: project.name })}>{t('重命名')}</button>
                        <button className="btn ghost" onClick={() => handleCopy(project.id, project.name)}>{t('复制')}</button>
                        <button className="btn ghost" onClick={() => { setTransferSource({ id: project.id, name: project.name }); setTransferOpen(true); }}>{t('转换')}</button>
                        {project.archived
                          ? <button className="btn ghost" onClick={() => handleArchive(project.id, false)}>{t('取消归档')}</button>
                          : <button className="btn ghost" onClick={() => handleArchive(project.id, true)}>{t('归档')}</button>
                        }
                        <button className="btn ghost" onClick={() => handleDelete(project.id, project.name)}>{t('删除')}</button>
                      </>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredProjects.length === 0 && (
            <div className="project-table-empty">{t('暂无项目。')}</div>
          )}
        </div>

        <div className="project-footer">
          {t('显示 {{shown}} / {{total}} 个项目', { shown: filteredProjects.length, total: projects.length })}
        </div>
      </div>

      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            handleImportZip(file);
          }
          if (event.target) {
            event.target.value = '';
          }
        }}
      />

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('新建项目')}</div>
              <button className="icon-btn" onClick={() => setCreateOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('项目名称')}</label>
                <input
                  className="input"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder={t('My Paper')}
                />
              </div>
              <div className="field">
                <label>{t('模板')}</label>
                <div className="ios-select-wrapper">
                  <button className="ios-select-trigger" onClick={() => setTemplateDropdownOpen(!templateDropdownOpen)}>
                    <span>{templates.find((tpl) => tpl.id === createTemplate)?.label || '—'}</span>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={templateDropdownOpen ? 'rotate' : ''}>
                      <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  {templateDropdownOpen && (
                    <div className="ios-dropdown dropdown-down">
                      {templates.map((tpl) => (
                        <div key={tpl.id} className={`ios-dropdown-item ${createTemplate === tpl.id ? 'active' : ''}`} onClick={() => { setCreateTemplate(tpl.id); setTemplateDropdownOpen(false); }}>
                          {tpl.label}
                          {createTemplate === tpl.id && (
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCreateOpen(false)}>{t('取消')}</button>
              <button className="btn" onClick={handleCreate}>{t('创建')}</button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="modal-backdrop" onClick={() => setImportOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('导入项目')}</div>
              <button className="icon-btn" onClick={() => setImportOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('上传 Zip 文件')}</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    className="btn"
                    onClick={() => zipInputRef.current?.click()}
                    disabled={importing}
                  >
                    {t('选择文件')}
                  </button>
                  {importing && <span className="muted">{t('导入中...')}</span>}
                </div>
              </div>
              <div className="field" style={{ borderTop: '1px solid var(--border, #e0e0e0)', paddingTop: '12px', marginTop: '4px' }}>
                <label>{t('arXiv 链接导入')}</label>
                <input
                  className="input"
                  value={arxivInput}
                  onChange={(event) => setArxivInput(event.target.value)}
                  placeholder={t('arXiv URL 或 ID，例如 2301.00001')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleImportArxiv();
                    }
                  }}
                />
              </div>
              {importProgress && (
                <div className="field" style={{ paddingTop: '8px' }}>
                  <label>
                    {importProgress.phase === 'download'
                      ? importProgress.percent >= 0
                        ? t('下载中... {{percent}}%', { percent: importProgress.percent })
                        : t('下载中...')
                      : t('解压中...')}
                  </label>
                  <div style={{
                    width: '100%',
                    height: '6px',
                    background: 'var(--border, #e0e0e0)',
                    borderRadius: '3px',
                    overflow: 'hidden',
                    marginTop: '4px'
                  }}>
                    <div style={{
                      width: importProgress.percent >= 0 ? `${importProgress.percent}%` : '100%',
                      height: '100%',
                      background: 'var(--accent, #4a90d9)',
                      borderRadius: '3px',
                      transition: 'width 0.3s ease',
                      animation: importProgress.percent < 0 ? 'indeterminate 1.5s infinite linear' : undefined
                    }} />
                  </div>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setImportOpen(false)}>{t('取消')}</button>
              <button className="btn" onClick={handleImportArxiv} disabled={importing || !arxivInput.trim()}>
                {t('导入 arXiv')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Template Gallery Modal ── */}
      {templateGalleryOpen && (
        <div className="modal-backdrop" onClick={() => setTemplateGalleryOpen(false)}>
          <div className="modal template-gallery-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="template-gallery-header-left">
                <button className="btn ghost" onClick={() => setTemplateGalleryOpen(false)}>{t('返回')}</button>
                <span>{t('模板库')}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  ref={templateZipRef}
                  type="file"
                  accept=".zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUploadTemplate(f);
                  }}
                />
                <button
                  className="btn ghost"
                  disabled={uploadingTemplate}
                  onClick={() => templateZipRef.current?.click()}
                >
                  {uploadingTemplate ? t('上传中...') : t('上传模板')}
                </button>
                <button className="icon-btn" onClick={() => setTemplateGalleryOpen(false)}>✕</button>
              </div>
            </div>
            <div className="modal-body">
              <div className="template-gallery-subtitle">{t('选择模板快速开始您的项目')}</div>

              <div className="template-gallery-categories">
                {[{ id: 'all', label: t('全部'), labelEn: 'All' }, ...(categories || [])].map((cat) => (
                  <button
                    key={cat.id}
                    className={`template-cat-tab${galleryCat === cat.id ? ' active' : ''}`}
                    onClick={() => setGalleryCat(cat.id)}
                  >
                    {i18n.language === 'en-US' ? cat.labelEn : cat.label}
                  </button>
                ))}
              </div>

              <div className="template-gallery-filters">
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                  <input type="checkbox" checked={galleryFeatured} onChange={(e) => setGalleryFeatured(e.target.checked)} />
                  {t('精选模板')}
                </label>
                <input
                  className="project-search"
                  value={gallerySearch}
                  onChange={(e) => setGallerySearch(e.target.value)}
                  placeholder={t('搜索模板...')}
                  style={{ maxWidth: 240 }}
                />
              </div>

              <div className="template-gallery-grid">
                {galleryTemplates.map((tpl) => (
                  <div key={tpl.id} className="template-card" onClick={() => handleCreateFromTemplate(tpl.id)}>
                    <div className="template-card-thumb">
                      {tpl.featured && <span className="template-card-badge">Featured</span>}
                    </div>
                    <div className="template-card-body">
                      <div className="template-card-title">{tpl.label}</div>
                      <div className="template-card-desc">
                        {i18n.language === 'en-US' ? (tpl.descriptionEn || tpl.description) : tpl.description}
                      </div>
                      {tpl.tags?.length > 0 && (
                        <div className="template-card-tags">
                          {tpl.tags.map((tag) => <span key={tag} className="project-tag-pill">{tag}</span>)}
                        </div>
                      )}
                      {tpl.author && <div className="template-card-author">{tpl.author}</div>}
                    </div>
                  </div>
                ))}
              </div>
              {galleryTemplates.length === 0 && (
                <div className="template-gallery-empty">{t('暂无匹配模板')}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Transfer Modal */}
      {transferOpen && transferSource && (
        <div className="modal-backdrop" onClick={() => setTransferOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('模板转换')} — {transferSource.name}</div>
              <button className="icon-btn" onClick={() => setTransferOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <TransferPanel
                projectId={transferSource.id}
                onJobUpdate={(job) => {
                  setActiveJob({ ...job, sourceName: transferSource.name });
                  if (job.status === 'success') loadProjects();
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 转换进度：悬浮按钮 + 右侧抽屉（Portal 到 body，避免被 overflow 裁剪；弹窗打开时也显示） */}
      {typeof document !== 'undefined' && activeJob && createPortal(
        <>
          <button
            type="button"
            className={`transfer-progress-fab${['running', 'starting', 'pending', 'waiting_images', 'waiting_confirm'].includes(activeJob.status) ? ' transfer-progress-fab--pulse' : ''}`}
            title={t('查看转换进度')}
            aria-expanded={transferProgressDrawerOpen}
            onClick={() => setTransferProgressDrawerOpen((o) => !o)}
          >
            <span className="transfer-progress-fab-icon" aria-hidden>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <line x1="10" y1="9" x2="8" y2="9" />
              </svg>
            </span>
            <span className="transfer-progress-fab-label">{t('进度')}</span>
          </button>

          <div
            className={`transfer-progress-drawer-root${transferProgressDrawerOpen ? ' is-open' : ''}`}
            aria-hidden={!transferProgressDrawerOpen}
          >
            <div
              className="transfer-progress-drawer-backdrop"
              onClick={() => setTransferProgressDrawerOpen(false)}
            />
            <aside className="transfer-progress-drawer" role="dialog" aria-labelledby="transfer-progress-drawer-title">
              <div className="transfer-progress-drawer-header">
                <h2 id="transfer-progress-drawer-title" className="transfer-progress-drawer-title">
                  {t('模板转换进度')}
                </h2>
                <div className="transfer-progress-drawer-actions">
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => {
                      setTransferOpen(true);
                      if (transferSource) setTransferSource(transferSource);
                      setTransferProgressDrawerOpen(false);
                    }}
                  >
                    {t('打开转换窗口')}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setTransferProgressDrawerOpen(false)}
                    aria-label={t('关闭')}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="transfer-progress-drawer-meta">
                <div><strong>{t('项目')}</strong> {activeJob.sourceName || '—'}</div>
                <div>
                  <strong>{t('状态')}</strong> {activeJob.status}
                  {activeJob.currentNode && (
                    <span className="transfer-progress-drawer-node">
                      {' '}· {activeJob.currentNode}
                      {activeJob.phase ? ` (${activeJob.phase})` : ''}
                    </span>
                  )}
                  {activeJob.status === 'waiting_images' && (
                    <span className="transfer-progress-drawer-badge transfer-progress-drawer-badge--images">{t('等待截图')}</span>
                  )}
                  {activeJob.status === 'waiting_confirm' && (
                    <span className="transfer-progress-drawer-badge transfer-progress-drawer-badge--qa">{t('等待问卷')}</span>
                  )}
                </div>
              </div>
              {activeJob.completedNodes && activeJob.completedNodes.length > 0 && (
                <div className="transfer-progress-drawer-nodes">
                  <div className="transfer-progress-drawer-nodes-label">{t('已完成节点')}</div>
                  <div className="transfer-progress-drawer-nodes-list">
                    {[...new Set(activeJob.completedNodes)].map((n) => (
                      <span key={n} className="transfer-progress-drawer-node-chip">{n}</span>
                    ))}
                  </div>
                </div>
              )}
              {activeJob.error && (
                <div className="transfer-progress-drawer-error">{activeJob.error}</div>
              )}
              <div className="transfer-progress-drawer-log-wrap">
                <div className="transfer-progress-drawer-log-title">{t('完整日志')}</div>
                <div className="transfer-progress-drawer-log">
                  {activeJob.progressLogEntries && activeJob.progressLogEntries.length > 0
                    ? activeJob.progressLogEntries.map((e, i) => (
                      <div
                        key={i}
                        className={`transfer-progress-drawer-log-line transfer-progress-drawer-log-line--${e.level || 'info'}`}
                      >
                        {e.node ? <span className="transfer-progress-drawer-log-node">[{e.node}]</span> : null}
                        {e.message || ''}
                      </div>
                    ))
                    : (activeJob.progressLog || []).map((line, i) => (
                      <div key={i} className="transfer-progress-drawer-log-line transfer-progress-drawer-log-line--info">{line}</div>
                    ))}
                  {!activeJob.progressLog?.length && !(activeJob.progressLogEntries?.length) && (
                    <div className="transfer-progress-drawer-log-empty">{t('暂无日志')}</div>
                  )}
                </div>
              </div>
            </aside>
          </div>
        </>,
        document.body,
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>{t('设置')}</div>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('LLM Endpoint')}</label>
                <input
                  className="input"
                  type="text"
                  placeholder="https://api.openai.com/v1/chat/completions"
                  value={settingsForm.llmEndpoint}
                  onChange={(e) => setSettingsForm((p) => ({ ...p, llmEndpoint: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>{t('LLM API Key')}</label>
                <input
                  className="input"
                  type="password"
                  placeholder="sk-..."
                  value={settingsForm.llmApiKey}
                  onChange={(e) => setSettingsForm((p) => ({ ...p, llmApiKey: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>{t('LLM Model')}</label>
                <input
                  className="input"
                  type="text"
                  placeholder="gpt-4o"
                  value={settingsForm.llmModel}
                  onChange={(e) => setSettingsForm((p) => ({ ...p, llmModel: e.target.value }))}
                />
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                {t('未配置 API Key 时将使用后端环境变量。')}
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => { setSettingsForm(loadLLMSettings()); setSettingsOpen(false); }}>{t('取消')}</button>
              <button className="btn" onClick={() => { saveLLMSettings(settingsForm); setSettingsOpen(false); }}>{t('保存')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
