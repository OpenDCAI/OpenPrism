import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, FieldError, Icon } from '@design';

const RECENT_KEY = 'openprism-ai-recent-v1';
const RECENT_MAX = 20;

function loadRecent(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(prompt: string) {
  try {
    const next = [prompt, ...loadRecent().filter((x) => x !== prompt)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: recall just starts empty */
  }
}

interface AiCommandBarProps {
  /** Run the request; resolves when the proposal is ready (or failed, in which case `error` is set by the caller). */
  onSubmit: (prompt: string) => void;
  /** Stop waiting for a running request. */
  onCancel: () => void;
  /** Close the bar (focus goes back to the editor). */
  onClose: () => void;
  busy: boolean;
  /** Progress text while running. */
  progress: string;
  error: string;
  hasSelection: boolean;
  /** Shown after a request produced a proposal to review. */
  note: string;
}

/** The in-place AI request bar: one line, Enter to send, Esc to close, Up/Down to recall earlier requests. */
export default function AiCommandBar({ onSubmit, onCancel, onClose, busy, progress, error, hasSelection, note }: AiCommandBarProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [recall, setRecall] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) input.current?.focus(); // a disabled input loses focus, so take it back when the request ends
  }, [busy]);

  const send = () => {
    const prompt = value.trim();
    if (!prompt || busy) return;
    remember(prompt);
    setRecall(-1);
    onSubmit(prompt);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return; // IME composition: Enter/Esc belong to the IME
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (busy) onCancel();
      else onClose();
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !busy && (value === '' || recall >= 0)) {
      const recent = loadRecent();
      const next = Math.min(Math.max(recall + (event.key === 'ArrowUp' ? 1 : -1), -1), recent.length - 1);
      if (event.key === 'ArrowUp' && recent.length === 0) return;
      event.preventDefault();
      setRecall(next);
      setValue(next < 0 ? '' : recent[next]);
    }
  };

  return (
    <div className="ai-bar" role="dialog" aria-label={t('Ask AI')}>
      <div className="ai-bar-row">
        <Icon name="sparkles" className="ai-bar-icon" />
        <input
          ref={input}
          className="op-input ai-bar-input"
          value={value}
          disabled={busy}
          placeholder={hasSelection ? t('What should change in the selection?') : t('Ask AI to edit here: add an author, a related work section, turn a list into a table…')}
          aria-label={t('Ask AI')}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setRecall(-1);
          }}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <Button variant="secondary" size="sm" onClick={onCancel}>{t('Cancel')}</Button>
        ) : (
          <Button variant="primary" size="sm" icon="send" onClick={send} disabled={!value.trim()}>{t('Send')}</Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('Close')}>
          <Icon name="x" />
        </Button>
      </div>
      {busy && (
        <div className="ai-bar-status" role="status">
          <span className="spinner" />
          {progress || t('Working…')}
        </div>
      )}
      {!busy && note && <div className="ai-bar-status" role="status">{note}</div>}
      {error && <FieldError message={error} />}
    </div>
  );
}
