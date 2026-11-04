import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

export interface CommentMark {
  id: string;
  from: number;
  to: number;
}

/** Replace the commented ranges drawn in the editor. */
export const setCommentMarks = StateEffect.define<CommentMark[]>();

/**
 * Highlights of commented text. The set is mapped through every edit, so typing above or inside a range keeps the
 * highlight on the same words until the next refresh places the threads again (commentAnchor.locate).
 */
export const commentMarksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCommentMarks)) {
        const ranges = effect.value
          .filter((m) => m.to > m.from && m.to <= tr.state.doc.length)
          .sort((a, b) => a.from - b.from)
          .map((m) => Decoration.mark({ class: 'cm-comment-range', attributes: { 'data-thread': m.id } }).range(m.from, m.to));
        marks = Decoration.set(ranges, true);
      }
    }
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field)
});

/** Clicking highlighted text opens its thread. */
export function commentClicks(onOpen: (threadId: string) => void) {
  return EditorView.domEventHandlers({
    click(event) {
      const el = (event.target as HTMLElement | null)?.closest?.('.cm-comment-range');
      const id = el?.getAttribute('data-thread');
      if (id) onOpen(id);
      return false; // let the caret move as usual
    }
  });
}
