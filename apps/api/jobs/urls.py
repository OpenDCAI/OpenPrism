from django.urls import path

from . import views

urlpatterns = [
    path('compile', views.start_compile),
    path('jobs/<uuid:pk>', views.job_status),
    path('jobs/<uuid:pk>/pdf', views.job_pdf),
    path('jobs/<uuid:pk>/cancel', views.job_cancel),
]
