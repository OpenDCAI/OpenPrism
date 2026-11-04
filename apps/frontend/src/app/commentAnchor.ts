/**
 * Finding a comment's text in the live document. The same algorithm as the server's comments/anchor.py: keep the stored
 * offsets if the quote is still there, otherwise score every occurrence of the quote by how much of the stored context
 * surrounds it (ties go to the nearest), otherwise the thread is orphaned (null).
 */
export const CONTEXT = 32;

function commonSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

export function contextOf(text: string, from: number, to: number) {
  return { prefix: text.slice(Math.max(0, from - CONTEXT), from), suffix: text.slice(to, to + CONTEXT) };
}

export function locate(text: string, quote: string, prefix: string, suffix: string, hint: number): { from: number; to: number } | null {
  if (!quote) return null;
  if (text.slice(hint, hint + quote.length) === quote) return { from: hint, to: hint + quote.length };
  let best = -1;
  let bestScore: [number, number] | null = null;
  for (let start = text.indexOf(quote); start !== -1; start = text.indexOf(quote, start + 1)) {
    const ctx = contextOf(text, start, start + quote.length);
    const score: [number, number] = [commonSuffix(ctx.prefix, prefix) + commonPrefix(ctx.suffix, suffix), -Math.abs(start - hint)];
    if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = start;
      bestScore = score;
    }
  }
  return best === -1 ? null : { from: best, to: best + quote.length };
}
