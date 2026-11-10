from django.apps import AppConfig


class AccountsConfig(AppConfig):
    name = 'accounts'

    def ready(self):
        from . import emails  # noqa: F401  (connects the signal that mirrors addresses into allauth)
