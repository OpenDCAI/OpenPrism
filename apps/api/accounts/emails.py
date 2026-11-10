"""allauth's `EmailAddress` mirrors each account's address and verified state (#89). `User.email` and
`User.email_verified_at` stay the source of truth; the row exists so social sign-in and email change can rely on
allauth's model. Kept in step by a post_save signal on User, so no writer can forget it; code that updates in bulk
(`QuerySet.update` sends no signal) must call `sync()` itself."""
from allauth.account.models import EmailAddress
from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver


def sync(user):
    with transaction.atomic():
        EmailAddress.objects.filter(user=user, primary=True).exclude(email__iexact=user.email).update(primary=False)
        row = EmailAddress.objects.filter(user=user, email__iexact=user.email).first()
        verified = user.email_verified_at is not None
        if row is None:
            EmailAddress.objects.create(user=user, email=user.email, primary=True, verified=verified)
        elif (row.verified, row.primary) != (verified, True):
            row.verified, row.primary = verified, True
            row.save(update_fields=['verified', 'primary'])


@receiver(post_save, sender='accounts.User', dispatch_uid='accounts.emails.sync')
def _sync_on_save(sender, instance, **kwargs):
    sync(instance)
