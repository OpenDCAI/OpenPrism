"""Finding a comment's text again after the file changed.

A thread stores its quote, up to CONTEXT characters before and after it, and the offsets it had. If the text at the
stored offsets is still the quote, nothing moved. Otherwise every occurrence of the quote is scored by how much of the
stored context still surrounds it (ties go to the one nearest the old position). No occurrence: the thread is orphaned.
The editor runs the same algorithm on its live document (apps/frontend/src/app/commentAnchor.ts)."""
CONTEXT = 32


def _common_suffix(a, b):
    n = 0
    while n < len(a) and n < len(b) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def _common_prefix(a, b):
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def context_of(text, start, end):
    return text[max(0, start - CONTEXT):start], text[end:end + CONTEXT]


def locate(text, quote, prefix, suffix, hint):
    """Return (from, to) of the quote in `text`, or None."""
    if not quote:
        return None
    if text[hint:hint + len(quote)] == quote:
        return hint, hint + len(quote)
    best, best_score = None, None
    start = text.find(quote)
    while start != -1:
        before, after = context_of(text, start, start + len(quote))
        score = (_common_suffix(before, prefix) + _common_prefix(after, suffix), -abs(start - hint))
        if best_score is None or score > best_score:
            best, best_score = start, score
        start = text.find(quote, start + 1)
    return None if best is None else (best, best + len(quote))
