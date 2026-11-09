"""Jobs in the Django admin (v0.1.1, #81): status and error only. `params`, `result` and `progress_log` can hold
prompts, documents and model output, so they are not shown."""
from django.contrib import admin

from common.admin import ReadOnlyAdmin

from .models import Job


@admin.register(Job)
class JobAdmin(ReadOnlyAdmin):
    list_display = ('id', 'type', 'status', 'user', 'project', 'created_at', 'updated_at')
    list_filter = ('type', 'status')
    search_fields = ('id', 'user__email', 'project__name')
    fields = ('id', 'type', 'status', 'user', 'project', 'error', 'created_at', 'updated_at')
    list_select_related = ('user', 'project')
    date_hierarchy = 'created_at'
