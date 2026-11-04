from django.urls import path

from . import views

urlpatterns = [
    path('projects/<uuid:pk>/versions', views.versions_collection),
    path('projects/<uuid:pk>/versions/diff', views.versions_diff),
    path('projects/<uuid:pk>/versions/<uuid:version_id>', views.version_detail),
    path('projects/<uuid:pk>/versions/<uuid:version_id>/pdf', views.version_pdf),
    path('projects/<uuid:pk>/versions/<uuid:version_id>/file', views.version_file),
    path('projects/<uuid:pk>/versions/<uuid:version_id>/log', views.version_log),
    path('projects/<uuid:pk>/versions/<uuid:version_id>/restore', views.version_restore),
    path('projects/<uuid:pk>/versions/<uuid:version_id>/restore-file', views.version_restore_file),
]
