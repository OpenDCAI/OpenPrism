import { diffArrays } from 'diff';

interface Region {
  start: number;
  end: number;
  lines: string[];
  mine: boolean;
}

/** The line ranges of `base` that `other` replaces (an insertion is a range with start === end). */
function regions(base: string[], other: string[], mine: boolean): Region[] {
  const out: Region[] = [];
  let pos = 0;
  let open: Region | null = null;
  for (const part of diffArrays(base, other)) {
    if (!part.added && !part.removed) {
      open = null;
      pos += part.count ?? part.value.length;
      continue;
    }
    if (!open) {
      open = { start: pos, end: pos, lines: [], mine };
      out.push(open);
    }
    if (part.removed) {
      open.end += part.count ?? part.value.length;
      pos += part.count ?? part.value.length;
    } else {
      open.lines.push(...part.value);
    }
  }
  return out;
}

const collide = (a: Region, b: Region) => {
  if (a.start < b.end && b.start < a.end) return true; // the same lines
  if (a.start === a.end && b.start === b.end) return a.start === b.start; // two insertions at one point
  const [ins, other] = a.start === a.end ? [a, b] : b.start === b.end ? [b, a] : [null, null];
  return Boolean(ins && other && other.start < ins.start && ins.start < other.end); // an insertion inside replaced lines
};

/**
 * Combine two edits of `base` line by line: `mine` (what the file is now) and `theirs` (what was proposed).
 * Returns the merged text, or null when the edits touch the same lines (the proposal is stale).
 */
export function merge3(base: string, mine: string, theirs: string): string | null {
  const baseLines = base.split('\n');
  const all = [...regions(baseLines, mine.split('\n'), true), ...regions(baseLines, theirs.split('\n'), false)];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (all[i].mine !== all[j].mine && collide(all[i], all[j])) return null;
    }
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let pos = 0;
  for (const region of all) {
    out.push(...baseLines.slice(pos, region.start), ...region.lines);
    pos = region.end;
  }
  out.push(...baseLines.slice(pos));
  return out.join('\n');
}
