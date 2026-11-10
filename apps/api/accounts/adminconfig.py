"""Swaps Django's admin site for ours (see adminsite.py). Kept apart because INSTALLED_APPS imports it before apps load."""
from django.contrib.admin.apps import AdminConfig


class SuperuserAdminConfig(AdminConfig):
    default_site = 'accounts.adminsite.SuperuserAdminSite'
