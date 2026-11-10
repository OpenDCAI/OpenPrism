import httpx
from django.core import mail as outbox
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts import invitations, mfa
from accounts.fake_oidc import FakeOidc
from accounts.models import LinkedIdentity, User
from allauth.mfa.totp.internal import auth as totp
from projects.models import Membership, Workspace

PASSWORD = 'correct-horse-battery'


class SocialBase(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.fake = FakeOidc().start()
        cls.override = override_settings(SOCIAL_PROVIDERS={**cls.fake.settings('google'), **{'orcid': {**cls.fake.settings('orcid')['orcid']}}})
        cls.override.enable()

    @classmethod
    def tearDownClass(cls):
        cls.override.disable()
        cls.fake.stop()
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        self.fake.identity = {'sub': 'sub-1', 'email': 'ann@example.com', 'email_verified': True, 'name': 'Ann'}
        self.fake.tamper = self.fake.sign_with = self.fake.issuer_override = None

    def run_flow(self, client=None, name='google', intent='login', ticket='', next_path='/'):
        """Drive the browser's part: start, the provider's redirect, the callback. Returns the callback's response."""
        client = client or APIClient()
        start = client.get(f'/api/auth/social/{name}/start', {'intent': intent, 'ticket': ticket, 'next': next_path})
        self.assertEqual(start.status_code, 302, start.content)
        if not start['Location'].startswith(self.fake.base):
            return start   # refused before reaching the provider
        back = httpx.get(start['Location'], follow_redirects=False)
        self.assertEqual(back.status_code, 302)
        return client.get(back.headers['Location'].replace('http://localhost:5173', ''))

    def location(self, res):
        return res['Location']


class SignInTests(SocialBase):
    def test_a_linked_identity_signs_in_with_the_refresh_cookie_and_no_django_session(self):
        user = User.objects.create_user('ann@example.com', PASSWORD)
        LinkedIdentity.objects.create(user=user, provider='google', subject='sub-1')
        res = self.run_flow(next_path='/projects')
        self.assertEqual((res.status_code, res['Location']), (302, '/projects'))
        self.assertIn('openprism_refresh', res.cookies)
        self.assertNotIn('openprism_admin', res.cookies)
        self.assertTrue(res.cookies['openprism_refresh']['httponly'])
        refreshed = APIClient().post('/api/auth/refresh', {'refresh': res.cookies['openprism_refresh'].value}, format='json')
        self.assertEqual(refreshed.status_code, 200)

    def test_a_verified_email_links_to_an_existing_verified_account(self):
        from django.utils import timezone
        user = User.objects.create_user('ann@example.com', PASSWORD, email_verified_at=timezone.now())
        res = self.run_flow()
        self.assertEqual(res['Location'], '/')
        self.assertEqual(LinkedIdentity.objects.get(provider='google', subject='sub-1').user, user)
        self.assertEqual(User.objects.count(), 1)

    def test_an_unverified_account_is_not_inherited_by_whoever_owns_the_mailbox(self):
        User.objects.create_user('ann@example.com', PASSWORD)   # registered, never confirmed
        res = self.run_flow()
        self.assertEqual(res['Location'], '/login?error=verify_first')
        self.assertFalse(LinkedIdentity.objects.exists())
        self.assertNotIn('openprism_refresh', res.cookies)

    def test_an_unverified_provider_email_does_nothing(self):
        self.fake.identity['email_verified'] = False
        self.assertEqual(self.run_flow()['Location'], '/login?error=no_email')
        self.assertFalse(User.objects.exists())

    def test_totp_is_still_asked_for(self):
        from django.utils import timezone
        user = User.objects.create_user('ann@example.com', PASSWORD, email_verified_at=timezone.now())
        totp.TOTP.activate(user, totp.generate_totp_secret())
        LinkedIdentity.objects.create(user=user, provider='google', subject='sub-1')
        res = self.run_flow(next_path='/projects')
        self.assertTrue(res['Location'].startswith('/login?mfa='))
        self.assertNotIn('openprism_refresh', res.cookies)
        ticket = res['Location'].split('mfa=')[1].split('&')[0]
        self.assertEqual(mfa.redeem_ticket.__name__, 'redeem_ticket')
        self.assertEqual(APIClient().post('/api/auth/login/mfa', {'ticket': ticket, 'code': '000000'}, format='json').status_code, 400)


class SignUpTests(SocialBase):
    @override_settings(REGISTRATION_MODE='open')
    def test_open_mode_creates_a_verified_account_without_a_password(self):
        res = self.run_flow()
        self.assertEqual(res['Location'], '/')
        user = User.objects.get(email='ann@example.com')
        self.assertIsNotNone(user.email_verified_at)
        self.assertFalse(user.has_usable_password())
        self.assertEqual(user.name, 'Ann')
        self.assertTrue(Membership.objects.filter(user=user, role=Membership.OWNER).exists())
        self.assertEqual(user.identities.get().provider, 'google')
        self.assertEqual(len(outbox.outbox), 0)   # no verification mail: the provider proved the address

    @override_settings(REGISTRATION_MODE='invite')
    def test_invite_mode_refuses_the_uninvited(self):
        res = self.run_flow()
        self.assertEqual(res['Location'], '/login?error=not_invited')
        self.assertFalse(User.objects.exists())

    @override_settings(REGISTRATION_MODE='invite')
    def test_invite_mode_admits_an_invited_verified_address_into_its_workspace(self):
        lab = Workspace.objects.create(name='Lab')
        invitations.create('ann@example.com', None, workspace=lab, role=Membership.EDITOR)
        res = self.run_flow()
        self.assertEqual(res['Location'], '/')
        user = User.objects.get(email='ann@example.com')
        self.assertTrue(Membership.objects.filter(workspace=lab, user=user, role=Membership.EDITOR).exists())
        self.assertFalse(invitations.find_for_address('ann@example.com'))   # used
        self.assertEqual(self.run_flow()['Location'], '/')                  # and signing in again works

    @override_settings(REGISTRATION_MODE='invite')
    def test_an_invitation_for_another_address_does_not_help(self):
        invitations.create('bob@example.com', None)
        self.assertEqual(self.run_flow()['Location'], '/login?error=not_invited')

    @override_settings(REGISTRATION_MODE='open')
    def test_orcid_without_an_email_cannot_sign_up_but_a_linked_orcid_signs_in(self):
        self.fake.identity = {'sub': '0000-0002-1825-0097', 'name': 'Josiah'}
        self.assertEqual(self.run_flow(name='orcid')['Location'], '/login?error=no_email')
        user = User.objects.create_user('jo@example.com', PASSWORD)
        LinkedIdentity.objects.create(user=user, provider='orcid', subject='0000-0002-1825-0097')
        self.assertEqual(self.run_flow(name='orcid')['Location'], '/')


class LinkingTests(SocialBase):
    def setUp(self):
        super().setUp()
        self.user = User.objects.create_user('bob@example.com', PASSWORD)
        self.client = APIClient()
        res = self.client.post('/api/auth/login', {'email': 'bob@example.com', 'password': PASSWORD}, format='json')
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")

    def ticket(self, password=PASSWORD):
        return self.client.post('/api/auth/social/google/link-ticket', {'password': password}, format='json')

    def test_linking_needs_the_password_and_a_ticket_used_once(self):
        self.assertEqual(self.ticket('nope').status_code, 400)
        ticket = self.ticket().data['ticket']
        res = self.run_flow(intent='link', ticket=ticket)
        self.assertEqual(res['Location'], '/account?linked=google')
        self.assertEqual(self.user.identities.get().subject, 'sub-1')
        again = APIClient().get('/api/auth/social/google/start', {'intent': 'link', 'ticket': ticket})
        self.assertEqual(again['Location'], '/login?error=expired')

    def test_an_identity_cannot_be_linked_to_two_accounts(self):
        other = User.objects.create_user('cy@example.com', PASSWORD)
        LinkedIdentity.objects.create(user=other, provider='google', subject='sub-1')
        res = self.run_flow(intent='link', ticket=self.ticket().data['ticket'])
        self.assertEqual(res['Location'], '/login?error=linked_elsewhere')

    def test_list_and_unlink_and_never_the_last_way_in(self):
        self.run_flow(intent='link', ticket=self.ticket().data['ticket'])
        listing = self.client.get('/api/auth/social').data['providers']
        self.assertEqual([p['name'] for p in listing], ['google', 'orcid'])
        iid = listing[0]['linked']['id']
        self.assertEqual(self.client.delete(f'/api/auth/social/{iid}', {'password': 'nope'}, format='json').status_code, 400)
        self.assertEqual(self.client.delete(f'/api/auth/social/{iid}', {'password': PASSWORD}, format='json').status_code, 200)
        self.assertFalse(self.user.identities.exists())

    def test_the_last_method_is_protected(self):
        self.user.set_unusable_password()
        self.user.save()
        identity = LinkedIdentity.objects.create(user=self.user, provider='google', subject='only')
        res = self.client.delete(f'/api/auth/social/{identity.pk}', {'password': self.user.email}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('only way to sign in', res.data['error'])
        self.assertTrue(self.user.identities.exists())


class ProviderChecksTests(SocialBase):
    def callback_with(self, **tweaks):
        for k, v in tweaks.items():
            setattr(self.fake, k, v)
        return self.run_flow()

    def test_a_forged_expired_or_misdirected_token_is_refused(self):
        from cryptography.hazmat.primitives.asymmetric import rsa
        User.objects.create_user('ann@example.com', PASSWORD)
        LinkedIdentity.objects.create(user=User.objects.get(), provider='google', subject='sub-1')
        for label, tweaks in (
            ('another key', {'sign_with': rsa.generate_private_key(public_exponent=65537, key_size=2048)}),
            ('another issuer', {'issuer_override': 'https://evil.example'}),
            ('expired', {'tamper': lambda c: {**c, 'exp': 1}}),
            ('another audience', {'tamper': lambda c: {**c, 'aud': 'someone-else'}}),
            ('another nonce', {'tamper': lambda c: {**c, 'nonce': 'x'}}),
        ):
            self.setUp()
            res = self.callback_with(**tweaks)
            self.assertEqual(res['Location'], '/login?error=failed', label)
            self.assertNotIn('openprism_refresh', res.cookies, label)

    def test_state_works_once_and_a_denied_login_is_calm(self):
        client = APIClient()
        start = client.get('/api/auth/social/google/start')
        back = httpx.get(start['Location'], follow_redirects=False).headers['Location'].replace('http://localhost:5173', '')
        client.get(back)
        self.assertEqual(client.get(back)['Location'], '/login?error=expired')
        self.assertEqual(client.get('/api/auth/social/google/callback?error=access_denied')['Location'], '/login?error=denied')
        self.assertEqual(client.get('/api/auth/social/google/callback?state=zzz&code=1')['Location'], '/login?error=expired')

    def test_an_unconfigured_provider_and_a_foreign_state_are_refused(self):
        self.assertEqual(APIClient().get('/api/auth/social/github/start')['Location'], '/login?error=unavailable')
        start = APIClient().get('/api/auth/social/google/start')
        state = start['Location'].split('state=')[1].split('&')[0]
        self.assertEqual(APIClient().get(f'/api/auth/social/orcid/callback?state={state}&code=1')['Location'], '/login?error=expired')

    def test_next_must_be_a_local_path(self):
        User.objects.create_user('ann@example.com', PASSWORD)
        LinkedIdentity.objects.create(user=User.objects.get(), provider='google', subject='sub-1')
        for bad in ('https://evil.example', '//evil.example', '/\\evil'):
            self.assertEqual(self.run_flow(next_path=bad)['Location'], '/')

    def test_config_lists_the_enabled_providers_and_only_their_names(self):
        body = APIClient().get('/api/config').json()
        self.assertEqual(body['socialProviders'], [{'name': 'google', 'label': 'Google'}, {'name': 'orcid', 'label': 'Orcid'}])
        self.assertNotIn('s3cret', str(body))
