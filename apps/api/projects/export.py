"""Export a project as one zip file (#162): every file at its project path, empty folders as directory entries.

The zip is built in a temporary file, one file at a time, so memory stays bounded however large the project is; the view
streams that file in chunks. Live-editing text is flushed to the database first, so the zip is what the editors see."""
import re
import tempfile
import zipfile

from . import storage
from .models import ProjectFile

# Already compressed: storing them beats spending CPU to deflate them again.
STORED = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.mp3', '.mp4', '.mov',
          '.woff', '.woff2')


class ExportTooLarge(ValueError):
    """A message that is safe to show to the user."""


def archive_name(project):
    """The download's file name: the project name, safe on every system, plus .zip."""
    name = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]+', ' ', project.name or '')
    name = re.sub(r'\s+', ' ', name).strip(' .')[:120]
    return f'{name or "project"}.zip'


def survey(project):
    """(file count, bytes) of what an export would hold: text as UTF-8, binaries by size. Folders do not count."""
    count = total = 0
    for kind, size, content in project.files.values_list('kind', 'size', 'content'):
        if kind == ProjectFile.DIR:
            continue
        count += 1
        total += len(content.encode('utf-8')) if kind == ProjectFile.TEXT else (size or 0)
    return count, total


def _flush_live_text(project):
    from collab.views import flush_room, live_room
    for path in list(project.files.filter(kind=ProjectFile.TEXT).values_list('path', flat=True)):
        if live_room(project, path):
            flush_room(project, path)


def build(project, max_bytes):
    """A zip of the project in an anonymous temporary file, rewound to the start: (file object, size in bytes).
    Raises ExportTooLarge before reading any binary. The caller closes the file (which deletes it)."""
    _, total = survey(project)
    if total > max_bytes:
        raise ExportTooLarge(f'This project is too large to export as one file ({total // (1024 * 1024)} MB; the limit is '
                             f'{max_bytes // (1024 * 1024)} MB). Download parts of it from the editor instead.')
    _flush_live_text(project)
    tmp = tempfile.TemporaryFile()
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for row in project.files.order_by('path').iterator():
                if row.kind == ProjectFile.DIR:
                    zf.writestr(row.path.rstrip('/') + '/', b'')
                    continue
                data = row.content.encode('utf-8') if row.kind == ProjectFile.TEXT else storage.get_bytes(row.s3_key)
                kind = zipfile.ZIP_STORED if row.path.lower().endswith(STORED) else zipfile.ZIP_DEFLATED
                info = zipfile.ZipInfo(row.path, date_time=max(row.updated_at.timetuple()[:6], (1980, 1, 1, 0, 0, 0)))
                info.compress_type = kind
                info.external_attr = 0o644 << 16
                zf.writestr(info, data)
        size = tmp.tell()
        tmp.seek(0)
        return tmp, size
    except BaseException:
        tmp.close()
        raise
