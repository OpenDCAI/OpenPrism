import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  uploadTemplate
} from '../api/client';
import type { ProjectMeta, TemplateMeta, TemplateCategory } from '../api/client';
import TransferPanel from './TransferPanel';
import WorkspaceAiBlock from './WorkspaceAiBlock';
import {
  AppTopBar,
  Avatar,
  Badge,
  Button,
  CrumbSep,
  EmptyState,
  Icon,
  IconButton,
  MenuButton,
  Modal,
  SegmentedControl,
  Select,
  Tag,
  useWorkspace
} from '@design';
import type { BadgeTone, IconName, MenuEntry, SelectOption, Workspace, WorkspaceRole } from '@design';
import './pages.css';
import { dropLegacyLlmDefaults } from './llmDefaults';

type ViewFilter = 'all' | 'mine' | 'archived' | 'trash';
type SortBy = 'updatedAt' | 'name' | 'createdAt';
type Section = 'projects' | 'templates' | 'members' | 'settings';
type TFn = (k: string, o?: Record<string, unknown>) => string;

const SECTIONS: Section[] = ['projects', 'templates', 'members', 'settings'];
const SETTINGS_KEY = 'openprism-settings-v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASSIGNABLE_ROLES: WorkspaceRole[] = ['Admin', 'Editor', 'Commenter', 'Viewer'];
const WORKSPACE_NAME_MAX = 60;

interface LLMSettings {
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
}

const DEFAULT_LLM: LLMSettings = {
  llmEndpoint: '',
  llmApiKey: '',
  llmModel: '',
};

function loadLLMSettings(): LLMSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_LLM;
    const parsed = JSON.parse(raw);
    return dropLegacyLlmDefaults({
      llmEndpoint: parsed.llmEndpoint ?? DEFAULT_LLM.llmEndpoint,
      llmApiKey: parsed.llmApiKey ?? DEFAULT_LLM.llmApiKey,
      llmModel: parsed.llmModel ?? DEFAULT_LLM.llmModel,
    });
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

function formatRelativeTime(iso: string, t: TFn): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  if (diff < 60_000) return t('刚刚');
  if (diff < 3_600_000) return t('{{n}} 分钟前', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('{{n}} 小时前', { n: Math.floor(diff / 3_600_000) });
  return t('{{n}} 天前', { n: Math.floor(diff / 86_400_000) });
}

function validateWorkspaceName(value: string, workspaces: Workspace[], excludeId: string | null, t: TFn): string | null {
  const name = value.trim();
  if (!name) return t('Enter a workspace name.');
  if (name.length > WORKSPACE_NAME_MAX) return t('Use {{max}} characters or fewer.', { max: WORKSPACE_NAME_MAX });
  if (workspaces.some((w) => w.id !== excludeId && w.name.trim().toLowerCase() === name.toLowerCase())) {
    return t('You already have a workspace with that name.');
  }
  return null;
}

function membersLabel(count: number, t: TFn) {
  return count === 1 ? t('1 member') : t('{{count}} members', { count });
}

/* ---------------------------------------------------------------------
   Small presentational helpers
   --------------------------------------------------------------------- */
function hashOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Code-drawn mini paper preview. Purely decorative. */
function PaperThumb({ seed }: { seed: string }) {
  const h = hashOf(seed);
  const twoCol = h % 3 !== 0;
  const column = (n: number, key: string) => (
    <div key={key}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`home-ln${(i + h) % 4 === 3 ? ' is-short' : ''}`} />
      ))}
    </div>
  );
  return (
    <div className="home-thumb" aria-hidden="true">
      <div className="home-page">
        <span className="home-page-title" />
        <span className="home-page-author" />
        <div className={`home-page-cols${twoCol ? ' is-two' : ''}`}>
          {twoCol ? [column(9, 'a'), column(9, 'b')] : column(10, 'a')}
        </div>
      </div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <span className="home-field-error" id={id} role="alert">
      <Icon name="alert-circle" />
      <span>{message}</span>
    </span>
  );
}

function SectionHead({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="home-head">
      <div className="home-head-text">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="home-head-actions">{actions}</div>}
    </div>
  );
}

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}

function ConfirmModal({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await state.onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <Modal
      title={state.title}
      onClose={onClose}
      closeLabel={t('Close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('取消')}</Button>
          <Button variant="danger" loading={busy} onClick={() => void run()}>{state.confirmLabel}</Button>
        </>
      }
    >
      <p className="home-modal-text">{state.message}</p>
    </Modal>
  );
}

/* ---------------------------------------------------------------------
   Members section
   --------------------------------------------------------------------- */
function MembersSection({
  onStatus,
  onConfirm,
  onNewWorkspace
}: {
  onStatus: (msg: string) => void;
  onConfirm: (c: ConfirmState) => void;
  onNewWorkspace: () => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const w = ws.active;
  const admin = ws.isAdmin();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('Editor');
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    setEmail('');
    setEmailError(null);
  }, [w.id]);

  const roleOptions: SelectOption<WorkspaceRole>[] = ASSIGNABLE_ROLES.map((r) => ({ value: r, label: t(r) }));
  // Owners may also make a member an owner (ownership is shared; owners cannot be demoted afterwards).
  const memberRoleOptions: SelectOption<WorkspaceRole>[] = ws.myRole() === 'Owner' ? [{ value: 'Owner', label: t('Owner') }, ...roleOptions] : roleOptions;

  const validateEmail = (value: string, required: boolean): string | null => {
    const v = value.trim();
    if (!v) return required ? t('Enter an email address.') : null;
    if (!EMAIL_RE.test(v)) return t('Enter a full email address, like name@university.edu.');
    const exists = w.members.some((m) => (ws.users[m.userId]?.email || '').toLowerCase() === v.toLowerCase());
    if (exists) return t('That person is already in this workspace.');
    return null;
  };

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateEmail(email, true);
    setEmailError(err);
    if (err) return;
    const v = email.trim();
    try {
      await ws.inviteMember(v, role);
      setEmail('');
      onStatus(t('Invitation sent to {{email}}', { email: v }));
    } catch (error) {
      setEmailError((error as Error).message);
    }
  };

  return (
    <>
      <SectionHead
        title={t('Members')}
        subtitle={t('People in {{workspace}} can see every project here.', { workspace: w.name })}
      />

      {w.kind === 'Personal' ? (
        <div className="home-block">
          <h2>{t('This is your personal workspace')}</h2>
          <p>{t('Only you are a member. To work with others, create a team workspace and move projects into it.')}</p>
          <div className="home-block-actions">
            <Button icon="plus" onClick={onNewWorkspace}>{t('New team workspace')}</Button>
          </div>
        </div>
      ) : admin ? (
        <form className="home-block" onSubmit={onInvite} noValidate>
          <h2>{t('Invite people')}</h2>
          <div className="home-invite-row">
            <div className="op-field">
              <label className="op-field-label" htmlFor="invite-email">{t('Email address')}</label>
              <input
                id="invite-email"
                className="op-input"
                type="email"
                autoComplete="off"
                placeholder="name@university.edu"
                value={email}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? 'invite-email-error' : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                onBlur={() => setEmailError(validateEmail(email, false))}
              />
              <FieldError id="invite-email-error" message={emailError} />
            </div>
            <div className="op-field">
              <label className="op-field-label" htmlFor="invite-role">{t('Role')}</label>
              <Select<WorkspaceRole> id="invite-role" value={role} options={roleOptions} onChange={setRole} />
            </div>
            <Button type="submit" variant="primary" icon="send" className="home-row-btn">{t('Send invite')}</Button>
          </div>
        </form>
      ) : (
        <div className="home-block">
          <p>{t("Only owners and admins can invite people or change roles. You're {{role}} here.", { role: t(ws.myRole()) })}</p>
        </div>
      )}

      <div className="home-table-wrap">
        <table className="home-table">
          <thead>
            <tr>
              <th scope="col">{t('Member')}</th>
              <th scope="col">{t('Role')}</th>
              <th scope="col">{t('Last active')}</th>
              <th scope="col"><span className="op-sr-only">{t('操作')}</span></th>
            </tr>
          </thead>
          <tbody>
            {w.members.map((m) => {
              const u = ws.users[m.userId] || { id: m.userId, name: m.userId, email: '', color: undefined };
              const isMe = m.userId === ws.user.id;
              const locked = !admin || m.role === 'Owner' || isMe;
              return (
                <tr key={m.userId}>
                  <td>
                    <div className="home-member">
                      <Avatar name={u.name} color={u.color} size="lg" />
                      <div className="home-member-text">
                        <strong className="op-truncate">{isMe ? t('{{name}} (you)', { name: u.name }) : u.name}</strong>
                        <span className="op-truncate">{m.invited ? t('Invitation sent') : u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    {locked ? (
                      <Badge tone={m.role === 'Owner' ? 'accent' : 'neutral'}>{t(m.role)}</Badge>
                    ) : (
                      <Select<WorkspaceRole>
                        size="sm"
                        value={m.role}
                        options={m.invited ? roleOptions : memberRoleOptions}
                        ariaLabel={t('Role for {{name}}', { name: u.name })}
                        onChange={(r) => r === 'Owner'
                          ? onConfirm({
                              title: t('Make {{name}} an owner?', { name: u.name }),
                              message: t('Owners have full control of the workspace, and an owner cannot be changed back to another role. You stay an owner too.'),
                              confirmLabel: t('Make owner'),
                              onConfirm: () => ws.setMemberRole(m.userId, r).catch((err) => onStatus(err.message))
                            })
                          : ws.setMemberRole(m.userId, r).catch((err) => onStatus(err.message))}
                      />
                    )}
                  </td>
                  <td>
                    {m.invited ? (
                      <span className="home-invite-status">
                        {m.sendFailed ? <Badge tone="danger">{t('Email not sent')}</Badge> : <Badge tone="info">{t('Invited')}</Badge>}
                        {m.lastSentAt && <span className="home-muted">{t('Sent {{when}}', { when: new Date(m.lastSentAt).toLocaleString() })}</span>}
                        {admin && (
                          <Button size="sm" variant="ghost" onClick={() => ws.resendInvite(m.userId)
                            .then(() => onStatus(t('Invitation sent again to {{email}}', { email: u.email })))
                            .catch((err) => onStatus(err.message))}>{t('Resend')}</Button>
                        )}
                      </span>
                    ) : <span className="home-muted">{isMe ? t('Now') : t('Not tracked')}</span>}
                  </td>
                  <td className="home-cell-end">
                    {!locked && (
                      <IconButton
                        icon="trash"
                        label={t('Remove {{name}}', { name: u.name })}
                        tipPos="left"
                        onClick={() =>
                          onConfirm({
                            title: t('Remove {{name}}?', { name: u.name }),
                            message: t('They will lose access to the projects in {{workspace}}.', { workspace: w.name }),
                            confirmLabel: t('Remove member'),
                            onConfirm: () => {
                              ws.removeMember(m.userId)
                                .then(() => onStatus(t('{{name}} was removed from {{workspace}}', { name: u.name, workspace: w.name })))
                                .catch((err) => onStatus(err.message));
                            }
                          })
                        }
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------
   Settings section
   --------------------------------------------------------------------- */
function SettingsSection({
  projectCount,
  onStatus,
  onConfirm,
  onLeft
}: {
  projectCount: number;
  onStatus: (msg: string) => void;
  onConfirm: (c: ConfirmState) => void;
  onLeft: () => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const w = ws.active;
  const admin = ws.isAdmin();
  const role = ws.myRole();
  const [name, setName] = useState(w.name);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    setName(w.name);
    setNameError(null);
  }, [w.id, w.name]);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateWorkspaceName(name, ws.workspaces, w.id, t);
    setNameError(err);
    if (err) return;
    try {
      await ws.renameWorkspace(w.id, name.trim());
      onStatus(t('Workspace renamed'));
    } catch (error) {
      setNameError((error as Error).message);
    }
  };

  return (
    <>
      <SectionHead
        title={t('Settings')}
        subtitle={t('Workspace details shared by every project in {{workspace}}.', { workspace: w.name })}
      />

      <form className="home-block" onSubmit={onSave} noValidate>
        <h2>{t('General')}</h2>
        <div className="home-settings-row">
          <div className="op-field">
            <label className="op-field-label" htmlFor="ws-name">{t('Workspace name')}</label>
            <input
              id="ws-name"
              className="op-input"
              autoComplete="off"
              value={name}
              disabled={!admin}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'ws-name-error' : undefined}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              onBlur={() => {
                if (name.trim() !== w.name) setNameError(validateWorkspaceName(name, ws.workspaces, w.id, t));
              }}
            />
            <FieldError id="ws-name-error" message={nameError} />
          </div>
          <Button type="submit" className="home-row-btn" disabled={!admin || name.trim() === w.name}>{t('保存')}</Button>
        </div>
        <div className="op-field">
          <span className="op-field-label">{t('Type')}</span>
          <span className="home-static">{w.kind === 'Personal' ? t('Personal workspace') : t('Team workspace')}</span>
        </div>
        {!admin && <p>{t('Only owners and admins can change these settings.')}</p>}
      </form>

      <WorkspaceAiBlock workspaceId={w.id} onStatus={onStatus} onConfirm={onConfirm} />

      {w.kind === 'Team' && role !== 'Owner' && (
        <div className="home-block is-danger">
          <h2>{t('Leave workspace')}</h2>
          <p>{t('You will lose access to its {{count}} projects unless someone shares them with you directly.', { count: projectCount })}</p>
          <div className="home-block-actions">
            <Button
              variant="danger"
              icon="log-out"
              onClick={() =>
                onConfirm({
                  title: t('Leave {{workspace}}?', { workspace: w.name }),
                  message: t('You will lose access to its projects. An admin can invite you back.'),
                  confirmLabel: t('Leave workspace'),
                  onConfirm: () => {
                    const leftName = w.name;
                    ws.leaveWorkspace(w.id)
                      .then(() => {
                        onLeft();
                        onStatus(t('You left {{workspace}}', { workspace: leftName }));
                      })
                      .catch((err) => onStatus(err.message));
                  }
                })
              }
            >
              {t('Leave {{workspace}}', { workspace: w.name })}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------------
   New workspace modal
   --------------------------------------------------------------------- */
function NewWorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (w: Workspace) => void }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const err = validateWorkspaceName(name, ws.workspaces, null, t);
    setError(err);
    if (err) return;
    try {
      onCreated(await ws.createWorkspace(name.trim()));
    } catch (error) {
      setError((error as Error).message);
    }
  };

  return (
    <Modal
      title={t('New workspace')}
      description={t("Team workspaces hold shared projects and members. You'll be the owner.")}
      onClose={onClose}
      closeLabel={t('Close')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('取消')}</Button>
          <Button variant="primary" onClick={() => submit()}>{t('Create workspace')}</Button>
        </>
      }
    >
      <form className="op-field" onSubmit={submit} noValidate>
        <label className="op-field-label" htmlFor="new-ws-name">{t('Workspace name')}</label>
        <input
          id="new-ws-name"
          className="op-input"
          autoComplete="off"
          placeholder={t('e.g. Thesis committee')}
          value={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'new-ws-name-error' : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => {
            if (name.trim()) setError(validateWorkspaceName(name, ws.workspaces, null, t));
          }}
        />
        <FieldError id="new-ws-name-error" message={error} />
      </form>
    </Modal>
  );
}

/* =====================================================================
   Workspace home
   ===================================================================== */
export default function ProjectPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const ws = useWorkspace();
  const activeWs = ws.active;
  const [searchParams, setSearchParams] = useSearchParams();

  const sectionParam = searchParams.get('section');
  const section: Section = SECTIONS.includes(sectionParam as Section) ? (sectionParam as Section) : 'projects';
  const newWorkspaceOpen = sectionParam === 'new-workspace';
  const goSection = useCallback((s: Section | 'new-workspace') => {
    setSearchParams(s === 'projects' ? {} : { section: s });
  }, [setSearchParams]);

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('');

  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('updatedAt');

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createTemplate, setCreateTemplate] = useState('');
  const [creating, setCreating] = useState(false);
  const [renameState, setRenameState] = useState<{ id: string; value: string; error?: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [arxivInput, setArxivInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ phase: string; percent: number } | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  // LLM settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState<LLMSettings>(loadLLMSettings);

  // Template gallery (Templates section) filters
  const [galleryCat, setGalleryCat] = useState('all');
  const [galleryFeatured, setGalleryFeatured] = useState(false);
  const [gallerySearch, setGallerySearch] = useState('');

  // Tag editing modal
  const [tagEditId, setTagEditId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');

  // Destructive-action confirmation
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  // Transfer modal state
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSource, setTransferSource] = useState<{ id: string; name: string } | null>(null);

  // Active transfer job (persists after modal close)
  const [activeJob, setActiveJob] = useState<{
    jobId: string; status: string; progressLog: string[]; error?: string;
    sourceName?: string;
  } | null>(null);
  const [jobWidgetOpen, setJobWidgetOpen] = useState(true);

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

  // Reset per-workspace filters when switching workspace.
  useEffect(() => {
    setActiveTag(null);
  }, [activeWs.id]);

  /** Projects in the active workspace. */
  const wsProjects = projects.filter((p) => p.workspaceId === activeWs.id);

  const allTags = Array.from(new Set(wsProjects.flatMap((p) => p.tags || []))).sort();

  const filteredProjects = (() => {
    let list = wsProjects;
    if (viewFilter === 'archived') list = list.filter((p) => p.archived && !p.trashed);
    else if (viewFilter === 'trash') list = list.filter((p) => p.trashed);
    else if (viewFilter === 'mine') list = list.filter((p) => !p.archived && !p.trashed);
    else list = list.filter((p) => !p.trashed);
    if (activeTag) list = list.filter((p) => (p.tags || []).includes(activeTag));
    const term = filter.trim().toLowerCase();
    if (term) list = list.filter((p) => p.name.toLowerCase().includes(term));
    return [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'createdAt') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
    });
  })();

  const viewCounts: Record<ViewFilter, number> = {
    all: wsProjects.filter((p) => !p.trashed).length,
    mine: wsProjects.filter((p) => !p.archived && !p.trashed).length,
    archived: wsProjects.filter((p) => p.archived && !p.trashed).length,
    trash: wsProjects.filter((p) => p.trashed).length,
  };

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

  const openCreate = () => {
    setCreateError(null);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateError(t('请输入项目名称。'));
      return;
    }
    setCreating(true);
    try {
      const created = await createProject({ name, template: createTemplate || undefined, workspaceId: activeWs.id });
      setCreateOpen(false);
      setCreateName('');
      await loadProjects();
      navigate(`/editor/${created.id}`);
    } catch (err) {
      setStatus(t('创建失败: {{error}}', { error: String(err) }));
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async () => {
    if (!renameState) return;
    const name = renameState.value.trim();
    if (!name) {
      setRenameState({ ...renameState, error: t('请输入项目名称。') });
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

  const handleDelete = (id: string, name: string) => {
    setConfirmState({
      title: t('删除'),
      message: t('删除项目 {{name}}？此操作不可撤销。', { name }),
      confirmLabel: t('删除'),
      onConfirm: async () => {
        try {
          await deleteProject(id);
          await loadProjects();
        } catch (err) {
          setStatus(t('删除失败: {{error}}', { error: String(err) }));
        }
      }
    });
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

  const handlePermanentDelete = (id: string, name: string) => {
    setConfirmState({
      title: t('永久删除'),
      message: t('确定永久删除项目 {{name}}？此操作不可撤销。', { name }),
      confirmLabel: t('永久删除'),
      onConfirm: async () => {
        try {
          await permanentDeleteProject(id);
          await loadProjects();
        } catch (err) {
          setStatus(t('删除失败: {{error}}', { error: String(err) }));
        }
      }
    });
  };

  const handleEmptyTrash = () => {
    // Only the active workspace's trash is visible, so only that is emptied.
    const trashItems = wsProjects.filter((p) => p.trashed);
    setConfirmState({
      title: t('清空回收站'),
      message: t('确定清空回收站？所有项目将被永久删除。'),
      confirmLabel: t('清空回收站'),
      onConfirm: async () => {
        for (const p of trashItems) {
          try { await permanentDeleteProject(p.id); } catch {}
        }
        await loadProjects();
      }
    });
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
    const tags = (proj.tags || []).filter((x) => x !== tag);
    try {
      await updateProjectTags(id, tags);
      await loadProjects();
    } catch (err) {
      setStatus(t('操作失败: {{error}}', { error: String(err) }));
    }
  };

  const handleCreateFromTemplate = async (tplId: string) => {
    const tpl = templates.find((x) => x.id === tplId);
    const name = createName.trim() || tpl?.label || 'Untitled';
    try {
      const created = await createProject({ name, template: tplId, workspaceId: activeWs.id });
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
      const res = await importZip({ file, projectName: file.name.replace(/\.zip$/i, '') || t('Imported Project'), workspaceId: activeWs.id });
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
        { arxivIdOrUrl: arxivInput.trim(), workspaceId: activeWs.id },
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

  const clearFilters = () => {
    setFilter('');
    setActiveTag(null);
    setViewFilter('all');
  };

  /* ---------- labels ---------- */
  const viewLabels: Record<ViewFilter, string> = {
    all: t('所有项目'),
    mine: t('我的项目'),
    archived: t('已归档'),
    trash: t('回收站'),
  };
  const sortOptions: SelectOption<SortBy>[] = [
    { value: 'updatedAt', label: t('最近修改') },
    { value: 'name', label: t('按名称') },
    { value: 'createdAt', label: t('创建时间') },
  ];
  const sectionLabels: Record<Section, string> = {
    projects: t('Projects'),
    templates: t('模板库'),
    members: t('Members'),
    settings: t('Settings'),
  };
  const sectionIcons: Record<Section, IconName> = {
    projects: 'layout-grid',
    templates: 'book-open',
    members: 'users',
    settings: 'settings',
  };
  const sectionCounts: Record<Section, number | null> = {
    projects: viewCounts.all,
    templates: templates.length,
    members: activeWs.members.length,
    settings: null,
  };

  /* ---------- project card menu ---------- */
  const projectMenu = (project: ProjectMeta): MenuEntry[] => {
    if (project.trashed) {
      return [
        { label: t('打开'), icon: 'arrow-up-right', onSelect: () => navigate(`/editor/${project.id}`) },
        { type: 'sep' },
        { label: t('恢复'), icon: 'rotate-ccw', onSelect: () => void handleTrash(project.id, false) },
        { label: t('永久删除'), icon: 'trash', danger: true, onSelect: () => handlePermanentDelete(project.id, project.name) },
      ];
    }
    const current = project.workspaceId;
    const moveItems: MenuEntry[] = ws.workspaces.length > 1
      ? [
          { type: 'sep' },
          { type: 'label', label: t('Move to workspace') },
          ...ws.workspaces.map<MenuEntry>((w) => ({
            label: w.name,
            lead: <Avatar name={w.name} color={w.color} size="sm" square />,
            checked: w.id === current,
            disabled: w.id === current,
            onSelect: () => {
              ws.moveProject(project.id, w.id)
                .then(() => {
                  setStatus(t('Moved {{project}} to {{workspace}}', { project: project.name, workspace: w.name }));
                  return loadProjects();
                })
                .catch((err) => setStatus(t('Could not move {{project}}: {{error}}', { project: project.name, error: err.message })));
            }
          }))
        ]
      : [];
    return [
      { label: t('打开'), icon: 'arrow-up-right', onSelect: () => navigate(`/editor/${project.id}`) },
      { label: t('重命名'), icon: 'pencil', onSelect: () => setRenameState({ id: project.id, value: project.name }) },
      { label: t('复制'), icon: 'copy', onSelect: () => void handleCopy(project.id, project.name) },
      { label: t('Edit tags'), icon: 'tag', onSelect: () => { setTagEditId(project.id); setTagInput(''); } },
      {
        label: t('转换'),
        icon: 'arrow-left-right',
        onSelect: () => { setTransferSource({ id: project.id, name: project.name }); setTransferOpen(true); }
      },
      ...moveItems,
      { type: 'sep' },
      project.archived
        ? { label: t('取消归档'), icon: 'rotate-ccw', onSelect: () => void handleArchive(project.id, false) }
        : { label: t('归档'), icon: 'archive', onSelect: () => void handleArchive(project.id, true) },
      { label: t('删除'), icon: 'trash', danger: true, onSelect: () => handleDelete(project.id, project.name) },
    ];
  };

  /* ---------- sections ---------- */
  const renderProjects = () => {
    const filtersActive = Boolean(filter.trim() || activeTag);
    let body: ReactNode;
    if (filteredProjects.length > 0) {
      body = (
        <div className="home-grid">
          {filteredProjects.map((project) => (
            <article key={project.id} className={`home-card${project.trashed ? ' is-muted' : ''}`}>
              <PaperThumb seed={project.id} />
              <div className="home-card-body">
                <div className="home-card-top">
                  <button type="button" className="home-card-open" onClick={() => navigate(`/editor/${project.id}`)}>
                    <span className="home-card-name op-truncate">{project.name}</span>
                    <span className="home-card-meta op-truncate">
                      {t('Edited {{time}}', { time: formatRelativeTime(project.updatedAt || project.createdAt, t) })}
                    </span>
                  </button>
                  <MenuButton
                    className="op-btn op-btn-ghost op-btn-icon op-btn-sm home-card-more"
                    aria-label={t('More actions for {{name}}', { name: project.name })}
                    items={() => projectMenu(project)}
                    menuLabel={project.name}
                    align="end"
                    minWidth={220}
                  >
                    <Icon name="more" />
                  </MenuButton>
                </div>
                <div className="home-card-foot">
                  {project.trashed && <Badge tone="danger" icon="trash">{t('回收站')}</Badge>}
                  {!project.trashed && project.archived && <Badge icon="archive">{t('已归档')}</Badge>}
                  {(project.tags || []).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="op-tag home-tag-btn"
                      aria-pressed={activeTag === tag}
                      onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          ))}
          {viewFilter !== 'trash' && viewFilter !== 'archived' && !filtersActive && (
            <button type="button" className="home-new-card" onClick={openCreate}>
              <Icon name="plus" />
              <span>{t('新建项目')}</span>
            </button>
          )}
        </div>
      );
    } else if (filtersActive) {
      body = (
        <EmptyState
          icon="search"
          title={t('No projects match your filters')}
          action={<Button onClick={clearFilters}>{t('Clear filters')}</Button>}
        >
          {t('Try a different name or tag, or clear the filters.')}
        </EmptyState>
      );
    } else if (viewFilter === 'trash') {
      body = <EmptyState icon="trash" title={t('Trash is empty')}>{t('Deleted projects stay here until you remove them permanently.')}</EmptyState>;
    } else if (viewFilter === 'archived') {
      body = <EmptyState icon="archive" title={t('Nothing archived')}>{t('Archive a project from its menu to hide it from your active list.')}</EmptyState>;
    } else {
      body = (
        <EmptyState
          icon="folder-plus"
          title={t('No projects in {{workspace}} yet', { workspace: activeWs.name })}
          action={
            <div className="home-inline">
              <Button variant="primary" icon="plus" onClick={openCreate}>{t('新建项目')}</Button>
              <Button icon="upload" onClick={() => setImportOpen(true)}>{t('导入项目')}</Button>
            </div>
          }
        >
          {t('Start from a template, a blank article, or import a .zip or arXiv paper.')}
        </EmptyState>
      );
    }

    const tagOptions: SelectOption[] = [
      { value: '', label: t('All tags') },
      ...allTags.map((tag) => ({ value: tag, label: tag })),
    ];

    return (
      <>
        <SectionHead
          title={t('Projects')}
          subtitle={viewCounts.all === 1
            ? t('1 project in {{workspace}}', { workspace: activeWs.name })
            : t('{{count}} projects in {{workspace}}', { count: viewCounts.all, workspace: activeWs.name })}
          actions={
            <>
              <Button icon="upload" onClick={() => setImportOpen(true)}>{t('导入项目')}</Button>
              <Button variant="primary" size="lg" icon="plus" onClick={openCreate}>{t('新建项目')}</Button>
            </>
          }
        />
        <div className="home-filters">
          <div className="home-search">
            <Icon name="search" />
            <input
              className="op-input"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('搜索项目...')}
              aria-label={t('搜索项目...')}
              autoComplete="off"
            />
          </div>
          <SegmentedControl<ViewFilter>
            label={t('Filter projects')}
            value={viewFilter}
            onChange={setViewFilter}
            options={(['all', 'mine', 'archived', 'trash'] as ViewFilter[]).map((v) => ({
              value: v,
              label: `${viewLabels[v]} ${viewCounts[v]}`,
            }))}
          />
          {allTags.length > 0 && (
            <Select
              icon="tag"
              value={activeTag || ''}
              options={tagOptions}
              onChange={(v) => setActiveTag(v || null)}
              ariaLabel={t('标签')}
            />
          )}
          <Select<SortBy> value={sortBy} options={sortOptions} onChange={setSortBy} ariaLabel={t('Sort projects')} />
          {viewFilter === 'trash' && viewCounts.trash > 0 && (
            <Button variant="danger" icon="trash" onClick={handleEmptyTrash}>{t('清空回收站')}</Button>
          )}
        </div>
        {body}
        {filteredProjects.length > 0 && (
          <p className="home-footnote">
            {t('显示 {{shown}} / {{total}} 个项目', { shown: filteredProjects.length, total: wsProjects.length })}
          </p>
        )}
      </>
    );
  };

  const renderTemplates = () => {
    const catTabs = [{ id: 'all', label: t('全部'), labelEn: 'All' }, ...(categories || [])];
    const filtersActive = Boolean(galleryCat !== 'all' || galleryFeatured || gallerySearch.trim());
    return (
      <>
        <SectionHead
          title={t('模板库')}
          subtitle={t('选择模板快速开始您的项目')}
          actions={
            <Button icon="upload" loading={uploadingTemplate} onClick={() => templateZipRef.current?.click()}>
              {uploadingTemplate ? t('上传中...') : t('上传模板')}
            </Button>
          }
        />
        <div className="op-tabs home-tabs" role="tablist" aria-label={t('模板库')}>
          {catTabs.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              className="op-tab"
              aria-selected={galleryCat === cat.id}
              onClick={() => setGalleryCat(cat.id)}
            >
              {i18n.language === 'en-US' ? cat.labelEn : cat.label}
            </button>
          ))}
        </div>
        <div className="home-filters">
          <div className="home-search">
            <Icon name="search" />
            <input
              className="op-input"
              type="search"
              value={gallerySearch}
              onChange={(e) => setGallerySearch(e.target.value)}
              placeholder={t('搜索模板...')}
              aria-label={t('搜索模板...')}
              autoComplete="off"
            />
          </div>
          <label className="home-check">
            <input type="checkbox" checked={galleryFeatured} onChange={(e) => setGalleryFeatured(e.target.checked)} />
            {t('精选模板')}
          </label>
        </div>
        {galleryTemplates.length > 0 ? (
          <div className="home-grid">
            {galleryTemplates.map((tpl) => (
              <article key={tpl.id} className="home-card">
                <PaperThumb seed={tpl.id} />
                <div className="home-card-body">
                  <div className="home-card-top">
                    <div className="home-card-heading">
                      <span className="home-card-name op-truncate">{tpl.label}</span>
                      {tpl.author && <span className="home-card-meta op-truncate">{tpl.author}</span>}
                    </div>
                    {tpl.featured && <Badge icon="star">{t('精选模板')}</Badge>}
                  </div>
                  <p className="home-card-desc">
                    {i18n.language === 'en-US' ? (tpl.descriptionEn || tpl.description) : tpl.description}
                  </p>
                  {tpl.tags?.length > 0 && (
                    <div className="home-card-foot">
                      {tpl.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                    </div>
                  )}
                  <div>
                    <Button size="sm" icon="plus" onClick={() => void handleCreateFromTemplate(tpl.id)}>
                      {t('Use template')}
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="book-open"
            title={t('暂无匹配模板')}
            action={filtersActive ? (
              <Button onClick={() => { setGalleryCat('all'); setGalleryFeatured(false); setGallerySearch(''); }}>
                {t('Clear filters')}
              </Button>
            ) : (
              <Button icon="upload" onClick={() => templateZipRef.current?.click()}>{t('上传模板')}</Button>
            )}
          >
            {filtersActive ? t('Try another category or search term.') : t('Upload a .zip template to make it available here.')}
          </EmptyState>
        )}
      </>
    );
  };

  /* ---------- derived bits for modals / widget ---------- */
  const templateOptions: SelectOption[] = templates.map((tpl) => ({ value: tpl.id, label: tpl.label }));
  const tagEditProject = tagEditId ? projects.find((p) => p.id === tagEditId) || null : null;
  const submitTag = () => {
    const tag = tagInput.trim();
    if (!tagEditId || !tag) return;
    void handleAddTag(tagEditId, tag);
    setTagInput('');
  };
  const jobTone: BadgeTone = !activeJob ? 'neutral'
    : activeJob.status === 'success' ? 'success'
      : activeJob.status === 'failed' || activeJob.status === 'error' ? 'danger'
        : activeJob.status === 'waiting_images' ? 'warning'
          : 'info';
  const jobRunning = jobTone === 'info';
  const myRole = ws.myRole();

  return (
    <div className="home">
      <AppTopBar
        crumbs={
          <>
            <CrumbSep />
            <span className="home-crumb">{sectionLabels[section]}</span>
          </>
        }
        actions={
          <IconButton
            icon="bot"
            label={t('AI settings')}
            tipPos="bottom-end"
            onClick={() => { setSettingsForm(loadLLMSettings()); setSettingsOpen(true); }}
          />
        }
      />

      <div className="home-body">
        {/* ── Sidebar ── */}
        <aside className="home-side" aria-label={t('Workspace navigation')}>
          <div className="home-ws-card">
            <Avatar name={activeWs.name} color={activeWs.color} size="xl" square />
            <div className="home-ws-card-text">
              <strong className="op-truncate">{activeWs.name}</strong>
              <span>
                {t(activeWs.kind)} · {membersLabel(activeWs.members.length, t)} · {t("You're {{role}}", { role: t(myRole) })}
              </span>
            </div>
          </div>

          <nav className="home-nav" aria-label={t('Workspace')}>
            {SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="home-side-link"
                aria-current={section === s && !newWorkspaceOpen ? 'page' : undefined}
                onClick={() => goSection(s)}
              >
                <Icon name={sectionIcons[s]} />
                <span className="op-truncate">{sectionLabels[s]}</span>
                {sectionCounts[s] !== null && <span className="home-count">{sectionCounts[s]}</span>}
              </button>
            ))}
          </nav>

          <span className="op-section-label home-side-label">{t('Workspaces')}</span>
          <div className="home-ws-list">
            {ws.workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                className="home-side-link"
                aria-current={w.id === activeWs.id ? 'true' : undefined}
                onClick={() => ws.setActive(w.id)}
              >
                <Avatar name={w.name} color={w.color} size="sm" square />
                <span className="op-truncate">{w.name}</span>
              </button>
            ))}
            <button type="button" className="home-side-link" onClick={() => goSection('new-workspace')}>
              <Icon name="plus" />
              <span className="op-truncate">{t('New workspace')}</span>
            </button>
          </div>

          <div className="home-side-spacer" />
        </aside>

        {/* ── Main Content ── */}
        <main className="home-main">
          <div className="home-inner">
            {status && (
              <div className="home-alert" role="status">
                <Icon name="info" />
                <span>{status}</span>
                <IconButton icon="x" label={t('Dismiss')} tipPos="left" onClick={() => setStatus('')} />
              </div>
            )}
            {section === 'projects' && renderProjects()}
            {section === 'templates' && renderTemplates()}
            {section === 'members' && (
              <MembersSection
                onStatus={setStatus}
                onConfirm={setConfirmState}
                onNewWorkspace={() => goSection('new-workspace')}
              />
            )}
            {section === 'settings' && (
              <SettingsSection
                projectCount={viewCounts.all}
                onStatus={setStatus}
                onConfirm={setConfirmState}
                onLeft={() => goSection('projects')}
              />
            )}
          </div>
        </main>
      </div>

      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        hidden
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
      <input
        ref={templateZipRef}
        type="file"
        accept=".zip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUploadTemplate(f);
        }}
      />

      {/* ── New project ── */}
      {createOpen && (
        <Modal
          title={t('新建项目')}
          description={t('It will be created in {{workspace}}.', { workspace: activeWs.name })}
          onClose={() => setCreateOpen(false)}
          closeLabel={t('Close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setCreateOpen(false)}>{t('取消')}</Button>
              <Button variant="primary" loading={creating} onClick={() => void handleCreate()}>{t('创建')}</Button>
            </>
          }
        >
          <form
            className="op-field"
            noValidate
            onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}
          >
            <label className="op-field-label" htmlFor="create-name">{t('项目名称')}</label>
            <input
              id="create-name"
              className="op-input"
              autoComplete="off"
              value={createName}
              placeholder={t('My Paper')}
              aria-invalid={createError ? true : undefined}
              aria-describedby={createError ? 'create-name-error' : undefined}
              onChange={(event) => {
                setCreateName(event.target.value);
                if (createError) setCreateError(null);
              }}
            />
            <FieldError id="create-name-error" message={createError} />
          </form>
          <div className="op-field">
            <label className="op-field-label" htmlFor="create-template">{t('模板')}</label>
            <Select
              id="create-template"
              value={createTemplate}
              options={templateOptions}
              onChange={setCreateTemplate}
              placeholder="—"
              disabled={templates.length === 0}
            />
          </div>
        </Modal>
      )}

      {/* ── Rename ── */}
      {renameState && (
        <Modal
          title={t('重命名')}
          onClose={() => setRenameState(null)}
          closeLabel={t('Close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRenameState(null)}>{t('取消')}</Button>
              <Button variant="primary" onClick={() => void handleRename()}>{t('保存')}</Button>
            </>
          }
        >
          <form className="op-field" noValidate onSubmit={(e) => { e.preventDefault(); void handleRename(); }}>
            <label className="op-field-label" htmlFor="rename-name">{t('项目名称')}</label>
            <input
              id="rename-name"
              className="op-input"
              autoComplete="off"
              value={renameState.value}
              aria-invalid={renameState.error ? true : undefined}
              aria-describedby={renameState.error ? 'rename-name-error' : undefined}
              onChange={(e) => setRenameState({ ...renameState, value: e.target.value, error: undefined })}
            />
            <FieldError id="rename-name-error" message={renameState.error || null} />
          </form>
        </Modal>
      )}

      {/* ── Tags ── */}
      {tagEditProject && (
        <Modal
          title={t('Edit tags')}
          description={tagEditProject.name}
          onClose={() => { setTagEditId(null); setTagInput(''); }}
          closeLabel={t('Close')}
          footer={<Button variant="secondary" onClick={() => { setTagEditId(null); setTagInput(''); }}>{t('Done')}</Button>}
        >
          <form className="op-field" noValidate onSubmit={(e) => { e.preventDefault(); submitTag(); }}>
            <label className="op-field-label" htmlFor="tag-input">{t('添加标签')}</label>
            <div className="home-add-row">
              <input
                id="tag-input"
                className="op-input"
                autoComplete="off"
                value={tagInput}
                placeholder={t('输入标签名称')}
                onChange={(e) => setTagInput(e.target.value)}
              />
              <Button type="submit" icon="plus" disabled={!tagInput.trim()}>{t('添加标签')}</Button>
            </div>
          </form>
          {(tagEditProject.tags || []).length > 0 ? (
            <div className="home-tag-list" aria-label={t('标签')}>
              {(tagEditProject.tags || []).map((tag) => (
                <span key={tag} className="home-tag-chip">
                  {tag}
                  <IconButton
                    icon="x"
                    label={t('Remove tag {{tag}}', { tag })}
                    tip={false}
                    onClick={() => void handleRemoveTag(tagEditProject.id, tag)}
                  />
                </span>
              ))}
            </div>
          ) : (
            <p className="home-modal-text">{t('No tags yet. Tags help you filter projects.')}</p>
          )}
        </Modal>
      )}

      {/* ── Import ── */}
      {importOpen && (
        <Modal
          title={t('导入项目')}
          onClose={() => setImportOpen(false)}
          closeLabel={t('Close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setImportOpen(false)}>{t('取消')}</Button>
              <Button
                variant="primary"
                loading={importing && Boolean(importProgress)}
                disabled={importing || !arxivInput.trim()}
                onClick={() => void handleImportArxiv()}
              >
                {t('导入 arXiv')}
              </Button>
            </>
          }
        >
          <div className="op-field">
            <span className="op-field-label">{t('上传 Zip 文件')}</span>
            <div className="home-inline">
              <Button icon="upload" onClick={() => zipInputRef.current?.click()} disabled={importing}>
                {t('选择文件')}
              </Button>
              {importing && !importProgress && <Badge tone="info" icon="loader" spin>{t('导入中...')}</Badge>}
            </div>
          </div>
          <hr className="home-divider" />
          <div className="op-field">
            <label className="op-field-label" htmlFor="arxiv-input">{t('arXiv 链接导入')}</label>
            <input
              id="arxiv-input"
              className="op-input"
              autoComplete="off"
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
            <div className="op-field" role="status">
              <span className="op-field-label">
                {importProgress.phase === 'download'
                  ? importProgress.percent >= 0
                    ? t('下载中... {{percent}}%', { percent: importProgress.percent })
                    : t('下载中...')
                  : t('解压中...')}
              </span>
              <div className={`home-progress${importProgress.percent < 0 ? ' is-indeterminate' : ''}`}>
                <span style={importProgress.percent >= 0 ? { width: `${importProgress.percent}%` } : undefined} />
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* ── Transfer ── */}
      {transferOpen && transferSource && (
        <Modal
          title={t('模板转换')}
          description={transferSource.name}
          size="lg"
          onClose={() => setTransferOpen(false)}
          closeLabel={t('Close')}
        >
          <TransferPanel
            projectId={transferSource.id}
            onJobUpdate={(job) => {
              setActiveJob({ ...job, sourceName: transferSource.name });
              setJobWidgetOpen(true);
              if (job.status === 'success') loadProjects();
            }}
          />
        </Modal>
      )}

      {/* Floating transfer progress widget */}
      {activeJob && !transferOpen && jobWidgetOpen && (
        <section className="home-job" aria-label={t('模板转换')}>
          <div className="home-job-head">
            <span className="home-job-title op-truncate">{t('模板转换')} · {activeJob.sourceName || ''}</span>
            <IconButton
              icon="maximize"
              label={t('展开')}
              tipPos="left"
              onClick={() => {
                setTransferOpen(true);
                if (transferSource) setTransferSource(transferSource);
              }}
            />
            <IconButton icon="x" label={t('Close')} tipPos="left" onClick={() => setJobWidgetOpen(false)} />
          </div>
          <div className="tp-status" role="status">
            <span>{t('状态')}</span>
            <Badge tone={jobTone} icon={jobRunning ? 'loader' : undefined} spin={jobRunning}>{activeJob.status}</Badge>
          </div>
          {activeJob.error && <p className="home-job-error">{activeJob.error}</p>}
          {activeJob.progressLog.length > 0 && (
            <div className="tp-log">
              {activeJob.progressLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── AI / LLM settings ── */}
      {settingsOpen && (
        <Modal
          title={t('AI settings')}
          description={t('未配置 API Key 时将使用后端环境变量。')}
          onClose={() => { setSettingsForm(loadLLMSettings()); setSettingsOpen(false); }}
          closeLabel={t('Close')}
          footer={
            <>
              <Button variant="secondary" onClick={() => { setSettingsForm(loadLLMSettings()); setSettingsOpen(false); }}>{t('取消')}</Button>
              <Button variant="primary" onClick={() => { saveLLMSettings(settingsForm); setSettingsOpen(false); }}>{t('保存')}</Button>
            </>
          }
        >
          <div className="op-field">
            <label className="op-field-label" htmlFor="llm-endpoint">{t('LLM Endpoint')}</label>
            <input
              id="llm-endpoint"
              className="op-input"
              type="text"
              autoComplete="off"
              placeholder={t('Server default')}
              value={settingsForm.llmEndpoint}
              onChange={(e) => setSettingsForm((p) => ({ ...p, llmEndpoint: e.target.value }))}
            />
          </div>
          <div className="op-field">
            <label className="op-field-label" htmlFor="llm-key">{t('LLM API Key')}</label>
            <input
              id="llm-key"
              className="op-input"
              type="password"
              autoComplete="off"
              placeholder="sk-..."
              value={settingsForm.llmApiKey}
              onChange={(e) => setSettingsForm((p) => ({ ...p, llmApiKey: e.target.value }))}
            />
          </div>
          <div className="op-field">
            <label className="op-field-label" htmlFor="llm-model">{t('LLM Model')}</label>
            <input
              id="llm-model"
              className="op-input"
              type="text"
              autoComplete="off"
              placeholder={t('Server default')}
              value={settingsForm.llmModel}
              onChange={(e) => setSettingsForm((p) => ({ ...p, llmModel: e.target.value }))}
            />
          </div>
        </Modal>
      )}

      {/* ── New workspace ── */}
      {newWorkspaceOpen && (
        <NewWorkspaceModal
          onClose={() => goSection('projects')}
          onCreated={(w) => {
            setStatus(t('Created {{workspace}}', { workspace: w.name }));
            goSection('projects');
          }}
        />
      )}

      {/* ── Destructive confirmation ── */}
      {confirmState && <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />}
    </div>
  );
}
