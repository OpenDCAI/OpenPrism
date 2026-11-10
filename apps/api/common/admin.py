"""Shared pieces for the Django admin (v0.1.1, #81)."""
from django.contrib import admin


class ReadOnlyAdmin(admin.ModelAdmin):
    """List and look, never add, change or delete. Each subclass names the `fields` it shows, so a column added to a
    model later is not displayed until someone decides it may be."""
    actions = None
    list_per_page = 50

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
