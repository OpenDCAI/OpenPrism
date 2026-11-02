"""Load the Node backend's filesystem data (templates/ and data/<id>/) into Postgres and Garage."""
import json
import mimetypes
from datetime import datetime, timezone
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from projects import files
from projects.models import Membership, Project, Workspace
from projects.paths import safe_path
from templates_app import service as templates
from templates_app.models import Template

# Transfer/compile scratch output that the Node backend left inside project directories.
SKIP_TOP_LEVEL = {'project.json', '.compile', '.agent_runs', '_mineru_input', '_mineru_output', '__arxiv_source.tar.gz'}


def parse_time(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)


def walk(root):
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if rel.parts[0] in SKIP_TOP_LEVEL:
            continue
        yield path, rel.as_posix()


class Command(BaseCommand):
    help = 'Import legacy templates and projects from the Node backend data directories (idempotent).'

    def add_arguments(self, parser):
        parser.add_argument('--templates-dir', default='/legacy/templates')
        parser.add_argument('--data-dir', default='/legacy/data')
        parser.add_argument('--owner', help='Email of the user who will own imported projects')
        parser.add_argument('--skip-projects', action='store_true')
        parser.add_argument('--skip-templates', action='store_true')

    def handle(self, *a, templates_dir, data_dir, owner, skip_projects, skip_templates, **opts):
        if not skip_templates:
            self.import_templates(Path(templates_dir))
        if not skip_projects:
            if not owner:
                raise CommandError('--owner EMAIL is required to import projects')
            self.import_projects(Path(data_dir), owner)

    def import_templates(self, root):
        manifest_path = root / 'manifest.json'
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        known = {t['id']: t for t in manifest.get('templates', [])}
        for d in sorted(p for p in root.iterdir() if p.is_dir() and p.name != 'node_modules'):
            entry = known.get(d.name)
            if entry is None and not any(f.suffix == '.tex' for f in d.iterdir()):
                continue
            entry = entry or {'id': d.name, 'label': d.name}
            contents = {rel: path for path, rel in walk_all(d)}
            declared = entry.get('mainFile')
            main_file = declared if declared in contents else templates.detect_main_file(
                contents, lambda rel: contents[rel].read_text(errors='replace')) or declared or 'main.tex'
            if declared and main_file != declared:
                self.stdout.write(f'template {d.name}: mainFile {declared!r} not found, using {main_file!r}')
            tpl, _ = Template.objects.update_or_create(id=d.name, defaults={
                'label': entry.get('label', d.name), 'main_file': main_file,
                'category': entry.get('category', 'academic'), 'description': entry.get('description', d.name),
                'description_en': entry.get('descriptionEn', d.name), 'tags': entry.get('tags', []),
                'author': entry.get('author', ''), 'featured': entry.get('featured', False), 'builtin': d.name in known,
            })
            templates.clear(tpl)
            n = 0
            for rel, path in contents.items():
                templates.write(tpl, rel, path.read_bytes())
                n += 1
            self.stdout.write(f'template {tpl.id}: {n} files')

    def import_projects(self, root, owner_email):
        user = get_user_model().objects.filter(email=owner_email.lower()).first()
        if not user:
            raise CommandError(f'No user with email {owner_email}; register first')
        membership = Membership.objects.filter(user=user, role=Membership.OWNER).select_related('workspace').first()
        workspace = membership.workspace if membership else Workspace.objects.create(name=f'{owner_email} workspace')
        if not membership:
            Membership.objects.create(workspace=workspace, user=user, role=Membership.OWNER)
        for d in sorted(p for p in root.iterdir() if p.is_dir()):
            meta_path = d / 'project.json'
            if not meta_path.exists():
                continue
            meta = json.loads(meta_path.read_text())
            if Project.objects.filter(pk=meta['id']).exists():
                self.stdout.write(f'skip {meta["id"]} (already imported)')
                continue
            with transaction.atomic():
                p = Project.objects.create(
                    id=meta['id'], workspace=workspace, created_by=user, name=meta.get('name', 'Untitled'),
                    tags=meta.get('tags', []), archived=meta.get('archived', False), trashed=meta.get('trashed', False),
                    trashed_at=parse_time(meta.get('trashedAt')), file_order=meta.get('fileOrder', {}))
                n = 0
                for path, rel in walk(d):
                    if path.is_dir():
                        files.mkdir(p, safe_path(rel))
                    else:
                        files.write_file(p, rel, path.read_bytes(), mimetypes.guess_type(rel)[0])
                        n += 1
                # auto_now fields: restore the original timestamps after writing files
                Project.objects.filter(pk=p.pk).update(
                    created_at=parse_time(meta.get('createdAt')) or p.created_at,
                    updated_at=parse_time(meta.get('updatedAt') or meta.get('createdAt')) or p.updated_at)
            self.stdout.write(f'project {p.id} ({p.name}): {n} files')


def walk_all(root):
    for path in sorted(root.rglob('*')):
        if path.is_file():
            yield path, path.relative_to(root).as_posix()
