"""What a workspace's projects and their version history take up in storage, and its time-based retention setting."""
from collections import defaultdict

from django.db.models import BigIntegerField, Case, F, Func, Sum, When
from rest_framework.decorators import api_view
from rest_framework.response import Response

from projects.models import ProjectFile
from projects.workspaces import require_admin

from .models import ProjectVersion, VersionBlob

RETENTION_MAX_DAYS = 3650


def report(workspace):
    """Bytes per project from aggregate queries (no S3 listing). Version blobs are already stored once per project;
    PDFs are counted once per distinct key, since versions can share one. Trashed projects still use storage."""
    projects = list(workspace.projects.order_by('name').values('id', 'name', 'trashed'))
    ids = [p['id'] for p in projects]
    text_bytes = Func(F('content'), function='octet_length', output_field=BigIntegerField())
    files = dict(ProjectFile.objects.filter(project_id__in=ids).values('project_id').annotate(
        n=Sum(Case(When(kind=ProjectFile.TEXT, then=text_bytes), default=F('size'), output_field=BigIntegerField()))).values_list('project_id', 'n'))
    blobs = dict(VersionBlob.objects.filter(project_id__in=ids).values('project_id').annotate(n=Sum('size'))
                 .values_list('project_id', 'n'))
    history, counts, pdfs = defaultdict(int), defaultdict(int), set()
    for pid, key, pdf_size, log_size in ProjectVersion.objects.filter(project_id__in=ids).values_list(
            'project_id', 'pdf_key', 'pdf_size', 'log_size'):
        counts[pid] += 1
        history[pid] += log_size
        if key and key not in pdfs:
            pdfs.add(key)
            history[pid] += pdf_size
    rows = [{'id': str(p['id']), 'name': p['name'], 'trashed': p['trashed'], 'fileBytes': files.get(p['id']) or 0,
             'versionBytes': (blobs.get(p['id']) or 0) + history[p['id']], 'versionCount': counts[p['id']]} for p in projects]
    rows.sort(key=lambda r: (-r['versionBytes'], r['name']))
    totals = {k: sum(r[k] for r in rows) for k in ('fileBytes', 'versionBytes', 'versionCount')}
    return {'totals': totals, 'projects': rows}


@api_view(['GET', 'PATCH'])
def workspace_storage(request, pk):
    """GET the storage report and retention setting; PATCH {versionRetentionDays: n|null}. Owners and admins only."""
    workspace = require_admin(request.user, pk).workspace
    if request.method == 'PATCH':
        days = (request.data or {}).get('versionRetentionDays', 'missing')
        if days is not None and (isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= RETENTION_MAX_DAYS):
            return Response({'ok': False, 'error': f'Keep versions for 1 to {RETENTION_MAX_DAYS} days, or by count only.'},
                            status=400)
        workspace.version_retention_days = days
        workspace.save(update_fields=['version_retention_days'])
    return Response({'ok': True, 'versionRetentionDays': workspace.version_retention_days, **report(workspace)})
