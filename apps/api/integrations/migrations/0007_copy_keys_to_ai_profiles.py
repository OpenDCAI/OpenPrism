"""Copy stored AI keys into AiProfile (#78): each workspace provider becomes that workspace's `llm` profile (daily limit
kept) and each user's saved profiles move into their personal workspace. The ciphertext is copied as is: nothing is
decrypted, shown or logged. A workspace profile that already exists wins over a personal key for the same profile (the
workspace provider always took precedence). Personal keys of people with no personal workspace, or used only inside team
workspaces, are not carried over (they no longer apply). Idempotent: a second run changes nothing. The old tables are
left in place for one release and are no longer read."""
from django.db import migrations


def copy(apps, schema_editor):
    AiProfile = apps.get_model('integrations', 'AiProfile')
    WorkspaceLlmConfig = apps.get_model('integrations', 'WorkspaceLlmConfig')
    UserCredential = apps.get_model('integrations', 'UserCredential')
    Membership = apps.get_model('projects', 'Membership')

    for c in WorkspaceLlmConfig.objects.all():
        AiProfile.objects.get_or_create(workspace_id=c.workspace_id, profile='llm', defaults=dict(
            endpoint=c.endpoint, model=c.model, api_key_encrypted=c.api_key_encrypted, last_four=c.last_four,
            daily_limit=c.daily_limit, updated_by_id=c.updated_by_id))

    personal = {}
    for m in Membership.objects.filter(role='owner', workspace__kind='personal').order_by('id'):
        personal.setdefault(m.user_id, m.workspace_id)   # a user's own (first) personal workspace
    for c in UserCredential.objects.all():
        workspace_id = personal.get(c.user_id)
        if workspace_id is None:
            continue
        AiProfile.objects.get_or_create(workspace_id=workspace_id, profile=c.profile, defaults=dict(
            endpoint=c.endpoint, model=c.model, api_key_encrypted=c.api_key_encrypted, last_four=c.last_four,
            updated_by_id=c.user_id))


class Migration(migrations.Migration):
    dependencies = [
        ('integrations', '0006_aiprofile'),
        ('projects', '0007_db_defaults'),
    ]
    operations = [migrations.RunPython(copy, migrations.RunPython.noop)]
