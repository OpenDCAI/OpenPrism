from django.db import migrations


def mirror(apps, schema_editor):
    User = apps.get_model('accounts', 'User')
    EmailAddress = apps.get_model('account', 'EmailAddress')
    for user in User.objects.all().iterator():
        EmailAddress.objects.get_or_create(user=user, email=user.email, defaults={
            'primary': True, 'verified': user.email_verified_at is not None})


class Migration(migrations.Migration):
    dependencies = [('accounts', '0003_platform_invite'), ('account', '0009_emailaddress_unique_primary_email')]
    operations = [migrations.RunPython(mirror, migrations.RunPython.noop)]
