"""Template files live in S3 under templates/<id>/<path>; metadata lives in the Template table."""
import posixpath
import re

from django.conf import settings

from projects import files as project_files
from projects import storage
from projects.paths import is_text_file, safe_path

from .models import Template

ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


def detect_main_file(paths, read_text):
    """The file a template should compile: `main.tex`, else the first root-level .tex with a \\documentclass.

    `paths` are the template's file paths and `read_text(path)` returns a file's text. None if nothing qualifies.
    """
    if 'main.tex' in paths:
        return 'main.tex'
    for path in sorted(p for p in paths if '/' not in p and p.lower().endswith('.tex')):
        if '\\documentclass' in read_text(path):
            return path
    return None


def meta(t):
    """Shape of an entry in templates/manifest.json."""
    return {
        'id': t.id, 'label': t.label, 'mainFile': t.main_file, 'category': t.category,
        'description': t.description, 'descriptionEn': t.description_en, 'tags': t.tags,
        'author': t.author, 'featured': t.featured,
    }


def list_paths(template):
    paginator = storage.get_client().get_paginator('list_objects_v2')
    prefix = template.s3_prefix
    for page in paginator.paginate(Bucket=settings.S3_BUCKET, Prefix=prefix):
        for obj in page.get('Contents', []):
            yield obj['Key'][len(prefix):]


def read(template, path):
    return storage.get_bytes(template.s3_prefix + safe_path(path))


def write(template, path, data):
    storage.put_bytes(template.s3_prefix + safe_path(path), data)


def clear(template):
    storage.delete_prefix(template.s3_prefix)


def copy_into_project(template, project):
    """Create a project's initial files from a template (overwrites existing paths)."""
    for path in list_paths(template):
        project_files.write_file(project, path, read(template, path))


def merge_into_project(template, project):
    """Port of copyTemplateIntoProject: skip main.tex; keep existing .tex files, overwrite other types."""
    changed = []
    for path in list_paths(template):
        if posixpath.basename(path) == 'main.tex':
            continue
        ext = posixpath.splitext(path)[1].lower()
        exists = project.files.filter(path=path).exists()
        if exists and not (ext and ext != '.tex'):
            continue
        project_files.write_file(project, path, read(template, path))
        changed.append(path)
    return changed


def is_text(path):
    return is_text_file(path)
