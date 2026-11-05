from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.utils import timezone

from .models import LlmUsage


@shared_task(name='integrations.tasks.prune_llm_usage')
def prune_llm_usage():
    """Daily: drop usage counts older than LLM_USAGE_KEEP_DAYS."""
    cutoff = timezone.now().date() - timedelta(days=settings.LLM_USAGE_KEEP_DAYS)
    return LlmUsage.objects.filter(day__lt=cutoff).delete()[0]
