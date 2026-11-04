from django.test import SimpleTestCase
from rest_framework.test import APIClient

from collab import tokens
from projects import files
from projects.models import Membership, Project
from projects.test_api import ApiBase, client_for, make_user

from . import anchor
from .models import CommentThread

TEXT = 'Intro line.\nThe method is novel.\nThe method is fast.\n'


class AnchorTests(SimpleTestCase):
    def test_unchanged_shifted_repeated_and_gone(self):
        start = TEXT.index('novel')
        prefix, suffix = anchor.context_of(TEXT, start, start + 5)
        self.assertEqual(anchor.locate(TEXT, 'novel', prefix, suffix, start), (start, start + 5))
        shifted = 'NEW FIRST LINE\n' + TEXT
        self.assertEqual(anchor.locate(shifted, 'novel', prefix, suffix, start), (start + 15, start + 20))
        # "The method" appears twice: the context picks the second one even after a shift
        second = TEXT.index('The method is fast')
        p2, s2 = anchor.context_of(TEXT, second, second + 10)
        found = anchor.locate(shifted, 'The method', p2, s2, second)
        self.assertEqual(shifted[found[1]:found[1] + 8], ' is fast')
        self.assertIsNone(anchor.locate(TEXT.replace('novel', 'new'), 'novel', prefix, suffix, start))
        self.assertIsNone(anchor.locate(TEXT, '', '', '', 0))


class CommentApiTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.pid = self.new_project()
        self.project = Project.objects.get(pk=self.pid)
        files.write_text(self.project, 'main.tex', TEXT)
        self.url = f'/api/projects/{self.pid}/comments'

    def member(self, email, role):
        user = make_user(email)
        Membership.objects.create(workspace=self.project.workspace, user=user, role=role)
        return client_for(user)

    def guest(self, role):
        token, _ = tokens.create_invite(self.project, self.user, role)
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        return c

    def create(self, client=None, word='novel', body='Is it really?'):
        start = TEXT.index(word)
        prefix, suffix = anchor.context_of(TEXT, start, start + len(word))
        return (client or self.c).post(self.url, {'path': 'main.tex', 'from': start, 'to': start + len(word), 'quote': word,
                                                  'prefix': prefix, 'suffix': suffix, 'body': body}, format='json')

    def test_create_list_reply_resolve(self):
        res = self.create()
        self.assertEqual(res.status_code, 201)
        thread = res.data['thread']
        self.assertEqual((thread['quote'], thread['anchor'], thread['orphaned']), ('novel', {'from': TEXT.index('novel'), 'to': TEXT.index('novel') + 5}, False))
        self.assertEqual([c['body'] for c in thread['comments']], ['Is it really?'])
        self.assertTrue(thread['comments'][0]['mine'])
        tid = thread['id']
        commenter = self.member('c@example.com', Membership.COMMENTER)
        reply = commenter.post(f'{self.url}/{tid}/replies', {'body': 'Yes, see section 3.'}, format='json')
        self.assertEqual([c['author'] for c in reply.data['thread']['comments']], ['owner', 'c'])
        self.assertEqual(commenter.patch(f'{self.url}/{tid}', {'resolved': True}, format='json').data['thread']['resolvedBy'], 'c')
        listing = self.c.get(self.url, {'path': 'main.tex'}).data
        self.assertEqual((listing['canComment'], listing['canModerate']), (True, True))
        self.assertTrue(listing['threads'][0]['resolved'])
        self.assertFalse(self.c.patch(f'{self.url}/{tid}', {'resolved': False}, format='json').data['thread']['resolved'])

    def test_commenter_comments_but_cannot_write_files_and_viewer_only_reads(self):
        commenter = self.member('c@example.com', Membership.COMMENTER)
        self.assertEqual(self.create(commenter).status_code, 201)
        self.assertEqual(commenter.put(f'/api/projects/{self.pid}/file', {'path': 'main.tex', 'content': 'x'}, format='json').status_code, 403)
        viewer = self.member('v@example.com', Membership.VIEWER)
        self.assertEqual(len(viewer.get(self.url).data['threads']), 1)
        self.assertFalse(viewer.get(self.url).data['canComment'])
        self.assertEqual(self.create(viewer).status_code, 403)
        tid = CommentThread.objects.get().id
        self.assertEqual(viewer.post(f'{self.url}/{tid}/replies', {'body': 'x'}, format='json').status_code, 403)
        self.assertEqual(viewer.patch(f'{self.url}/{tid}', {'resolved': True}, format='json').status_code, 403)
        self.assertEqual(client_for(make_user('stranger@example.com')).get(self.url).status_code, 404)

    def test_invite_link_guests(self):
        editor, commenter, viewer = self.guest('editor'), self.guest('commenter'), self.guest('viewer')
        self.assertEqual(self.create(editor).status_code, 201)
        res = self.create(commenter, word='fast', body='from a commenter link')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data['thread']['comments'][0]['author'], 'Guest')
        self.assertEqual(self.create(viewer).status_code, 403)
        self.assertEqual(len(viewer.get(self.url).data['threads']), 2)
        tid, cid = res.data['thread']['id'], res.data['thread']['comments'][0]['id']
        self.assertEqual(editor.patch(f'{self.url}/{tid}/replies/{cid}', {'body': 'not mine'}, format='json').status_code, 403)
        self.assertEqual(commenter.patch(f'{self.url}/{tid}/replies/{cid}', {'body': 'edited'}, format='json').data['thread']['comments'][0]['body'], 'edited')
        self.assertEqual(commenter.put(f'/api/projects/{self.pid}/file', {'path': 'main.tex', 'content': 'x'}, format='json').status_code, 403)

    def test_edit_and_delete_rules(self):
        tid = self.create().data['thread']['id']
        commenter = self.member('c@example.com', Membership.COMMENTER)
        reply = commenter.post(f'{self.url}/{tid}/replies', {'body': 'mine'}, format='json').data['thread']['comments'][1]
        first = CommentThread.objects.get().comments.first()
        self.assertEqual(commenter.patch(f'{self.url}/{tid}/replies/{first.id}', {'body': 'x'}, format='json').status_code, 403)
        self.assertEqual(commenter.delete(f'{self.url}/{tid}').status_code, 403)       # not their thread
        edited = commenter.patch(f'{self.url}/{tid}/replies/{reply["id"]}', {'body': 'mine, edited'}, format='json').data['thread']
        self.assertTrue(edited['comments'][1]['editedAt'])
        self.assertTrue(self.c.delete(f'{self.url}/{tid}/replies/{reply["id"]}').data['ok'])  # editors moderate
        self.assertIsNone(self.c.delete(f'{self.url}/{tid}/replies/{first.id}').data['thread'])  # last comment: thread goes
        self.assertFalse(CommentThread.objects.exists())

    def test_validation(self):
        start = TEXT.index('novel')
        base = {'path': 'main.tex', 'from': start, 'to': start + 5, 'quote': 'novel', 'body': 'x'}
        for bad in ({**base, 'path': '../x'}, {**base, 'path': 'fig.png'}, {**base, 'quote': ''}, {**base, 'to': start + 3},
                    {**base, 'from': 'a'}, {**base, 'body': ' '}, {**base, 'body': 'x' * 5001}):
            self.assertEqual(self.c.post(self.url, bad, format='json').status_code, 400, bad)

    def test_anchor_follows_edits_and_orphans(self):
        tid = self.create().data['thread']['id']
        files.write_text(self.project, 'main.tex', 'Added at the top.\n' + TEXT)
        thread = self.c.get(self.url).data['threads'][0]
        self.assertEqual(thread['anchor']['from'], TEXT.index('novel') + len('Added at the top.\n'))
        files.write_text(self.project, 'main.tex', TEXT.replace('novel', 'new'))
        thread = self.c.get(self.url).data['threads'][0]
        self.assertTrue(thread['orphaned'])
        self.assertIsNone(thread['anchor'])
        self.assertEqual(thread['id'], tid)

    def test_rename_moves_threads_and_delete_removes_them(self):
        files.write_text(self.project, 'sec/a.tex', TEXT)
        start = TEXT.index('novel')
        self.c.post(self.url, {'path': 'sec/a.tex', 'from': start, 'to': start + 5, 'quote': 'novel', 'body': 'x'}, format='json')
        files.rename(self.project, 'sec', 'chapters')
        self.assertEqual(CommentThread.objects.get().path, 'chapters/a.tex')
        self.assertFalse(self.c.get(self.url).data['threads'][0]['orphaned'])  # same text, new path
        files.delete(self.project, 'chapters/a.tex')
        self.assertFalse(CommentThread.objects.exists())
