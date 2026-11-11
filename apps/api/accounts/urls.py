from django.urls import path

from . import adminhandoff, emailchange, mfa, passkeys, signins, socialviews
from .e2e import E2ESuperuserView
from .passwords import ChangePasswordView, ForgotPasswordView, ResetPasswordView
from .verification import ResendVerificationView, VerifyEmailView
from .views import LoginView, LogoutView, MeView, RefreshView, RegisterView

urlpatterns = [
    path('e2e/superuser', E2ESuperuserView.as_view()),  # test stacks only, see accounts/e2e.py
    path('register', RegisterView.as_view()),
    path('login', LoginView.as_view()),
    path('refresh', RefreshView.as_view()),
    path('logout', LogoutView.as_view()),
    path('me', MeView.as_view()),
    path('verify-email', VerifyEmailView.as_view()),
    path('verify-email/resend', ResendVerificationView.as_view()),
    path('login/mfa', mfa.LoginMfaView.as_view()),
    path('email', emailchange.EmailView.as_view()),
    path('email/change', emailchange.RequestChangeView.as_view()),
    path('email/confirm', emailchange.ConfirmChangeView.as_view()),
    path('passkeys', passkeys.PasskeysView.as_view()),
    path('passkeys/options', passkeys.OptionsView.as_view()),
    path('passkeys/login/options', passkeys.LoginOptionsView.as_view()),
    path('passkeys/login', passkeys.LoginView.as_view()),
    path('passkeys/<str:pk>', passkeys.PasskeyView.as_view()),
    path('social', socialviews.IdentitiesView.as_view()),
    path('social/<str:pk>', socialviews.IdentityView.as_view()),
    path('social/<str:name>/start', socialviews.StartView.as_view()),
    path('social/<str:name>/callback', socialviews.CallbackView.as_view()),
    path('social/<str:name>/link-ticket', socialviews.LinkTicketView.as_view()),
    path('sign-ins', signins.SignInsView.as_view()),
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
