from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('common.urls')),
    path('api/auth/', include('accounts.urls')),
    path('api/', include('projects.urls')),
    path('api/', include('jobs.urls')),
    path('api/', include('ai.urls')),
    path('api/', include('transfer.urls')),
    path('api/', include('collab.urls')),
    path('api/', include('integrations.urls')),
    path('api/', include('versions.urls')),
    path('api/', include('comments.urls')),
]
