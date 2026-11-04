import shutil
import threading
from unittest import mock, skipUnless

from django.db import connection
from django.test import TestCase, TransactionTestCase

from jobs import compile as tex
from jobs import tasks
from jobs.models import Job
from jobs.tests import DOC, make_png
from projects import files, storage
from projects.models import Project
from projects.test_api import make_user

from . import snapshot
from .models import ProjectVersion, VersionBlob

HAS_TEX = shutil.which('pdflatex') is not None


class VersionTestBase:
    def setUp(self):
        super().setUp()
        self.user = make_user(f'v{id(self)}@example.com')
        self.project = Project.objects.create(workspace=self.user.memberships.first().workspace, name='p')
        self.addCleanup(files.delete_project_files, self.project)

    def compile_job(self, pdf=b'%PDF-1', **overrides):
        """Run the compile task with the TeX run mocked, but with the real materialise() snapshot."""
        job = Job.objects.create(type='compile', user=self.user, project=self.project,
                                 params={'mainFile': 'main.tex', 'engine': 'pdflatex'})
        real = tex.materialise
        seen = {}

        def fake_compile(project, main_file, engine, progress=None, focus=None):
            import tempfile
            with tempfile.TemporaryDirectory() as root:
                seen['snapshot'] = real(project, root)
            return {'pdf': pdf, 'log': '', 'status': 0, 'snapshot': seen['snapshot'], **overrides}

        with mock.patch('jobs.tasks.tex.compile_project', side_effect=fake_compile):
            tasks.compile_project(str(job.id))
        self.addCleanup(storage.delete_prefix, f'jobs/{job.id}/')
        job.refresh_from_db()
        return job


class SnapshotTests(VersionTestBase, TestCase):
    def setUp(self):
        super().setUp()
        files.write_text(self.project, 'main.tex', DOC)
        files.write_text(self.project, 'refs.bib', '@book{a, title={A}}')
        files.write_binary(self.project, 'fig.png', make_png(), 'image/png')
        files.mkdir(self.project, 'empty')

    def test_a_compile_saves_a_version_with_the_manifest_and_pdf(self):
        job = self.compile_job(pdf=b'%PDF-one')
        v = ProjectVersion.objects.get()
        self.assertEqual((v.number, v.main_file, v.engine, v.created_by, v.job), (1, 'main.tex', 'pdflatex', self.user, job))
        self.assertEqual({m['path']: m['kind'] for m in v.manifest},
                         {'main.tex': 'text', 'refs.bib': 'text', 'fig.png': 'binary', 'empty': 'dir'})
        self.assertEqual(storage.get_bytes(v.pdf_key), b'%PDF-one')
        self.assertEqual(v.pdf_size, 8)
        self.assertEqual((job.result['versionId'], job.result['versionNumber'], job.result['versionCreated']),
                         (str(v.id), 1, True))

    def test_an_unchanged_project_creates_no_new_version(self):
        first = self.compile_job()
        second = self.compile_job()
        self.assertEqual(ProjectVersion.objects.count(), 1)
        self.assertEqual(second.result['versionId'], first.result['versionId'])
        self.assertFalse(second.result['versionCreated'])

    def test_a_different_main_file_or_engine_is_a_new_version(self):
        self.compile_job()
        job = Job.objects.create(type='compile', user=self.user, project=self.project,
                                 params={'mainFile': 'main.tex', 'engine': 'xelatex'})
        entries = tex.materialise(self.project, self._tmp())
        version, created = snapshot.record(self.project, entries, b'%PDF', 'main.tex', 'xelatex', job=job)
        self.assertTrue(created)
        self.assertEqual(version.number, 2)

    def _tmp(self):
        import tempfile
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        return d

    def test_only_the_changed_file_gets_a_new_blob(self):
        self.compile_job()
        before = {b.sha256: b.pk for b in VersionBlob.objects.all()}
        self.assertEqual(len(before), 3)  # dirs have no blob
        files.write_text(self.project, 'main.tex', DOC + '% edit\n')
        self.compile_job()
        after = {b.sha256: b.pk for b in VersionBlob.objects.all()}
        self.assertEqual(len(after), 4)
        self.assertTrue(all(after[h] == pk for h, pk in before.items()))
        self.assertEqual(ProjectVersion.objects.count(), 2)

    def test_a_replaced_or_deleted_binary_is_still_readable_from_the_version(self):
        png = make_png()
        self.compile_job()
        files.write_binary(self.project, 'fig.png', b'new bytes', 'image/png')
        files.delete(self.project, 'fig.png')
        v = ProjectVersion.objects.get()
        sha = next(m['sha256'] for m in v.manifest if m['path'] == 'fig.png')
        blob = VersionBlob.objects.get(project=self.project, sha256=sha)
        self.assertEqual(storage.get_bytes(blob.s3_key), png)

    def test_identical_content_in_two_files_shares_one_blob(self):
        files.write_text(self.project, 'copy.bib', '@book{a, title={A}}')
        self.compile_job()
        self.assertEqual(VersionBlob.objects.filter(kind='text').count(), 2)

    def test_a_failed_compile_creates_no_version(self):
        job = self.compile_job(pdf=None)
        self.assertEqual(job.status, 'failed')
        self.assertFalse(ProjectVersion.objects.exists())

    def test_the_compiler_alone_never_records_a_version(self):
        """Template transfer calls jobs.compile directly; only the compile task saves versions."""
        with mock.patch('jobs.compile.run_command', return_value=0):
            try:
                tex.compile_project(self.project, 'main.tex', 'pdflatex')
            except tex.CompileError:
                pass
        self.assertFalse(ProjectVersion.objects.exists())

    def test_a_snapshot_failure_does_not_fail_the_compile(self):
        with mock.patch('versions.snapshot.record', side_effect=RuntimeError('s3 down')):
            job = self.compile_job()
        self.assertEqual(job.status, 'success')
        self.assertTrue(job.result['pdfKey'])
        self.assertNotIn('versionId', job.result)

    def test_a_failure_while_saving_leaves_no_half_version_or_pdf(self):
        with mock.patch('versions.snapshot.storage.copy', side_effect=RuntimeError('copy failed')):
            job = self.compile_job()
        self.assertEqual(job.status, 'success')
        self.assertFalse(ProjectVersion.objects.exists())
        self.assertFalse(VersionBlob.objects.exists())

    def test_the_snapshot_is_what_the_compiler_saw_not_a_later_read(self):
        """Edits made after the files were materialised (e.g. while TeX runs) are not in the version."""
        real = tex.materialise

        def edit_after_reading(project, root):
            written = real(project, root)
            files.write_text(project, 'main.tex', 'changed while compiling')
            return written

        job = Job.objects.create(type='compile', user=self.user, project=self.project,
                                 params={'mainFile': 'main.tex', 'engine': 'pdflatex'})

        def fake_compile(project, main_file, engine, progress=None, focus=None):
            import tempfile
            with tempfile.TemporaryDirectory() as root:
                return {'pdf': b'%PDF', 'log': '', 'status': 0, 'snapshot': edit_after_reading(project, root)}

        with mock.patch('jobs.tasks.tex.compile_project', side_effect=fake_compile):
            tasks.compile_project(str(job.id))
        v = ProjectVersion.objects.get()
        sha = next(m['sha256'] for m in v.manifest if m['path'] == 'main.tex')
        self.assertEqual(VersionBlob.objects.get(project=self.project, sha256=sha).text, DOC)

    def test_deleting_the_project_deletes_versions_blobs_and_pdfs(self):
        self.compile_job()
        v = ProjectVersion.objects.get()
        blob_key = VersionBlob.objects.get(kind='binary').s3_key
        self.assertEqual(storage.get_bytes(blob_key), make_png())
        files.delete_project_files(self.project)
        self.project.delete()
        self.assertFalse(ProjectVersion.objects.filter(pk=v.pk).exists())
        self.assertFalse(VersionBlob.objects.exists())
        for key in (v.pdf_key, blob_key):
            with self.assertRaises(Exception):
                storage.get_bytes(key)


class ConcurrentNumberingTests(VersionTestBase, TransactionTestCase):
    def test_parallel_compiles_never_share_a_number(self):
        errors = []

        def run(i):
            try:
                entries = [{'path': 'main.tex', 'kind': 'text', 'size': 1, 'sha256': f'{i:064d}', 'text': str(i)}]
                snapshot.record(self.project, entries, b'%PDF', 'main.tex', 'pdflatex')
            except Exception as exc:  # reported below, from the main thread
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=run, args=(i,)) for i in range(1, 5)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(sorted(ProjectVersion.objects.values_list('number', flat=True)), [1, 2, 3, 4])


@skipUnless(HAS_TEX, 'needs TeX Live: docker compose run --rm worker-tex python manage.py test versions')
class RealCompileVersionTests(VersionTestBase, TestCase):
    def test_a_real_compile_saves_a_version_whose_pdf_opens_and_files_match(self):
        files.write_binary(self.project, 'figs/dot.png', make_png(), 'image/png')
        files.write_text(self.project, 'main.tex', '\\documentclass{article}\\usepackage{graphicx}\\begin{document}'
                         'Hi \\includegraphics[width=1cm]{figs/dot.png}\\end{document}')
        job = Job.objects.create(type='compile', user=self.user, project=self.project,
                                 params={'mainFile': 'main.tex', 'engine': 'pdflatex'})
        self.addCleanup(storage.delete_prefix, f'jobs/{job.id}/')
        tasks.compile_project(str(job.id))
        job.refresh_from_db()
        self.assertEqual(job.status, 'success')
        v = ProjectVersion.objects.get()
        self.assertEqual(job.result['versionId'], str(v.id))
        self.assertTrue(storage.get_bytes(v.pdf_key).startswith(b'%PDF'))
        self.assertEqual(sorted(m['path'] for m in v.manifest), ['figs/dot.png', 'main.tex'])
        again = tex.compile_project(self.project, 'main.tex', 'pdflatex')
        self.assertEqual(snapshot.hash_manifest(snapshot.manifest_of(again['snapshot'])), v.manifest_hash)
