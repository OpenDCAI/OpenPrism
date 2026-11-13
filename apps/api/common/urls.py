from django.urls import path

from . import views

urlpatterns = [
    path('api/health', views.health),
    path('api/config', views.public_config),
    path('api/status', views.status),
    path('healthz', views.health),
    path('readyz', views.ready),
]
