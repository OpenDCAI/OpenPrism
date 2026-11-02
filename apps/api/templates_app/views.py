import zipfile

from rest_framework.decorators import api_view
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from common.zips import iter_zip_files

from . import service
from .categories import CATEGORIES
from .models import Template


@api_view(['GET'])
def list_templates(request):
    return Response({'templates': [service.meta(t) for t in Template.objects.order_by('-featured', 'id')],
                     'categories': CATEGORIES})


@api_view(['POST'])
def upload_template(request):
    template_id = str(request.data.get('templateId', '')).strip()
    label = str(request.data.get('templateLabel', '')).strip()
    upload = request.FILES.get('file')
    if not template_id or not upload:
        return Response({'ok': False, 'error': 'Missing templateId or zip file.'}, status=400)
    if not service.ID_RE.match(template_id):
        return Response({'ok': False, 'error': 'templateId may only contain letters, digits, - and _.'}, status=400)
    existing = Template.objects.filter(pk=template_id).first()
    if existing and existing.builtin and not request.user.is_staff:
        raise PermissionDenied('Built-in templates cannot be replaced.')
    try:
        entries = list(iter_zip_files(upload))
    except zipfile.BadZipFile:
        return Response({'ok': False, 'error': 'Invalid zip file.'}, status=400)
    contents = dict(entries)
    detected = service.detect_main_file(contents, lambda p: contents[p].decode('utf-8', 'replace'))
    keep = existing.main_file if existing and existing.main_file in contents else None
    tpl, _ = Template.objects.update_or_create(id=template_id, defaults={
        'label': label or template_id, 'description': label or template_id,
        'description_en': label or template_id, 'category': 'academic', 'author': 'User',
        'main_file': keep or detected or 'main.tex',
    })
    service.clear(tpl)
    for path, data in entries:
        service.write(tpl, path, data)
    return Response({'ok': True, 'templateId': template_id})
