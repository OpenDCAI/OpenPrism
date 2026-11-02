"""Handling of BibTeX that came from Zotero. It is untrusted input that ends up in a file fed to bibtex/biber in the
compile worker, so only well-formed, size-limited regular entries are ever written (no @preamble/@string/@comment)."""
import re
import unicodedata

MAX_ENTRY_CHARS = 20000
KEY_RE = re.compile(r'^[A-Za-z0-9_:.+\-/]{1,100}$')
FORBIDDEN_TYPES = {'string', 'preamble', 'comment'}
CONTROL_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
HEAD_RE = re.compile(r'^@([A-Za-z]+)\s*\{\s*([^,\s{}]*)\s*,', re.S)
MARKER_RE = re.compile(r'^%[ \t]*zotero:[ \t]*(\S+)[ \t]*\r?\n[ \t]*@[A-Za-z]+[ \t]*\{[ \t]*([^,\s{}]+)[ \t]*,', re.M)
KEYS_IN_FILE_RE = re.compile(r'^[ \t]*@[A-Za-z]+[ \t]*\{[ \t]*([^,\s{}]+)[ \t]*,', re.M)


class BibError(ValueError):
    pass


def parse_single_entry(text):
    """The one `@type{key, ...}` in `text`, validated; returns (entry_text, entry_type, key). Raises BibError."""
    text = (text or '').strip()
    if not text:
        raise BibError('Zotero returned no BibTeX for this item.')
    if CONTROL_RE.search(text):
        raise BibError('The BibTeX contains control characters.')
    if len(text) > MAX_ENTRY_CHARS:
        raise BibError('The BibTeX entry is too large.')
    head = HEAD_RE.match(text)
    if not head:
        raise BibError('The BibTeX is not a regular entry.')
    if head.group(1).lower() in FORBIDDEN_TYPES:
        raise BibError(f'@{head.group(1)} blocks are not allowed.')
    depth, opened = 0, False
    for i, ch in enumerate(text):  # BibTeX counts every brace, escaped or not
        depth += (ch == '{') - (ch == '}')
        opened = opened or depth > 0
        if opened and depth == 0:
            end = i
            break
        if depth < 0:
            raise BibError('The BibTeX has unbalanced braces.')
    else:
        raise BibError('The BibTeX has unbalanced braces.')
    if text[end + 1:].strip():
        raise BibError('The BibTeX has text after the entry.')
    return text[:end + 1], head.group(1), head.group(2)


def with_key(entry, key):
    return HEAD_RE.sub(lambda m: m.group(0)[:m.start(2) - m.start()] + key + m.group(0)[m.end(2) - m.start():], entry, 1)


def _ascii(word):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', word).encode('ascii', 'ignore').decode().lower())


STOP = {'a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with'}


def generate_key(data):
    """lastname + year + first significant title word, e.g. lovelace2020attention."""
    creators = data.get('creators') or []
    first = creators[0] if creators and isinstance(creators[0], dict) else {}
    name = _ascii(str(first.get('lastName') or first.get('name') or '').split(' ')[-1]) or 'ref'
    m = re.search(r'(\d{4})', str(data.get('date') or ''))
    words = [w for w in (_ascii(w) for w in str(data.get('title') or '').split()) if w and w not in STOP]
    return name + (m.group(1) if m else '') + (words[0] if words else '')


def unique_key(base, taken):
    base = base or 'ref'
    if base not in taken:
        return base
    for suffix in [*'abcdefghijklmnopqrstuvwxyz', *map(str, range(2, 1000))]:
        if base + suffix not in taken:
            return base + suffix
    raise BibError('Could not find a free citation key.')


def existing(text):
    """({marker -> cite key} for entries we added before, {all cite keys in the file})."""
    return dict(MARKER_RE.findall(text)), {k for k in KEYS_IN_FILE_RE.findall(text)}


def marker(library, item_key):
    return f'% zotero: {library}:{item_key}'
