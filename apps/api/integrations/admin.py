"""Usage and credential history in the Django admin (v0.1.1, #81).

NOT registered, on purpose, because their rows hold encrypted keys: `ZoteroConnection`, `UserCredential` and
`WorkspaceLlmConfig` and `AiProfile`. Do not add them, and do not show `api_key_encrypted` or `last_four` anywhere. The event log below
leaves `last_four` and `detail` out for the same reason."""
from django.contrib import admin

from common.admin import ReadOnlyAdmin

from .models import CredentialEvent, LlmUsage


@admin.register(LlmUsage)
class LlmUsageAdmin(ReadOnlyAdmin):
    list_display = ('day', 'user', 'workspace', 'source', 'count')
    list_filter = ('source', 'day')
    search_fields = ('user__email', 'workspace__name')
    fields = ('day', 'user', 'workspace', 'source', 'count')
    list_select_related = ('user', 'workspace')


@admin.register(CredentialEvent)
class CredentialEventAdmin(ReadOnlyAdmin):
    list_display = ('created_at', 'kind', 'action', 'actor_name', 'workspace', 'owner')
    list_filter = ('kind', 'action')
    search_fields = ('actor_name', 'workspace__name', 'owner__email')
    fields = ('created_at', 'kind', 'action', 'actor_name', 'actor', 'workspace', 'owner')
    list_select_related = ('actor', 'workspace', 'owner')
