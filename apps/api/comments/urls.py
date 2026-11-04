from django.urls import path

from . import views

urlpatterns = [
    path('projects/<uuid:pk>/comments', views.threads),
    path('projects/<uuid:pk>/comments/<uuid:thread_id>', views.thread_detail),
    path('projects/<uuid:pk>/comments/<uuid:thread_id>/replies', views.replies),
    path('projects/<uuid:pk>/comments/<uuid:thread_id>/replies/<uuid:comment_id>', views.reply_detail),
]
