# Doing Now

## v0.1.4 - Passkeys, social sign-in and sign-in methods

- [x] #96 Passkeys: register, list, rename, remove and sign in (API)
- [x] #97 Passkeys: Account page and sign-in with a passkey (UI)
- [x] #98 Social sign-in: Google and ORCID (OIDC) - link, sign in, gated sign-up (API)
- [x] #99 Social sign-in: buttons on sign-in and linking on the Account page (UI)
- [ ] #100 Sign-in methods page: one list, never remove the last, recent sign-ins
- [ ] #101 Release v0.1.4: deployment settings, provider setup docs and version

## v0.1.3 - Two-factor sign-in and one sign-in for the admin

- [x] #88 Auth: spike - django-allauth as a library behind our JWT login (go/no-go)
- [x] #89 Auth: foundation - allauth email addresses mirror our accounts
- [x] #90 Auth: change the account's email address
- [x] #91 Auth: two-factor (TOTP and recovery codes) at the API
- [x] #92 Auth: second factor in the app (Account page and sign-in)
- [x] #93 Admin: superadmins require two-factor; reset a locked-out user's second factor
- [x] #94 Admin: one sign-in for the app and the Django admin (B6)
- [x] #95 Release v0.1.3: deployment settings, docs and version

## v0.1.2 - Invitation-only access

- [x] #83 Invitations: PlatformInvite model, service and mail
- [x] #84 Invitations: registration requires an invitation (single sign-up gate)
- [x] #85 Invitations: superadmins manage them in the Django admin
- [x] #86 Invitations: public site and invitation link say access is by invitation
- [x] #87 Invitations: deployment settings, bootstrap and docs

## v0.1.1 - Superadmin support

- [x] #79 Admin: reach /admin/ through nginx and serve its static files
- [x] #80 Admin: superusers only, hardened session cookie and login rate limit
- [x] #81 Admin: register the models read-mostly, with no credentials and no deletes that skip cleanup
- [x] #82 Admin: make and revoke superadmins safely (command, last-superadmin guard, docs)
