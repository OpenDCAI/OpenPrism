from django.urls import include, path

from . import views as v
from . import workspaces as w

urlpatterns = [
    path('workspaces', w.collection),
    path('workspaces/<uuid:pk>', w.detail),
    path('workspaces/<uuid:pk>/leave', w.leave),
    path('workspaces/<uuid:pk>/members', w.invite_member),
    path('workspaces/<uuid:pk>/members/<str:member_id>', w.member),
    path('workspaces/<uuid:pk>/members/<str:member_id>/resend', w.resend_invite),
    path('url-token', v.url_token),
    path('projects', v.projects_collection),
    path('projects/import-zip', v.import_zip),
    path('projects/import-arxiv-sse', v.import_arxiv_sse),
    path('projects/<uuid:pk>', v.project_trash_delete),
    path('projects/<uuid:pk>/permanent', v.project_permanent_delete),
    path('projects/<uuid:pk>/rename-project', v.rename_project),
    path('projects/<uuid:pk>/copy', v.copy_project),
    path('projects/<uuid:pk>/workspace', w.move_project),
    path('projects/<uuid:pk>/tags', v.project_tags),
    path('projects/<uuid:pk>/archive', v.project_archive),
    path('projects/<uuid:pk>/trash', v.project_trash),
    path('projects/<uuid:pk>/tree', v.tree),
    path('projects/<uuid:pk>/file-order', v.file_order),
    path('projects/<uuid:pk>/file', v.file_item),
    path('projects/<uuid:pk>/blob', v.blob),
    path('projects/<uuid:pk>/export', v.export),
    path('projects/<uuid:pk>/upload', v.upload),
    path('projects/<uuid:pk>/uploads', v.uploads_start),
    path('projects/<uuid:pk>/uploads/complete', v.uploads_complete),
    path('projects/<uuid:pk>/files', v.all_files),
    path('projects/<uuid:pk>/folder', v.create_folder),
    path('projects/<uuid:pk>/rename', v.rename_path),
    path('projects/<uuid:pk>/template', v.apply_template),
    path('projects/<uuid:pk>/convert-template', v.convert_template),
    path('', include('templates_app.urls')),
]
