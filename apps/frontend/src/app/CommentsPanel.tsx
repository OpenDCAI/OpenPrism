import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, EmptyState, FieldError, IconButton, SegmentedControl } from '@design';
import type { CommentMeta, CommentThreadMeta } from '../api/client';

/** A selection the user asked to comment on, captured when they pressed Comment. */
export interface PendingComment {
  path: string;
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
}

interface CommentsPanelProps {
  threads: CommentThreadMeta[];
  activePath: string;
  canComment: boolean;
  canModerate: boolean;
  pending: PendingComment | null;
  /** The thread to bring into view (clicked in the editor). */
  focusedId: string | null;
  error: string;
  onCreate: (pending: PendingComment, body: string) => Promise<void>;
  onCancelPending: () => void;
  onReply: (threadId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onEditComment: (threadId: string, commentId: string, body: string) => Promise<void>;
  onDeleteComment: (threadId: string, commentId: string) => Promise<void>;
  /** Put the caret on a thread's text. */
  onJump: (thread: CommentThreadMeta) => void;
}

const when = (iso: string) => new Date(iso).toLocaleString();

function Composer({ label, submitLabel, initial = '', onSubmit, onCancel }: {
  label: string; submitLabel: string; initial?: string; onSubmit: (body: string) => Promise<void>; onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(body.trim());
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-composer">
      <textarea
        className="op-textarea"
        aria-label={label}
        placeholder={label}
        rows={2}
        value={body}
        autoFocus={Boolean(initial) || Boolean(onCancel)}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <FieldError message={error || null} />
      <div className="comment-actions">
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>}
        <Button size="sm" variant="primary" loading={busy} disabled={!body.trim()} onClick={() => void send()}>{submitLabel}</Button>
      </div>
    </div>
  );
}

function CommentItem({ comment, canEdit, canDelete, onEdit, onDelete }: {
  comment: CommentMeta; canEdit: boolean; canDelete: boolean; onEdit: (body: string) => Promise<void>; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  return (
    <li className="comment-item">
      <div className="comment-head">
        <strong className="op-truncate">{comment.author}</strong>
        {comment.guest && <Badge tone="neutral">{t('Guest')}</Badge>}
        <span className="op-fill" />
        {canEdit && !editing && <IconButton icon="pencil" label={t('Edit comment')} size="sm" tipPos="left" onClick={() => setEditing(true)} />}
        {canDelete && <IconButton icon="trash" label={t('Delete comment')} size="sm" tipPos="left" onClick={onDelete} />}
      </div>
      <span className="comment-when">{when(comment.createdAt)}{comment.editedAt ? ` · ${t('edited')}` : ''}</span>
      {editing ? (
        <Composer label={t('Edit comment')} submitLabel={t('Save')} initial={comment.body}
          onSubmit={async (body) => { await onEdit(body); setEditing(false); }} onCancel={() => setEditing(false)} />
      ) : (
        <p className="comment-body">{comment.body}</p>
      )}
    </li>
  );
}

function Thread({ thread, props }: { thread: CommentThreadMeta; props: CommentsPanelProps }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const focused = props.focusedId === thread.id;
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  const starter = thread.comments[0];
  const canDeleteThread = props.canModerate || (props.canComment && Boolean(starter?.mine));
  return (
    <article ref={ref} className={`comment-thread${focused ? ' is-focused' : ''}${thread.resolved ? ' is-resolved' : ''}`}
      data-testid="comment-thread" aria-label={t('Comment on “{{quote}}”', { quote: thread.quote.slice(0, 60) })}>
      <div className="comment-thread-head">
        <button type="button" className="comment-quote" onClick={() => props.onJump(thread)} disabled={thread.orphaned}
          title={thread.orphaned ? t('The commented text is no longer in the file.') : t('Show in the editor')}>
          “{thread.quote.length > 120 ? `${thread.quote.slice(0, 120)}…` : thread.quote}”
        </button>
        {thread.orphaned && <Badge tone="warning">{t('Text no longer found')}</Badge>}
        {thread.resolved && <Badge tone="success">{t('Resolved')}</Badge>}
      </div>
      <ul className="comment-list">
        {thread.comments.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            canEdit={props.canComment && c.mine}
            canDelete={(props.canComment && c.mine) || props.canModerate}
            onEdit={(body) => props.onEditComment(thread.id, c.id, body)}
            onDelete={() => void props.onDeleteComment(thread.id, c.id)}
          />
        ))}
      </ul>
      {props.canComment && !thread.resolved && (
        <Composer label={t('Reply')} submitLabel={t('Reply')} onSubmit={(body) => props.onReply(thread.id, body)} />
      )}
      {(props.canComment || canDeleteThread) && (
        <div className="comment-actions">
          {props.canComment && (
            <Button size="sm" variant="secondary" onClick={() => void props.onResolve(thread.id, !thread.resolved)}>
              {thread.resolved ? t('Reopen') : t('Resolve')}
            </Button>
          )}
          {canDeleteThread && <Button size="sm" variant="ghost" onClick={() => void props.onDeleteThread(thread.id)}>{t('Delete thread')}</Button>}
        </div>
      )}
    </article>
  );
}

/** Right-rail Comments tool: threads of the open file (or the whole project), new comment composer, replies. */
export default function CommentsPanel(props: CommentsPanelProps) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<'file' | 'project'>('file');
  const [showResolved, setShowResolved] = useState(false);
  const inScope = props.threads.filter((th) => scope === 'project' || th.path === props.activePath);
  const open = inScope.filter((th) => !th.resolved);
  const resolved = inScope.filter((th) => th.resolved);
  const byPath = (list: CommentThreadMeta[]) => list.reduce<Record<string, CommentThreadMeta[]>>((acc, th) => {
    (acc[th.path] ||= []).push(th);
    return acc;
  }, {});

  const renderList = (list: CommentThreadMeta[]) =>
    scope === 'project'
      ? Object.entries(byPath(list)).map(([path, items]) => (
          <section key={path} className="comment-file">
            <h3 className="comment-file-name">{path}</h3>
            {items.map((th) => <Thread key={th.id} thread={th} props={props} />)}
          </section>
        ))
      : list.map((th) => <Thread key={th.id} thread={th} props={props} />);

  return (
    <div className="comments-panel" data-testid="comments-panel">
      <SegmentedControl
        block
        label={t('Show comments for')}
        value={scope}
        onChange={setScope}
        options={[{ value: 'file', label: t('This file') }, { value: 'project', label: t('Whole project') }]}
      />
      {props.error && <FieldError message={props.error} />}
      {props.pending && (
        <div className="comment-thread is-new">
          <div className="comment-quote">“{props.pending.quote.length > 120 ? `${props.pending.quote.slice(0, 120)}…` : props.pending.quote}”</div>
          <Composer label={t('Add a comment')} submitLabel={t('Comment')}
            onSubmit={(body) => props.onCreate(props.pending!, body)} onCancel={props.onCancelPending} />
        </div>
      )}
      {open.length === 0 && !props.pending && (
        <EmptyState icon="comment" title={t('No open comments')}>
          {props.canComment ? t('Select text and press Comment (Ctrl/Cmd+Alt+M) to start a discussion.') : t('Comments people leave on this project appear here.')}
        </EmptyState>
      )}
      {renderList(open)}
      {resolved.length > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? t('Hide resolved ({{count}})', { count: resolved.length }) : t('Show resolved ({{count}})', { count: resolved.length })}
        </Button>
      )}
      {showResolved && renderList(resolved)}
    </div>
  );
}
