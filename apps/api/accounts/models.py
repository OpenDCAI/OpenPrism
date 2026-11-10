import uuid

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models


class UserManager(BaseUserManager):
    use_in_migrations = True

    def create_user(self, email, password=None, **extra):
        if not email:
            raise ValueError('Email is required')
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra):
        extra.setdefault('is_staff', True)
        extra.setdefault('is_superuser', True)
        return self.create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=150, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    email_verified_at = models.DateTimeField(null=True, blank=True)  # set by the link in the verification mail
    created_at = models.DateTimeField(auto_now_add=True)

    objects = UserManager()
    USERNAME_FIELD = 'email'

    def __str__(self):
        return self.email


class PlatformInvite(models.Model):
    """A superadmin's invitation for one email address to register on the platform (v0.1.2, #83). Only the SHA-256 of
    the token is stored; the raw token exists in the mailed link. Use accounts/invitations.py, not this table."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField()  # lower-case
    token_hash = models.CharField(max_length=64, unique=True)
    invited_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    last_sent_at = models.DateTimeField(null=True, blank=True)
    send_failed = models.BooleanField(default=False)  # the last mail could not be delivered after every retry
    revoked_at = models.DateTimeField(null=True, blank=True)
    used_at = models.DateTimeField(null=True, blank=True)
    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')  # the account it created
    workspace = models.ForeignKey('projects.Workspace', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    role = models.CharField(max_length=10, blank=True, default='')  # Membership role in `workspace`

    class Meta:
        indexes = [models.Index(fields=['email'])]

    def __str__(self):
        return self.email


class LinkedIdentity(models.Model):
    """An account at an outside identity provider (Google, ORCID) that signs in as `user` (v0.1.4, #98). `subject` is
    the provider's stable id for the person (never the email, which can change hands). Use accounts/social.py."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='identities')
    provider = models.CharField(max_length=20)
    subject = models.CharField(max_length=255)
    email = models.EmailField(blank=True)          # what the provider reported when it was linked (informational)
    email_verified = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_login_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['provider', 'subject'], name='unique_identity_per_provider')]

    def __str__(self):
        return f'{self.provider}:{self.subject}'
