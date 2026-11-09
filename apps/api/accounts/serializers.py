from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.db import IntegrityError, transaction
from rest_framework import serializers

from projects.models import Membership, Workspace

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ('id', 'email', 'name', 'emailVerified', 'verificationRequired')

    emailVerified = serializers.SerializerMethodField()
    verificationRequired = serializers.SerializerMethodField()  # the app shows only the "check your email" screen

    def get_verificationRequired(self, user):
        from django.conf import settings
        return settings.REQUIRE_EMAIL_VERIFICATION and user.email_verified_at is None

    def get_emailVerified(self, user):
        return user.email_verified_at is not None


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
    name = serializers.CharField(required=False, allow_blank=True, max_length=150)
    invite = serializers.CharField(required=False, allow_blank=True, write_only=True, max_length=200)

    def validate_email(self, value):
        return value.lower()

    def validate_password(self, value):
        validate_password(value)
        return value

    def validate(self, data):
        # The sign-up gate comes first, so an uninvited visitor learns nothing about which addresses have accounts.
        from . import signup
        try:
            data['platform_invite'] = signup.check_signup(data['email'], data.get('invite'))
        except signup.SignupRefused as e:
            raise serializers.ValidationError({'detail': str(e)})
        if User.objects.filter(email=data['email']).exists():
            raise serializers.ValidationError({'email': 'An account with this email already exists.'})
        return data

    @transaction.atomic
    def create(self, data):
        from . import invitations
        from .verification import mark_verified, send_verification
        invite = data.get('platform_invite')
        if invite is not None:
            invite = invitations.lock(invite)  # a second request with the same link waits here, then finds it used
            if invite is None:
                raise serializers.ValidationError({'detail': signup_refused()})
        try:
            with transaction.atomic():
                user = User.objects.create_user(data['email'], data['password'], name=data.get('name', ''))
        except IntegrityError:  # the address was registered a moment ago
            raise serializers.ValidationError({'email': 'An account with this email already exists.'})
        if invite is not None:
            invitations.use(invite, user)
        workspace = Workspace.objects.create(name='Personal', kind=Workspace.PERSONAL, color='#5b6573')
        Membership.objects.create(workspace=workspace, user=user, role=Membership.OWNER)
        if invite is None:
            # Pending workspace invitations are accepted when the address is verified (accounts/verification.py).
            transaction.on_commit(lambda: send_verification(user))
            return user
        # The invitation reached this mailbox, so the address is verified now: no verification mail.
        mark_verified(user)
        if invite.workspace_id and invite.role:
            Membership.objects.get_or_create(workspace_id=invite.workspace_id, user=user, defaults={'role': invite.role})
        return user


def signup_refused():
    from .signup import REFUSED
    return REFUSED
