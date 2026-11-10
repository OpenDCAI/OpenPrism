# Spike: django-allauth behind our JWT login (#88)

**Verdict: GO, as a library.** `django-allauth[mfa]` 65.21.1 supplies the second factor; our endpoints, SimpleJWT tokens
and the httpOnly refresh cookie stay exactly as they are.

## Shape
- Installed apps `allauth`, `allauth.account`, `allauth.mfa` (mfa depends on account) and `AccountMiddleware` (allauth
  refuses to start without it; it only records the current request). **No allauth URLs, views, forms or headless API are
  mounted**, and nothing uses Django sessions except the admin.
- Called directly: `allauth.mfa.totp.internal.auth` (`generate_totp_secret`, `TOTP.activate`, `validate_code`),
  `recovery_codes.internal.auth.RecoveryCodes`, `allauth.mfa.utils.is_mfa_enabled`. Rows live in `mfa_authenticator`.
- allauth stores secrets in the clear; `accounts/mfa_adapter.FernetMFAAdapter` encrypts them with
  `CREDENTIAL_ENCRYPTION_KEY` (same MultiFernet rotation as every stored credential).
- Proven by `accounts/test_mfa_library.py`: enrolment without a session, a TOTP code is single-use (replay guard in the
  Django cache, i.e. Redis, shared by replicas), recovery codes work once, secrets are not the plaintext.

## Why not allauth.headless
Its login flow keeps pending-state in a Django session (or an `X-Session-Token`) and issues its own session/tokens. We
would have to replace `api/auth.ts`, the cookie rules, URL tokens and the websocket auth to adopt it. As a library we get
the same TOTP/recovery/WebAuthn/social primitives without touching the token contract.

## The second step is ours
Password ok and a second factor exists: `/api/auth/login` returns `{mfaRequired, ticket}` (signed, short, single use) and
**no tokens**; `/api/auth/login/mfa` redeems it. Refresh tokens only exist after full sign-in, so `/refresh` cannot skip
the step; enabling a factor revokes earlier refresh tokens.

## What B3 and B4 need (v0.1.4)
- Passkeys: `allauth.mfa.webauthn` (needs `fido2`, already pulled in by the extra); the relying-party id is the public host
  and the ceremony state (challenge) must be kept server side by us (signed token or cache), not in a session.
- Social: `allauth.socialaccount` models and provider code can be used for the OAuth dance, but its redirect/callback views
  assume sessions; we will either run the callback on a small view of ours that finishes with our tokens, or mount
  allauth's browser flow for that one path only. Sign-up must pass `accounts.signup.check_signup` either way.
