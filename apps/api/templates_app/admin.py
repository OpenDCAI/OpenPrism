"""Templates in the Django admin (v0.1.1, #81): look only; their files are in storage and are managed through the app."""
from django.contrib import admin

from common.admin import ReadOnlyAdmin

from .models import Template


@admin.register(Template)
class TemplateAdmin(ReadOnlyAdmin):
    list_display = ('id', 'label', 'category', 'builtin', 'featured', 'author')
    list_filter = ('builtin', 'featured', 'category')
    search_fields = ('id', 'label', 'author')
    fields = ('id', 'label', 'main_file', 'category', 'description_en', 'tags', 'author', 'featured', 'builtin')
