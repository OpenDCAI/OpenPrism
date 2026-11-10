import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { LogoMark } from './Logo';
import { Avatar, MenuButton } from './ui';
import type { MenuEntry } from './ui';
import { useTheme } from './theme';
import { useWorkspace } from './workspace';

interface AppTopBarProps {
  /** Breadcrumb items rendered after the workspace switcher (project, file…). */
  crumbs?: ReactNode;
  /** Actions rendered before the account menu. */
  actions?: ReactNode;
}

/**
 * Shared top bar: logo · workspace switcher › crumbs ……… actions · account.
 * Every screen uses this so navigation never moves.
 */
export function AppTopBar({ crumbs, actions }: AppTopBarProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const [theme, setTheme] = useTheme();

  const workspaceItems = (): MenuEntry[] => [
    { type: 'label', label: t('Workspaces') },
    ...ws.workspaces.map<MenuEntry>((w) => ({
      label: w.name,
      lead: <Avatar name={w.name} color={w.color} size="sm" square />,
      meta: t(ws.myRole(w)),
      checked: w.id === ws.active.id,
      onSelect: () => {
        ws.setActive(w.id);
        navigate('/projects');
      }
    })),
    { type: 'sep' },
    { label: t('Members'), icon: 'users', onSelect: () => navigate('/projects?section=members') },
    { label: t('Workspace settings'), icon: 'settings', onSelect: () => navigate('/projects?section=settings') },
    { label: t('New workspace…'), icon: 'plus', onSelect: () => navigate('/projects?section=new-workspace') }
  ];

  const accountItems = (): MenuEntry[] => [
    {
      type: 'head',
      content: (
        <>
          <Avatar name={ws.user.name} color={ws.user.color} size="lg" />
          <span style={{ display: 'grid', minWidth: 0 }}>
            <strong className="op-truncate">{ws.user.name}</strong>
            <span className="op-truncate" style={{ color: 'var(--text-3)', fontSize: 'var(--fs-xs)' }}>{ws.guest ? t('Guest') : ws.user.email}</span>
          </span>
        </>
      )
    },
    { type: 'sep' },
    { type: 'label', label: t('Theme') },
    { label: t('Light'), icon: 'sun', checked: theme === 'light', onSelect: () => setTheme('light') },
    { label: t('Dark'), icon: 'moon', checked: theme === 'dark', onSelect: () => setTheme('dark') },
    { label: t('System'), icon: 'monitor', checked: theme === 'system', onSelect: () => setTheme('system') },
    { type: 'label', label: t('Language') },
    { label: 'English', icon: 'languages', checked: i18n.language === 'en-US', onSelect: () => void i18n.changeLanguage('en-US') },
    { label: '中文', icon: 'languages', checked: i18n.language === 'zh-CN', onSelect: () => void i18n.changeLanguage('zh-CN') },
    { type: 'sep' },
    ...(ws.guest
      ? [
          { label: t('Sign in with an account'), icon: 'user', onSelect: () => { ws.signOut(); navigate('/login'); } } as MenuEntry,
          { label: t('Leave shared project'), icon: 'log-out', onSelect: () => { ws.signOut(); navigate('/'); } } as MenuEntry
        ]
      : [
          { label: t('Account settings'), icon: 'user', onSelect: () => navigate('/account') } as MenuEntry,
          ...(ws.openAdmin ? [{ label: t('Admin'), icon: 'settings', onSelect: () => void ws.openAdmin!().catch(() => window.alert(t('Could not open the admin. Try again.'))) } as MenuEntry] : []),
          { label: t('Sign out'), icon: 'log-out', onSelect: () => ws.signOut() } as MenuEntry
        ]),
    { type: 'sep' },
    { type: 'label', label: `OpenPrism ${t('version')} ${__APP_VERSION__}` }
  ];

  return (
    <header className="op-topbar">
      <Link to="/projects" className="op-topbar-brand" aria-label={t('Open Prism — all projects')} data-tip={t('All projects')}>
        <LogoMark size={22} />
      </Link>
      {ws.guest ? (
        <span className="op-crumb">
          <Avatar name={ws.active.name} color={ws.active.color} size="sm" square />
          <span className="op-truncate">{ws.active.name}</span>
        </span>
      ) : (
        <MenuButton className="op-crumb" items={workspaceItems} menuLabel={t('Workspaces')} minWidth={260}>
          <Avatar name={ws.active.name} color={ws.active.color} size="sm" square />
          <span className="op-truncate">{ws.active.name}</span>
          <Icon name="chevrons-up-down" />
        </MenuButton>
      )}
      {crumbs}
      <div className="op-fill" />
      <div className="op-topbar-right">
        {actions}
        <MenuButton className="op-account-btn" items={accountItems} align="end" menuLabel={t('Account')} aria-label={t('Account menu')} minWidth={240}>
          <Avatar name={ws.user.name} color={ws.user.color} size="lg" />
        </MenuButton>
      </div>
    </header>
  );
}

export function CrumbSep({ className = '' }: { className?: string }) {
  return <span className={`op-crumb-sep ${className}`} aria-hidden="true">/</span>;
}
