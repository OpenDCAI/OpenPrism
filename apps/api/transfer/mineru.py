"""MinerU PDF -> Markdown client (port of services/mineruService.js)."""
import io
import posixpath
import re
import time
import zipfile

import httpx
from django.conf import settings

from ai.ssrf import BlockedEndpoint, assert_public_url
from projects.paths import InvalidPath, safe_path

from .llmjson import TransferError

MAX_PDF_BYTES = 200 * 1024 * 1024
MAX_ZIP_BYTES = 500 * 1024 * 1024
MAX_ZIP_MEMBERS = 20000
IMAGE_RE = re.compile(r'\.(png|jpe?g|gif|webp|bmp|svg)$', re.I)


def resolve_config(public=None, token=''):
    """Merge request settings with env defaults. `token` is the secret; it is never part of `public`."""
    public = public or {}
    extra = [str(v or '').strip().lower() for v in (public.get('extraFormats') or [])]

    def text(key):
        return public[key].strip() if isinstance(public.get(key), str) else ''

    token = (token or '').strip()
    return {
        # the operator's token only ever goes to the operator's MinerU (a request's own apiBase needs its own token)
        'apiBase': ((public.get('apiBase') if token else '') or settings.MINERU_API_BASE).strip().rstrip('/'),
        'token': token or (settings.MINERU_TOKEN or '').strip(),
        'modelVersion': public.get('modelVersion') or 'vlm',
        'isOcr': public['isOcr'] if isinstance(public.get('isOcr'), bool) else None,
        'enableFormula': public['enableFormula'] if isinstance(public.get('enableFormula'), bool) else True,
        'enableTable': public['enableTable'] if isinstance(public.get('enableTable'), bool) else True,
        'language': text('language'), 'pageRanges': text('pageRanges'), 'dataId': text('dataId'),
        'callback': text('callback'), 'seed': text('seed'),
        'extraFormats': [v for v in extra if v in ('docx', 'html', 'latex')],
    }


def public_part(cfg):
    """The non-secret part of a request's mineruConfig (safe to store on the Job row)."""
    cfg = cfg if isinstance(cfg, dict) else {}
    return {k: v for k, v in cfg.items() if k != 'token'}


def _guard(url):
    try:
        assert_public_url(url)
    except BlockedEndpoint as exc:
        raise TransferError(f'MinerU: {exc}')


def _json(res, what):
    if res.status_code >= 400:
        raise TransferError(f'MinerU {what} failed ({res.status_code}): {res.text}')
    try:
        data = res.json()
    except ValueError:
        raise TransferError(f'MinerU {what}: invalid JSON response')
    if data.get('code') != 0:
        raise TransferError(f"MinerU {what} error: {data.get('msg') or data}")
    return data


def _request_upload_url(cfg, file_name):
    file = {'name': file_name}
    if isinstance(cfg['isOcr'], bool):
        file['is_ocr'] = cfg['isOcr']
    if cfg['dataId']:
        file['data_id'] = cfg['dataId']
    if cfg['pageRanges']:
        file['page_ranges'] = cfg['pageRanges']
    payload = {'files': [file], 'model_version': cfg['modelVersion'],
               'enable_formula': cfg['enableFormula'], 'enable_table': cfg['enableTable']}
    for key, field in (('language', 'language'), ('callback', 'callback'), ('seed', 'seed')):
        if cfg[key]:
            payload[field] = cfg[key]
    if cfg['extraFormats']:
        payload['extra_formats'] = cfg['extraFormats']
    res = httpx.post(f"{cfg['apiBase']}/file-urls/batch", json=payload,
                     headers={'Authorization': f"Bearer {cfg['token']}"}, timeout=60)
    data = _json(res, 'requestUploadUrl')
    batch_id, urls = data.get('data', {}).get('batch_id'), data.get('data', {}).get('file_urls')
    if not batch_id or not urls:
        raise TransferError('MinerU requestUploadUrl: missing batch_id or file_urls')
    return batch_id, urls[0]


def _poll(cfg, batch_id, on_progress):
    url = f"{cfg['apiBase']}/extract-results/batch/{batch_id}"
    headers = {'Authorization': f"Bearer {cfg['token']}"}
    for _ in range(settings.MINERU_MAX_POLL_ATTEMPTS):
        data = _json(httpx.get(url, headers=headers, timeout=60), 'poll')
        results = data.get('data', {}).get('extract_result')
        if results:
            result = results[0]
            state = result.get('state')
            progress = result.get('extract_progress') or {}
            on_progress({'state': state, 'extractedPages': progress.get('extracted_pages'),
                         'totalPages': progress.get('total_pages')})
            if state == 'done':
                if not result.get('full_zip_url'):
                    raise TransferError('MinerU: task done but no full_zip_url')
                return result['full_zip_url']
            if state == 'failed':
                raise TransferError(f"MinerU extraction failed: {result.get('err_msg') or 'unknown error'}")
        time.sleep(settings.MINERU_POLL_INTERVAL_SECONDS)
    raise TransferError('MinerU: polling timed out')


def extract_result_zip(zip_bytes):
    """Returns (markdown, [(name, bytes)]). Unsafe member paths are an error, not silently dropped."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise TransferError('MinerU result is not a valid zip file')
    infos = [i for i in zf.infolist() if not i.is_dir()]
    if len(infos) > MAX_ZIP_MEMBERS or sum(i.file_size for i in infos) > MAX_ZIP_BYTES:
        raise TransferError('MinerU result zip is too large')
    files = {}
    for info in infos:
        try:
            files[safe_path(info.filename)] = info
        except InvalidPath:
            raise TransferError(f'Unsafe path in MinerU zip: {info.filename}')
    md_paths = sorted((p for p in files if p.lower().endswith('.md')), key=lambda p: (p.count('/'), p))
    if not md_paths:
        raise TransferError('MinerU output missing markdown file')
    md_path = md_paths[0]
    markdown = zf.read(files[md_path]).decode('utf-8', 'replace')
    if not markdown.strip():
        raise TransferError('MinerU output missing markdown content')
    md_dir = posixpath.dirname(md_path)
    prefix = f'{md_dir}/images/' if md_dir else 'images/'
    chosen = [p for p in files if p.startswith(prefix) and IMAGE_RE.search(p)]
    if not chosen:  # fall back to any images/ directory in the output
        chosen = [p for p in files if 'images' in p.split('/')[:-1] and IMAGE_RE.search(p)]
    images = [(posixpath.basename(p), zf.read(files[p])) for p in sorted(chosen)]
    return markdown, images


def _download(url, max_hops=3):
    """GET with manual redirects so every hop passes the SSRF check."""
    for _ in range(max_hops + 1):
        res = httpx.get(url, timeout=300, follow_redirects=False)
        if res.status_code in (301, 302, 303, 307, 308) and res.headers.get('location'):
            url = str(httpx.URL(url).join(res.headers['location']))
            _guard(url)
            continue
        if res.status_code != 200:
            raise TransferError(f'Failed to download MinerU zip ({res.status_code})')
        return res.content
    raise TransferError('Too many redirects downloading the MinerU zip')


def parse_pdf(pdf, file_name, cfg, on_progress=lambda info: None):
    """Upload `pdf` bytes to MinerU, wait for extraction, return {'markdown': str, 'images': [(name, bytes)]}."""
    if not cfg['token']:
        raise TransferError('MinerU token not configured. Set OPENPRISM_MINERU_TOKEN or provide in settings.')
    if cfg['callback'] and not cfg['seed']:
        raise TransferError('MinerU seed is required when callback is provided.')
    if len(pdf) > MAX_PDF_BYTES:
        raise TransferError(f'MinerU file too large ({len(pdf)} bytes). Max supported size is {MAX_PDF_BYTES} bytes.')
    _guard(cfg['apiBase'])
    on_progress({'phase': 'requesting_upload_url'})
    batch_id, upload_url = _request_upload_url(cfg, file_name)
    _guard(upload_url)
    on_progress({'phase': 'uploading_pdf'})
    res = httpx.put(upload_url, content=pdf, timeout=300)
    if res.status_code >= 400:
        raise TransferError(f'MinerU upload failed ({res.status_code}): {res.text}')
    on_progress({'phase': 'parsing'})
    zip_url = _poll(cfg, batch_id, lambda info: on_progress({'phase': 'parsing', **info}))
    _guard(zip_url)
    on_progress({'phase': 'downloading_results'})
    markdown, images = extract_result_zip(_download(zip_url))
    on_progress({'phase': 'done'})
    return {'markdown': markdown, 'images': images}
