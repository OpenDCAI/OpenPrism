import io
import json
import shutil
import tarfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock, skipUnless

import psycopg
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings

from common import secrets as job_secrets
from common.testing import FakeLLM
from jobs.models import Job
from projects import files, storage
from projects.models import Project
from projects.test_api import ApiBase, client_for, make_user, make_zip
from templates_app import service as tpl_service
from templates_app.models import Template

from . import engine, mineru, nodes
from .llmjson import TransferError, ask_for_json, extract_json, strip_code_fences, validate_schema
from .tasks import run_transfer_segment

KEY = 'sk-transfer-SECRET-999'
SOURCE_TEX = ('\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nSee \\cite{k}.\n\\input{sec/method}\n'
              '\\includegraphics{figs/a.png}\n\\bibliography{refs}\n\\end{document}\n')
GOOD = '\\documentclass{article}\n\\begin{document}\nGOOD\n\\end{document}\n'
PLAN = {'sectionMapping': [{'sourceSection': 'Intro', 'targetSection': 'Introduction', 'action': 'map'}],
        'assetStrategy': {'bibFiles': ['refs.bib'], 'images': ['figs/a.png'], 'bibCommand': 'bibliography'}, 'notes': ''}


def fake_compile(project, main_file, engine_name, progress=lambda m: None):
    """Stands in for pdflatex: succeeds exactly when the main file contains GOOD."""
    from projects import files as f
    text = f.read_text(project, main_file)
    progress('fake pass')
    ok = 'GOOD' in text
    return {'pdf': b'%PDF-fake' if ok else None, 'log': 'ok' if ok else '! Undefined control sequence.', 'status': 0 if ok else 1}


class PureTests(SimpleTestCase):
    def test_json_helpers(self):
        self.assertEqual(strip_code_fences('```json\n{"a": 1}\n```'), '{"a": 1}')
        self.assertEqual(strip_code_fences('```latex\n\\x\n```'), '\\x')
        self.assertEqual(extract_json('Sure! Here you go: {"a": {"b": "}"}} hope that helps'), {'a': {'b': '}'}})
        self.assertEqual(extract_json('```json\n[1, 2]\n```'), [1, 2])
        self.assertIsNone(extract_json('no json here'))
        self.assertIsNone(extract_json('{"unterminated": '))
        schema = {'x': {'type': 'array', 'required': True}, 'y': {'type': 'string'}}
        self.assertEqual(validate_schema({'x': [], 'y': 's'}, schema), [])
        self.assertEqual(len(validate_schema({'x': 'no', 'y': 1}, schema)), 2)
        self.assertEqual(validate_schema({}, schema), ['Missing required field "x"'])
        self.assertEqual(validate_schema([], schema), ['Value is not an object'])

    @override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True)
    def test_ask_for_json_retries_then_gives_up(self):
        fake = FakeLLM([{'content': 'not json'}, {'content': '{"x": "wrong type"}'}, {'content': '{"x": [1]}'}])
        self.addCleanup(fake.close)
        cfg = {'endpoint': fake.url, 'apiKey': 'k'}
        parsed, raw, retries = ask_for_json([{'role': 'user', 'content': 'q'}], cfg, {'x': {'type': 'array', 'required': True}})
        self.assertEqual((parsed, retries), ({'x': [1]}, 2))
        self.assertIn('could not be parsed', fake.requests[1]['body']['messages'][-1]['content'])
        self.assertIn('schema issues', fake.requests[2]['body']['messages'][-1]['content'])
        fake2 = FakeLLM([{'content': 'nope'}] * 3)
        self.addCleanup(fake2.close)
        parsed, raw, retries = ask_for_json([{'role': 'user', 'content': 'q'}], {'endpoint': fake2.url, 'apiKey': 'k'})
        self.assertEqual((parsed, raw, retries), (None, 'nope', 2))

    def test_edges(self):
        e = engine.next_node
        ok, bad = {'compileResult': {'ok': True}}, {'compileResult': {'ok': False}}
        self.assertEqual(e('compile', {**ok}, 'legacy'), 'finalize')
        self.assertEqual(e('compile', {**ok, '_layoutCheck': True}, 'legacy'), 'requestPageImages')
        self.assertEqual(e('compile', {**bad, 'compileAttempt': 4}, 'legacy'), 'fixCompile')
        self.assertEqual(e('compile', {**bad, 'compileAttempt': 5}, 'legacy'), 'finalize')
        self.assertEqual(e('checkLayout', {'layoutCheckResult': {'ok': True}}, 'legacy'), 'finalize')
        self.assertEqual(e('checkLayout', {'layoutCheckResult': {'ok': False}, 'layoutAttempt': 2}, 'legacy'), 'fixLayout')
        self.assertEqual(e('checkLayout', {'layoutCheckResult': {'ok': False}, 'layoutAttempt': 3}, 'legacy'), 'finalize')
        self.assertEqual(e('analyzeTarget', {}, 'legacy'), 'draftPlan')
        self.assertEqual(e('analyzeTarget', {}, 'mineru'), 'applyTransfer')
        self.assertEqual(e('finalize', {}, 'legacy'), None)

    def test_mineru_zip_selection_and_safety(self):
        def zipped(entries):
            return make_zip(entries).getvalue()
        md, images = mineru.extract_result_zip(zipped({
            'abc/deep/other.md': 'deeper', 'abc/full.md': '# Title', 'abc/images/f1.png': b'1', 'abc/images/sub/f2.jpg': b'2',
            'abc/notimage.txt': 'x', 'other/images/zzz.png': b'3'}))
        self.assertEqual(md, '# Title')
        self.assertEqual([n for n, _ in images], ['f1.png', 'f2.jpg'])  # only images beside the chosen markdown
        md, images = mineru.extract_result_zip(zipped({'out.md': 'x', 'a/images/p.png': b'1'}))
        self.assertEqual([n for n, _ in images], ['p.png'])  # fallback: any images/ directory
        for bad in ({'../evil.md': 'x'}, {'/abs.md': 'x'}):
            with self.assertRaisesRegex(TransferError, 'Unsafe path'):
                mineru.extract_result_zip(zipped(bad))
        with self.assertRaisesRegex(TransferError, 'missing markdown file'):
            mineru.extract_result_zip(zipped({'a.txt': 'x'}))
        with self.assertRaisesRegex(TransferError, 'missing markdown content'):
            mineru.extract_result_zip(zipped({'a.md': '   '}))
        with self.assertRaisesRegex(TransferError, 'not a valid zip'):
            mineru.extract_result_zip(b'garbage')

    def test_mineru_config_keeps_token_out_of_public_part(self):
        self.assertNotIn('token', mineru.public_part({'token': 'T', 'apiBase': 'https://x.test'}))
        cfg = mineru.resolve_config({'apiBase': 'https://x.test/', 'extraFormats': ['DOCX', 'pdf'], 'isOcr': True}, 'TOK')
        self.assertEqual((cfg['apiBase'], cfg['token'], cfg['extraFormats'], cfg['isOcr']), ('https://x.test', 'TOK', ['docx'], True))


class FakeMineru:
    """Implements the four MinerU endpoints the client uses."""

    def __init__(self, zip_bytes, poll_states=('running', 'done')):
        self.zip_bytes, self.states, self.uploaded, self.requests = zip_bytes, list(poll_states), None, []
        outer = self

        class H(BaseHTTPRequestHandler):
            def _send(self, code, body, ctype='application/json'):
                self.send_response(code)
                self.send_header('Content-Type', ctype)
                self.end_headers()
                self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append((self.path, self.headers.get('Authorization'), body))
                self._send(200, {'code': 0, 'data': {'batch_id': 'b1', 'file_urls': [f'{outer.base}/upload/1']}})

            def do_PUT(self):
                outer.uploaded = self.rfile.read(int(self.headers['Content-Length']))
                self._send(200, b'')

            def do_GET(self):
                if self.path.startswith('/extract-results'):
                    state = outer.states.pop(0) if len(outer.states) > 1 else outer.states[0]
                    result = {'state': state, 'extract_progress': {'extracted_pages': 1, 'total_pages': 2}}
                    if state == 'done':
                        result['full_zip_url'] = f'{outer.base}/result.zip'
                    self._send(200, {'code': 0, 'data': {'extract_result': [result]}})
                else:
                    self._send(200, outer.zip_bytes, 'application/zip')

            def log_message(self, *a):
                pass

        self.server = HTTPServer(('127.0.0.1', 0), H)
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=True, MINERU_POLL_INTERVAL_SECONDS=0)
class TransferApiTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.source_id = self.new_project('Paper')
        self.source = Project.objects.get(pk=self.source_id)
        files.write_text(self.source, 'main.tex', SOURCE_TEX)
        files.write_text(self.source, 'sec/method.tex', 'Method text.')
        files.write_text(self.source, 'refs.bib', '@book{k, title={T}}')
        files.write_binary(self.source, 'figs/a.png', b'PNGDATA')
        tpl, _ = Template.objects.update_or_create(id='tpl', defaults={'label': 'Tpl', 'main_file': 'main.tex'})
        tpl_service.write(tpl, 'main.tex', b'\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n\\end{document}\n')
        tpl_service.write(tpl, 'tpl.sty', b'% style')
        sync = lambda job_id, segment: run_transfer_segment.run(job_id, segment)  # run the worker segment inline
        patcher = mock.patch('transfer.views.run_transfer_segment.delay', side_effect=sync)
        self.delay = patcher.start()
        self.addCleanup(patcher.stop)
        compile_patch = mock.patch('jobs.compile.compile_project', side_effect=fake_compile)
        compile_patch.start()
        self.addCleanup(compile_patch.stop)
        self.addCleanup(lambda: [(storage.delete_prefix(f'jobs/{j.id}/'), job_secrets.delete(str(j.id))) for j in Job.objects.all()])

    def fake(self, *replies):
        fake = FakeLLM([r if isinstance(r, (dict, tuple)) else {'content': r} for r in replies])
        self.addCleanup(fake.close)
        return fake

    def start(self, fake, **extra):
        body = {'sourceProjectId': self.source_id, 'sourceMainFile': 'main.tex', 'targetTemplateId': 'tpl',
                'targetMainFile': 'main.tex', 'llmConfig': {'endpoint': fake.url, 'apiKey': KEY, 'model': 'm'}, **extra}
        res = self.c.post('/api/transfer/start', body, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        return res.data['jobId'], res.data['newProjectId']

    def step(self, job_id):
        return self.c.post('/api/transfer/step', {'jobId': job_id}, format='json').data

    def assert_no_secrets_in_db(self):
        for job in Job.objects.all():
            blob = json.dumps([job.params, job.result, job.progress_log, job.error])
            self.assertNotIn(KEY, blob)
            self.assertNotIn('apiKey', blob)
            self.assertNotIn('mineruToken', blob)

    # ---- legacy flow ----
    def test_legacy_transfer_with_compile_fix(self):
        fake = self.fake('```json\n' + json.dumps(PLAN) + '\n```', '```latex\n\\documentclass{article}\\begin{document}\\badcmd\\end{document}\n```', GOOD)
        job_id, new_id = self.start(fake)
        self.assertEqual(self.c.get(f'/api/transfer/status/{job_id}').data['status'], 'pending')
        done = self.step(job_id)
        self.assertEqual(done['status'], 'success', done)
        log = '\n'.join(done['progressLog'])
        for marker in ('[analyzeSource] Parsed 1 sections, found 1 bib files, 1 images', '[analyzeTarget]', '[draftPlan] Generated migration plan with 1 section mappings',
                       '[applyTransfer] Wrote migrated content', '[copyAssets] Copied 2 files', '[compile] Attempt 1: FAILED',
                       '[fixCompile]', '[compile] Attempt 2: SUCCESS', '[finalize] Transfer success. Compile attempts: 2'):
            self.assertIn(marker, log)
        target = Project.objects.get(pk=new_id)
        self.assertEqual(target.name, 'Paper (Tpl)')
        self.assertEqual(files.read_text(target, 'main.tex'), GOOD.strip())          # fences stripped
        self.assertEqual(files.read_bytes(target, 'figs/a.png'), b'PNGDATA')          # asset copied
        self.assertEqual(files.read_text(target, 'refs.bib'), '@book{k, title={T}}')
        self.assertEqual(files.read_text(target, 'tpl.sty'), '% style')                # template files kept
        self.assertEqual(files.read_text(self.source, 'main.tex'), SOURCE_TEX)         # source untouched
        # prompts carry the source (with \input resolved) and the plan; the key went out as the bearer token
        apply_prompt = fake.requests[1]['body']['messages'][0]['content']
        self.assertIn('Method text.', apply_prompt)
        self.assertIn('"sectionMapping"', apply_prompt)
        self.assertEqual({r['auth'] for r in fake.requests}, {f'Bearer {KEY}'})
        # previous versions are snapshotted outside the project; the PDF is downloadable
        job = Job.objects.get(pk=job_id)
        self.assertTrue(any(k for k in self._keys(f'jobs/{job_id}/snapshots/')))
        self.assertEqual(self.c.get(f'/api/jobs/{job_id}/pdf').content, b'%PDF-fake')
        self.assertEqual(job_secrets.get(job_id), {})                                  # secret deleted on completion
        self.assert_no_secrets_in_db()

    def _keys(self, prefix):
        pages = storage.get_client().get_paginator('list_objects_v2').paginate(Bucket=settings.S3_BUCKET, Prefix=prefix)
        return [o['Key'] for page in pages for o in page.get('Contents', [])]

    def test_step_is_idempotent_and_starts_once(self):
        fake = self.fake(json.dumps(PLAN), GOOD)
        job_id, _ = self.start(fake)
        self.step(job_id)
        self.step(job_id)
        self.step(job_id)
        self.assertEqual(self.delay.call_count, 1)
        self.assertEqual(len(fake.requests), 2)

    def test_gives_up_after_five_compile_attempts(self):
        fake = self.fake(json.dumps(PLAN), 'BAD1', *['BAD'] * 5)
        job_id, _ = self.start(fake)
        done = self.step(job_id)
        self.assertEqual(done['status'], 'failed')
        self.assertEqual(done['error'], 'No PDF generated.')
        self.assertIn('Compile attempts: 5', done['progressLog'][-1])
        self.assertEqual(sum('[fixCompile]' in l for l in done['progressLog']), 4)

    def test_llm_failure_fails_the_job_with_the_provider_message(self):
        fake = self.fake((401, 'invalid api key'))
        job_id, _ = self.start(fake)
        done = self.step(job_id)
        self.assertEqual(done['status'], 'failed')
        self.assertIn('LLM call failed: invalid api key', done['error'])
        self.assertIn('[error]', done['progressLog'][-1])
        self.assertEqual(job_secrets.get(job_id), {})

    # ---- layout check pause / resume ----
    def test_layout_check_pauses_and_resumes_with_images(self):
        issues = {'summary': 's', 'issues': [{'page': 1, 'severity': 'high', 'type': 'overflow', 'description': 'd', 'suggestion': 'x'}]}
        fake = self.fake(json.dumps(PLAN), GOOD, json.dumps(issues), GOOD + '% fixed', json.dumps({'summary': 'fine', 'issues': []}))
        job_id, new_id = self.start(fake, layoutCheck=True)
        paused = self.step(job_id)
        self.assertEqual(paused['status'], 'waiting_images')
        pdf = self.c.get(f'/api/jobs/{job_id}/pdf')   # the browser renders this to take the page screenshots
        self.assertEqual((pdf.status_code, pdf['Content-Type']), (200, 'application/pdf'))
        self.assertEqual(self.step(job_id)['status'], 'waiting_images')   # polling does not restart anything
        self.assertEqual(self.delay.call_count, 1)
        imgs = [{'page': 1, 'base64': 'QUJD', 'mime': 'image/png'}]
        # not allowed unless the job is waiting; and other users cannot touch it
        other = client_for(make_user('other@example.com'))
        self.assertEqual(other.post('/api/transfer/submit-images', {'jobId': job_id, 'images': imgs}, format='json').status_code, 404)
        self.assertTrue(self.c.post('/api/transfer/submit-images', {'jobId': job_id, 'images': imgs}, format='json').data['ok'])
        # the resumed segment ran inline: layout issue -> fixLayout -> compile -> pause again
        again = self.c.get(f'/api/transfer/status/{job_id}').data
        self.assertEqual(again['status'], 'waiting_images')
        self.assertEqual(self.c.get(f'/api/jobs/{job_id}/pdf').status_code, 200)   # and again after the recompile
        self.assertIn('[checkLayout] Found 1 issues, needs fix', '\n'.join(again['progressLog']))
        self.assertIn('[fixLayout] Applied LLM fix for 1 layout issues (attempt 1)', '\n'.join(again['progressLog']))
        self.assertEqual(self.c.post('/api/transfer/submit-images', {'jobId': job_id, 'images': imgs}, format='json').status_code, 200)
        final = self.c.get(f'/api/transfer/status/{job_id}').data
        self.assertEqual(final['status'], 'success', final)
        self.assertIn('Layout attempts: 2', final['progressLog'][-1])
        self.assertEqual(self.c.post('/api/transfer/submit-images', {'jobId': job_id, 'images': imgs}, format='json').data['error'],
                         'Job is not waiting for images.')
        content = fake.requests[2]['body']['messages'][0]['content']
        self.assertEqual(content[1]['image_url']['url'], 'data:image/png;base64,QUJD')
        self.assertEqual(files.read_text(Project.objects.get(pk=new_id), 'main.tex'), (GOOD + '% fixed').strip())
        self.assert_no_secrets_in_db()
        self.assertEqual(job_secrets.get(job_id), {})

    def test_layout_check_parse_failure_is_not_treated_as_ok(self):
        fake = self.fake(json.dumps(PLAN), GOOD, 'garbage', 'garbage', 'garbage', GOOD)
        job_id, _ = self.start(fake, layoutCheck=True)
        self.step(job_id)
        self.c.post('/api/transfer/submit-images', {'jobId': job_id, 'images': [{'page': 1, 'base64': 'QQ==', 'mime': 'image/png'}]}, format='json')
        status = self.c.get(f'/api/transfer/status/{job_id}').data
        self.assertIn('[JSON parse failed]', '\n'.join(status['progressLog']))
        self.assertEqual(status['status'], 'waiting_images')  # went to fixLayout and back to a new check

    def test_layout_check_without_images_is_skipped(self):
        fake = self.fake(json.dumps(PLAN), GOOD)
        job_id, _ = self.start(fake, layoutCheck=True)
        self.step(job_id)
        self.c.post('/api/transfer/submit-images', {'jobId': job_id, 'images': []}, format='json')
        final = self.c.get(f'/api/transfer/status/{job_id}').data
        self.assertEqual(final['status'], 'success')
        self.assertIn('No page images provided', '\n'.join(final['progressLog']))

    # ---- validation / access ----
    def test_start_validation_and_access(self):
        fake = self.fake()
        cfg = {'llmConfig': {'endpoint': fake.url}}
        self.assertEqual(self.c.post('/api/transfer/start', {**cfg, 'sourceProjectId': self.source_id}, format='json').data['error'],
                         'Missing required fields.')
        base = {'sourceProjectId': self.source_id, 'sourceMainFile': 'main.tex', 'targetMainFile': 'main.tex', **cfg}
        self.assertIn('Unknown template', self.c.post('/api/transfer/start', {**base, 'targetTemplateId': 'nope'}, format='json').data['error'])
        other = client_for(make_user('other@example.com'))
        self.assertEqual(other.post('/api/transfer/start', {**base, 'targetTemplateId': 'tpl'}, format='json').status_code, 404)
        self.assertEqual(Project.objects.count(), 1)  # nothing created by the failed attempts
        self.assertEqual(self.c.post('/api/transfer/step', {'jobId': 'nope'}, format='json').status_code, 404)
        self.assertEqual(self.c.get('/api/transfer/status/00000000-0000-0000-0000-000000000000').status_code, 404)
        mine = self.c.post('/api/transfer/start-mineru', {'targetTemplateId': 'tpl', 'targetMainFile': 'main.tex', 'sourceProjectId': self.source_id}, format='json')
        self.assertEqual(mine.data['error'], 'sourceProjectId and sourceMainFile must be provided together, or both omitted.')

    # ---- MinerU flow ----
    def mineru_zip(self):
        return make_zip({'full/doc.md': '# Heading\n\nSome $x^2$ text.\n![](images/f1.png)', 'full/images/f1.png': b'IMG1'}).getvalue()

    def test_mineru_with_uploaded_pdf(self):
        server = FakeMineru(self.mineru_zip())
        self.addCleanup(server.close)
        fake = self.fake(GOOD)
        res = self.c.post('/api/transfer/start-mineru', {
            'targetTemplateId': 'tpl', 'targetMainFile': 'main.tex', 'llmConfig': {'endpoint': fake.url, 'apiKey': KEY},
            'mineruConfig': {'apiBase': server.base, 'token': 'MINERU-TOKEN', 'language': 'en'}}, format='json')
        job_id, new_id = res.data['jobId'], res.data['newProjectId']
        self.assertEqual(self.c.post('/api/transfer/upload-pdf', {'jobId': job_id}, format='multipart').data['error'], 'No PDF file uploaded.')
        self.assertTrue(self.c.post('/api/transfer/upload-pdf', {'jobId': job_id, 'pdf': SimpleUploadedFile('p.pdf', b'%PDF-up')}, format='multipart').data['ok'])
        done = self.step(job_id)
        self.assertEqual(done['status'], 'success', done)
        log = '\n'.join(done['progressLog'])
        self.assertIn('[compileSource] Using provided PDF', log)
        self.assertIn('[parsePdfWithMineru] Parsed PDF:', log)
        self.assertIn('[copyAssets:mineru] Copied 1 images, 0 bib files.', log)
        self.assertEqual(server.uploaded, b'%PDF-up')
        path, auth, body = server.requests[0]
        self.assertEqual((path, auth, body['language']), ('/file-urls/batch', 'Bearer MINERU-TOKEN', 'en'))
        target = Project.objects.get(pk=new_id)
        self.assertEqual(files.read_bytes(target, 'images/f1.png'), b'IMG1')
        prompt = fake.requests[0]['body']['messages'][0]['content']
        self.assertIn('# Heading', prompt)
        self.assertIn('IMAGE FILES AVAILABLE:\nf1.png', prompt)
        self.assertEqual(self.c.post('/api/transfer/upload-pdf', {'jobId': job_id, 'pdf': SimpleUploadedFile('p.pdf', b'x')}, format='multipart').data['error'],
                         'The transfer has already started.')
        self.assert_no_secrets_in_db()
        self.assertNotIn('MINERU-TOKEN', json.dumps([j.params for j in Job.objects.all()]))

    def test_mineru_compiles_source_project_and_copies_bibs(self):
        server = FakeMineru(self.mineru_zip(), poll_states=('done',))
        self.addCleanup(server.close)
        files.write_text(self.source, 'main.tex', GOOD)  # compiles with the fake compiler
        fake = self.fake(GOOD)
        res = self.c.post('/api/transfer/start-mineru', {
            'sourceProjectId': self.source_id, 'sourceMainFile': 'main.tex', 'targetTemplateId': 'tpl', 'targetMainFile': 'main.tex',
            'llmConfig': {'endpoint': fake.url, 'apiKey': KEY}, 'mineruConfig': {'apiBase': server.base, 'token': 'T'}}, format='json')
        done = self.step(res.data['jobId'])
        self.assertEqual(done['status'], 'success', done)
        self.assertIn('[compileSource] Compiled source project to PDF', '\n'.join(done['progressLog']))
        self.assertEqual(server.uploaded, b'%PDF-fake')
        self.assertEqual(files.read_text(Project.objects.get(pk=res.data['newProjectId']), 'refs.bib'), '@book{k, title={T}}')

    def test_mineru_failures_are_reported(self):
        fake = self.fake()
        base = {'targetTemplateId': 'tpl', 'targetMainFile': 'main.tex', 'llmConfig': {'endpoint': fake.url, 'apiKey': KEY}}
        no_pdf = self.c.post('/api/transfer/start-mineru', base, format='json').data['jobId']
        self.assertIn('No source PDF available', self.step(no_pdf)['error'])
        with mock.patch.object(mineru.settings, 'MINERU_TOKEN', ''):
            no_token = self.c.post('/api/transfer/start-mineru', base, format='json').data['jobId']
            self.c.post('/api/transfer/upload-pdf', {'jobId': no_token, 'pdf': SimpleUploadedFile('p.pdf', b'%PDF')}, format='multipart')
            self.assertIn('MinerU token not configured', self.step(no_token)['error'])
        server = FakeMineru(b'', poll_states=('failed',))
        self.addCleanup(server.close)
        failing = self.c.post('/api/transfer/start-mineru', {**base, 'mineruConfig': {'apiBase': server.base, 'token': 'T'}}, format='json').data['jobId']
        self.c.post('/api/transfer/upload-pdf', {'jobId': failing, 'pdf': SimpleUploadedFile('p.pdf', b'%PDF')}, format='multipart')
        self.assertIn('MinerU extraction failed', self.step(failing)['error'])
        legacy = self.c.post('/api/transfer/start', {'sourceProjectId': self.source_id, 'sourceMainFile': 'main.tex', 'targetTemplateId': 'tpl',
                                                     'targetMainFile': 'main.tex'}, format='json').data['jobId']
        self.assertEqual(self.c.post('/api/transfer/upload-pdf', {'jobId': legacy, 'pdf': SimpleUploadedFile('p.pdf', b'x')}, format='multipart').data['error'],
                         'Job is not a MinerU transfer job.')

    def test_mineru_endpoint_is_checked_for_ssrf(self):
        with override_settings(LLM_ALLOW_PRIVATE_ENDPOINTS=False):
            fake = self.fake()
            job_id = self.c.post('/api/transfer/start-mineru', {'targetTemplateId': 'tpl', 'targetMainFile': 'main.tex',
                                 'mineruConfig': {'apiBase': 'http://169.254.169.254/latest', 'token': 'T'}}, format='json').data['jobId']
            self.c.post('/api/transfer/upload-pdf', {'jobId': job_id, 'pdf': SimpleUploadedFile('p.pdf', b'%PDF')}, format='multipart')
            self.assertIn('non-public', self.step(job_id)['error'])

    # ---- engine safety ----
    def test_segment_lock_and_stale_segments(self):
        fake = self.fake(json.dumps(PLAN), GOOD)
        job_id, _ = self.start(fake)
        import uuid
        engine.run_segment(uuid.UUID(job_id), 99)                       # stale segment number: ignored
        self.assertEqual(len(fake.requests), 0)
        db = settings.DATABASES['default']
        with psycopg.connect(dbname=db['NAME'], user=db['USER'], password=db['PASSWORD'], host=db['HOST'], port=db['PORT'], autocommit=True) as other:
            other.execute('SELECT pg_advisory_lock(%s)', [engine._lock_key(uuid.UUID(job_id))])
            engine.run_segment(uuid.UUID(job_id), 1)                    # another worker holds the job: do nothing
            self.assertEqual(len(fake.requests), 0)
        engine.run_segment(uuid.UUID(job_id), 1)                        # lock released: runs
        self.assertEqual(len(fake.requests), 2)

    def test_snapshot_keeps_previous_version(self):
        fake = self.fake(json.dumps(PLAN), 'FIRST', 'BAD', GOOD)
        job_id, new_id = self.start(fake)
        self.step(job_id)
        snaps = self._keys(f'jobs/{job_id}/snapshots/')
        bodies = sorted(storage.get_bytes(k).decode() for k in snaps)
        self.assertEqual(len(snaps), 3)  # template main, then the two overwritten drafts
        self.assertIn('FIRST', bodies)
        self.assertEqual(self.client_files(new_id), ['main.tex', 'tpl.sty', 'figs/a.png', 'refs.bib'].__class__(sorted(['main.tex', 'tpl.sty', 'figs/a.png', 'refs.bib'])))

    def client_files(self, project_id):
        return sorted(i['path'] for i in self.c.get(f'/api/projects/{project_id}/tree').data['items'] if i['type'] == 'file')

    @skipUnless(shutil.which('pdflatex'), 'needs TeX Live: docker compose run --rm worker-tex python manage.py test transfer')
    def test_real_pdflatex_end_to_end(self):
        mock.patch.stopall()  # drop the fake compiler (and the inline-task patch; re-add it)
        sync = lambda job_id, segment: run_transfer_segment.run(job_id, segment)
        patcher = mock.patch('transfer.views.run_transfer_segment.delay', side_effect=sync)
        patcher.start()
        self.addCleanup(patcher.stop)
        fake = self.fake(json.dumps(PLAN), '\\documentclass{article}\\begin{document}\\oops\\end{document}',
                         '\\documentclass{article}\n\\begin{document}\nMigrated text.\n\\end{document}\n')
        job_id, new_id = self.start(fake)
        done = self.step(job_id)
        self.assertEqual(done['status'], 'success', done)
        self.assertTrue(self.c.get(f'/api/jobs/{job_id}/pdf').content.startswith(b'%PDF'))
        self.assertIn('Undefined control sequence', fake.requests[2]['body']['messages'][0]['content'])  # real log fed to fixCompile


# ---- arXiv import ----


    def test_transfer_uses_the_workspace_key_and_stores_it_only_in_redis(self):
        from integrations import llmconfig
        ws = self.fake(*([{'content': json.dumps(PLAN)}] + [GOOD] * 3))
        llmconfig.save(self.source.workspace, self.user, ws.url, 'ws-model', 'sk-workspace-SECRET-7')
        body = {'sourceProjectId': self.source_id, 'sourceMainFile': 'main.tex', 'targetTemplateId': 'tpl',
                'targetMainFile': 'main.tex', 'llmConfig': {'endpoint': 'http://127.0.0.1:1/v1', 'apiKey': KEY, 'model': 'b'}}
        res = self.c.post('/api/transfer/start', body, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        job = Job.objects.get(pk=res.data['jobId'])
        self.assertEqual(job.params['llmConfig'], {'endpoint': ws.url + '/chat/completions', 'model': 'ws-model'})
        self.assertEqual(job_secrets.get(str(job.id)), {'apiKey': 'sk-workspace-SECRET-7'})
        for _ in range(8):
            if self.step(res.data['jobId'])['status'] in ('success', 'failed'):
                break
        self.assertTrue(ws.requests)
        self.assertEqual({r['auth'] for r in ws.requests}, {'Bearer sk-workspace-SECRET-7'})
        for j in Job.objects.all():
            self.assertNotIn('sk-workspace-SECRET-7', json.dumps([j.params, j.result, j.progress_log, j.error]))


def make_tar(entries, gz=True):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz' if gz else 'w') as tar:
        for name, data in entries.items():
            if isinstance(data, tarfile.TarInfo):
                tar.addfile(data)
                continue
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class FakeStream:
    def __init__(self, status=200, body=b'', headers=None):
        self.status_code, self.body, self.headers = status, body, headers or {'content-length': str(len(body))}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_bytes(self):
        for i in range(0, len(self.body), 1024):
            yield self.body[i:i + 1024]


class ArxivImportTests(ApiBase):
    def setUp(self):
        super().setUp()
        sync = lambda job_id: __import__('projects.tasks', fromlist=['x']).import_arxiv.run(job_id)
        patcher = mock.patch('projects.views.import_arxiv.delay', side_effect=sync)
        patcher.start()
        self.addCleanup(patcher.stop)

    def events(self, query, stream):
        from rest_framework_simplejwt.tokens import RefreshToken
        token = str(RefreshToken.for_user(self.user).access_token)
        with mock.patch('projects.arxiv_import.httpx.stream', return_value=stream) as m:
            res = self.c.__class__().get('/api/projects/import-arxiv-sse', {**query, 'token': token})
            body = b''.join(res.streaming_content).decode()
        out = []
        for block in body.strip().split('\n\n'):
            lines = dict(l.split(': ', 1) for l in block.split('\n'))
            out.append((lines['event'], json.loads(lines['data'])))
        return res, out, m

    def test_imports_tarball_safely(self):
        link = tarfile.TarInfo('link.tex')
        link.type, link.linkname = tarfile.SYMTYPE, '/etc/passwd'
        tar = make_tar({'main.tex': b'\\documentclass{article}', 'figs/a.png': b'\x89PNG', '../evil.tex': b'x', '/abs.tex': b'x', 'link.tex': link})
        res, events, m = self.events({'arxivIdOrUrl': 'https://arxiv.org/abs/1706.03762v7', 'projectName': 'Attn'}, FakeStream(body=tar))
        self.assertEqual(res['Content-Type'], 'text/event-stream')
        self.assertEqual(m.call_args.args[:2], ('GET', 'https://arxiv.org/e-print/1706.03762'))
        kinds = [k for k, _ in events]
        self.assertEqual(kinds[-1], 'done')
        self.assertIn('progress', kinds)
        project = events[-1][1]['project']
        self.assertEqual(project['name'], 'Attn')
        tree = [i['path'] for i in self.c.get(f"/api/projects/{project['id']}/tree").data['items'] if i['type'] == 'file']
        self.assertEqual(tree, ['figs/a.png', 'main.tex'])  # escaping, absolute and symlink members were skipped

    def test_single_gzipped_tex_file(self):
        import gzip
        res, events, _ = self.events({'arxivIdOrUrl': '1706.03762'}, FakeStream(body=gzip.compress(b'\\documentclass{article}')))
        self.assertEqual(events[-1][0], 'done')
        self.assertEqual(events[-1][1]['project']['name'], 'arxiv-1706.03762')
        pid = events[-1][1]['project']['id']
        self.assertEqual(self.c.get(f'/api/projects/{pid}/file', {'path': 'main.tex'}).data['content'], '\\documentclass{article}')

    def test_failures_emit_error_and_leave_no_project(self):
        for stream, expected in ((FakeStream(status=404), 'arXiv download failed: arXiv download failed: 404'),
                                 (FakeStream(body=b'not an archive at all'), 'not a recognised archive')):
            res, events, _ = self.events({'arxivIdOrUrl': '1706.03762'}, stream)
            self.assertEqual(events[-1][0], 'error')
            self.assertIn(expected, events[-1][1]['error'])
        self.assertEqual(Project.objects.count(), 0)
        res, events, m = self.events({'arxivIdOrUrl': ''}, FakeStream())
        self.assertEqual(events, [('error', {'error': 'Invalid arXiv ID.'})])
        m.assert_not_called()

    def test_requires_auth(self):
        from rest_framework.test import APIClient
        self.assertEqual(APIClient().get('/api/projects/import-arxiv-sse', {'arxivIdOrUrl': '1706.03762'}).status_code, 401)
