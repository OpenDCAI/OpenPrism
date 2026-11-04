import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import type { IconName } from './Icon';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* =====================================================================
   Button
   ===================================================================== */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Trailing icon, e.g. a chevron. */
  iconEnd?: IconName;
  loading?: boolean;
  block?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', icon, iconEnd, loading, block, className, children, type = 'button', disabled, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('op-btn', `op-btn-${variant}`, size !== 'md' && `op-btn-${size}`, block && 'op-btn-block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Icon name="loader" className="op-spin" /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconEnd && <Icon name={iconEnd} />}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required accessible name; also used as the tooltip unless `tip` is false. */
  label: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  tip?: boolean;
  tipPos?: 'right' | 'left' | 'bottom-end';
}

export function IconButton({ icon, label, size = 'sm', variant = 'ghost', tip = true, tipPos, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('op-btn', `op-btn-${variant}`, 'op-btn-icon', size !== 'md' && `op-btn-${size}`, className)}
      aria-label={label}
      data-tip={tip ? label : undefined}
      data-tip-pos={tipPos}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

/* =====================================================================
   Badge / Tag / Avatar
   ===================================================================== */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

export function Badge({ tone = 'neutral', icon, spin, children, className }: { tone?: BadgeTone; icon?: IconName; spin?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cx('op-badge', tone !== 'neutral' && `op-badge-${tone}`, className)}>
      {icon && <Icon name={icon} className={spin ? 'op-spin' : ''} />}
      {children}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="op-tag">{children}</span>;
}

export const initialsOf = (name: string) =>
  name
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export function Avatar({ name, color, size, square, online }: { name: string; color?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; square?: boolean; online?: boolean }) {
  return (
    <span
      className={cx('op-avatar', size && size !== 'md' && `op-avatar-${size}`, square && 'op-avatar-square')}
      style={{ ['--av' as string]: color || '#5b6573' }}
      role="img"
      aria-label={name}
      title={name}
      data-online={online ? 'true' : undefined}
    >
      {initialsOf(name)}
    </span>
  );
}

/* =====================================================================
   Menu (portal, fixed-positioned, keyboard navigable)
   ===================================================================== */
export type MenuEntry =
  | {
      type?: 'item';
      label: string;
      icon?: IconName;
      lead?: ReactNode;
      meta?: string;
      kbd?: string;
      /** Defined → rendered as a radio/checkbox item with a check mark. */
      checked?: boolean;
      checkbox?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: 'sep' }
  | { type: 'label'; label: string }
  | { type: 'head'; content: ReactNode };

export interface MenuProps {
  items: MenuEntry[];
  onClose: (restoreFocus: boolean) => void;
  /** Element the menu hangs from. */
  anchor?: HTMLElement | null;
  /** Viewport point (context menus). */
  point?: { x: number; y: number };
  align?: 'start' | 'end';
  label?: string;
  minWidth?: number;
}

export function Menu({ items, onClose, anchor, point, align = 'start', label, minWidth }: MenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor?.getBoundingClientRect();
    if (!r) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
    setPos({ left, top });
  }, [anchor, point, align]);

  // Keep the latest onClose without re-running effects (callers often pass inline arrows).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('.op-menu-item:not(:disabled)');
    const checked = ref.current?.querySelector<HTMLButtonElement>('.op-menu-item[aria-checked="true"]:not(:disabled)');
    (checked || first)?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onCloseRef.current(false);
    };
    const onResize = () => onCloseRef.current(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.op-menu-item:not(:disabled)') || []);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCloseRef.current(true); }
    else if (e.key === 'Tab') { onCloseRef.current(false); }
  };

  return createPortal(
    <div
      ref={ref}
      className="op-menu"
      role="menu"
      aria-label={label}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, minWidth }}
      onKeyDown={onKeyDown}
    >
      {items.map((it, idx) => {
        if (it.type === 'sep') return <hr key={idx} className="op-menu-sep" />;
        if (it.type === 'label') return <span key={idx} className="op-menu-label">{it.label}</span>;
        if (it.type === 'head') return <div key={idx} className="op-menu-head">{it.content}</div>;
        const radio = it.checked !== undefined;
        return (
          <button
            key={idx}
            type="button"
            role={radio ? (it.checkbox ? 'menuitemcheckbox' : 'menuitemradio') : 'menuitem'}
            aria-checked={radio ? Boolean(it.checked) : undefined}
            className={cx('op-menu-item', it.danger && 'is-danger')}
            disabled={it.disabled}
            onClick={() => {
              onCloseRef.current(true);
              it.onSelect();
            }}
          >
            {it.lead ?? (it.icon ? <Icon name={it.icon} /> : null)}
            <span className="op-menu-text">{it.label}</span>
            {it.meta && <span className="op-menu-meta">{it.meta}</span>}
            {it.kbd && <span className="op-menu-meta"><kbd>{it.kbd}</kbd></span>}
            {radio && <Icon name="check" className="op-menu-check" />}
          </button>
        );
      })}
    </div>,
    document.body
  );
}

/** State helper for anything that opens a Menu from a trigger button. */
export function useMenuState() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const toggle = useCallback((el: HTMLElement) => setAnchor((prev) => (prev === el ? null : el)), []);
  const close = useCallback((restore: boolean) => {
    setAnchor((prev) => {
      if (restore && prev?.isConnected) prev.focus();
      return null;
    });
  }, []);
  return { anchor, open: Boolean(anchor), toggle, close };
}

export interface MenuButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  items: MenuEntry[] | (() => MenuEntry[]);
  children: ReactNode;
  align?: 'start' | 'end';
  menuLabel?: string;
  minWidth?: number;
}

/** A button that opens a Menu. Style it with `className` (op-btn, op-crumb, …). */
export function MenuButton({ items, children, align, menuLabel, minWidth, className, onClick, ...rest }: MenuButtonProps) {
  const m = useMenuState();
  return (
    <>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={m.open}
        onClick={(e) => {
          onClick?.(e);
          m.toggle(e.currentTarget);
        }}
        {...rest}
      >
        {children}
      </button>
      {m.open && (
        <Menu items={typeof items === 'function' ? items() : items} anchor={m.anchor} onClose={m.close} align={align} label={menuLabel} minWidth={minWidth} />
      )}
    </>
  );
}

/* =====================================================================
   Select — replaces the old ios-select / ios-dropdown pair
   ===================================================================== */
export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  meta?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  size?: 'sm' | 'md';
  ghost?: boolean;
  disabled?: boolean;
  /** Required when there is no visible <label> pointing at the control. */
  ariaLabel?: string;
  id?: string;
  className?: string;
  icon?: IconName;
}

export function Select<T extends string = string>({ value, options, onChange, placeholder, size = 'md', ghost, disabled, ariaLabel, id, className, icon }: SelectProps<T>) {
  const m = useMenuState();
  const current = options.find((o) => o.value === value);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={cx('op-select', size === 'sm' && 'op-select-sm', ghost && 'op-select-ghost', className)}
        aria-haspopup="listbox"
        aria-expanded={m.open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={(e) => m.toggle(e.currentTarget)}
      >
        {icon && <Icon name={icon} />}
        <span className="op-truncate op-fill">{current?.label ?? placeholder ?? ''}</span>
        <Icon name="chevron-down" />
      </button>
      {m.open && (
        <Menu
          anchor={m.anchor}
          onClose={m.close}
          label={ariaLabel}
          minWidth={triggerRef.current?.offsetWidth}
          items={options.map((o) => ({
            label: o.label,
            meta: o.meta,
            checked: o.value === value,
            disabled: o.disabled,
            onSelect: () => onChange(o.value)
          }))}
        />
      )}
    </>
  );
}

/* =====================================================================
   Segmented control
   ===================================================================== */
export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** Hide the text label (icon-only) — label is still used as the accessible name. */
  iconOnly?: boolean;
}

export function SegmentedControl<T extends string = string>({ value, options, onChange, label, block, className }: { value: T; options: SegmentOption<T>[]; onChange: (v: T) => void; label: string; block?: boolean; className?: string }) {
  return (
    <div className={cx('op-seg', block && 'op-seg-block', className)} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          aria-label={o.iconOnly ? o.label : undefined}
          data-tip={o.iconOnly ? o.label : undefined}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {!o.iconOnly && <span className="op-truncate">{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

/* =====================================================================
   Modal
   ===================================================================== */
export interface ModalProps {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
  closeLabel?: string;
}

export function Modal({ title, description, onClose, children, footer, size = 'md', closeLabel = 'Close' }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId(); // the title names the dialog for screen readers (and getByRole('dialog', { name }))
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-modal-close])');
    (first || ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <div className="op-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={cx('op-modal', size !== 'md' && `op-modal-${size}`)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="op-modal-header">
          <div className="op-modal-heading">
            <span className="op-modal-title" id={titleId}>{title}</span>
            {description && <span className="op-modal-desc">{description}</span>}
          </div>
          <IconButton icon="x" label={closeLabel} tip={false} data-modal-close onClick={onClose} />
        </div>
        <div className="op-modal-body">{children}</div>
        {footer && <div className="op-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* =====================================================================
   Panel header / empty state
   ===================================================================== */
export function PanelHeader({ title, actions, onCollapse, collapseLabel = 'Collapse panel', side = 'left' }: { title: ReactNode; actions?: ReactNode; onCollapse?: () => void; collapseLabel?: string; side?: 'left' | 'right' }) {
  return (
    <div className="op-panel-header">
      <span className="op-panel-title">{title}</span>
      <div className="op-panel-actions">
        {actions}
        {onCollapse && <IconButton icon={side === 'left' ? 'panel-left' : 'panel-right'} label={collapseLabel} tipPos={side === 'right' ? 'bottom-end' : undefined} onClick={onCollapse} />}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="op-empty">
      <Icon name={icon} />
      <span className="op-empty-title">{title}</span>
      {children && <span className="op-empty-msg">{children}</span>}
      {action}
    </div>
  );
}


/* =====================================================================
   FieldError — inline validation message under a form field
   ===================================================================== */
export function FieldError({ id, message }: { id?: string; message: string | null | undefined }) {
  if (!message) return null;
  return (
    <span className="op-field-error" id={id} role="alert">
      <Icon name="alert-circle" />
      <span>{message}</span>
    </span>
  );
}
