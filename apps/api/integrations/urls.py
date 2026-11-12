from django.urls import path

from . import views

urlpatterns = [
    path('integrations/zotero', views.zotero_connection),
    path('workspaces/<uuid:pk>/llm', views.workspace_llm),
    path('workspaces/<uuid:pk>/ai', views.workspace_ai),
    path('workspaces/<uuid:pk>/ai/<str:profile>', views.workspace_ai_profile),
    path('workspaces/<uuid:pk>/llm/models', views.workspace_llm_models),
    path('workspaces/<uuid:pk>/llm/test', views.workspace_llm_test),
    path('workspaces/<uuid:pk>/credential-events', views.workspace_credential_events),
    path('integrations/credential-events', views.my_credential_events),
    path('integrations/ai-keys', views.ai_keys),
    path('integrations/ai-keys/<str:profile>', views.ai_key),
    path('integrations/zotero/libraries', views.zotero_libraries),
    path('integrations/zotero/collections', views.zotero_collections),
    path('integrations/zotero/items', views.zotero_items),
    path('integrations/zotero/bibtex', views.zotero_bibtex),
    path('projects/<uuid:pk>/zotero/add', views.zotero_add),
    path('projects/<uuid:pk>/ai', views.project_ai),
    path('projects/<uuid:pk>/ai/models', views.project_ai_models),
    path('projects/<uuid:pk>/ai/test', views.project_ai_test),
    path('projects/<uuid:pk>/ai/<str:profile>', views.project_ai_profile),
]
