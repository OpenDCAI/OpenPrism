from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.db import transaction
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

    def validate_email(self, value):
        from django.conf import settings
        from projects.models import WorkspaceInvite
        value = value.lower()
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError('An account with this email already exists.')
        if settings.REGISTRATION_MODE == 'invite' and not WorkspaceInvite.objects.filter(email=value).exists():
            raise serializers.ValidationError('Registration is by invitation only. Ask a workspace owner to invite this address.')
        return value

    def validate_password(self, value):
        validate_password(value)
        return value

    @transaction.atomic
    def create(self, data):
        user = User.objects.create_user(data['email'], data['password'], name=data.get('name', ''))
        workspace = Workspace.objects.create(name='Personal', kind=Workspace.PERSONAL, color='#5b6573')
        Membership.objects.create(workspace=workspace, user=user, role=Membership.OWNER)
        # Pending workspace invitations are accepted when the address is verified (accounts/verification.py).
        from .verification import send_verification
        transaction.on_commit(lambda: send_verification(user))
        return user
