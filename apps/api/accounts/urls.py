from django.urls import path

from . import adminhandoff, mfa
from .passwords import ChangePasswordView, ForgotPasswordView, ResetPasswordView
from .verification import ResendVerificationView, VerifyEmailView
from .views import LoginView, LogoutView, MeView, RefreshView, RegisterView

urlpatterns = [
    path('register', RegisterView.as_view()),
    path('login', LoginView.as_view()),
    path('refresh', RefreshView.as_view()),
    path('logout', LogoutView.as_view()),
    path('me', MeView.as_view()),
    path('verify-email', VerifyEmailView.as_view()),
    path('verify-email/resend', ResendVerificationView.as_view()),
    path('login/mfa', mfa.LoginMfaView.as_view()),
    path('admin-handoff', adminhandoff.AdminHandoffView.as_view()),
    path('mfa', mfa.StatusView.as_view()),
    path('mfa/totp/setup', mfa.SetupView.as_view()),
    path('mfa/totp/enable', mfa.EnableView.as_view()),
    path('mfa/recovery-codes', mfa.RecoveryCodesView.as_view()),
    path('mfa/disable', mfa.DisableView.as_view()),
    path('password/forgot', ForgotPasswordView.as_view()),
    path('password/reset', ResetPasswordView.as_view()),
    path('password/change', ChangePasswordView.as_view()),
]
