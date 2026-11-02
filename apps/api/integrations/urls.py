from django.urls import path

from . import views

urlpatterns = [
    path('integrations/zotero', views.zotero_connection),
]
