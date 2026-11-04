from django.urls import path

from .passwords import ChangePasswordView, ForgotPasswordView, ResetPasswordView
from .views import LoginView, LogoutView, MeView, RefreshView, RegisterView

urlpatterns = [
    path('register', RegisterView.as_view()),
    path('login', LoginView.as_view()),
    path('refresh', RefreshView.as_view()),
    path('logout', LogoutView.as_view()),
    path('me', MeView.as_view()),
    path('password/forgot', ForgotPasswordView.as_view()),
    path('password/reset', ResetPasswordView.as_view()),
    path('password/change', ChangePasswordView.as_view()),
]
