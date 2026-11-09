"""Project versions in the Django admin (v0.1.1, #81): the list only, without manifests, PDFs or logs."""
from django.contrib import admin

from common.admin import ReadOnlyAdmin

from .models import ProjectVersion


@admin.register(ProjectVersion)
class ProjectVersionAdmin(ReadOnlyAdmin):
    list_display = ('project', 'number', 'name', 'status', 'engine', 'created_by', 'created_at')
    list_filter = ('status', 'engine')
    search_fields = ('project__name', 'name')
    fields = ('id', 'project', 'number', 'name', 'status', 'main_file', 'engine', 'created_by', 'created_at', 'pdf_size')
    list_select_related = ('project', 'created_by')
