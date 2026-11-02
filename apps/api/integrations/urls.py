from django.urls import path

from . import views

urlpatterns = [
    path('integrations/zotero', views.zotero_connection),
    path('integrations/zotero/libraries', views.zotero_libraries),
    path('integrations/zotero/collections', views.zotero_collections),
    path('integrations/zotero/items', views.zotero_items),
    path('integrations/zotero/bibtex', views.zotero_bibtex),
    path('projects/<uuid:pk>/zotero/add', views.zotero_add),
]
