"""New non-null columns carry a database default (#107).

During a rolling deploy, pods running the previous release keep inserting rows after the migration has added the new
column. Django's own `default=` is applied by the *new* code only, so the old code's INSERT would fail on a NOT NULL
column. `db_default=` puts the default in the database itself.
"""
from django.apps import apps
from django.conf import settings
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.operations import AddField
from django.db.models.fields import NOT_PROVIDED
from django.test import TestCase


def local_app_labels():
    base = str(settings.BASE_DIR)
    return {c.label for c in apps.get_app_configs() if str(c.path).startswith(base)}


class DbDefaultTests(TestCase):
    def added_columns(self):
        """(app, model, field) for every non-null column a migration added with a Python-side default."""
        labels = local_app_labels()
        out = []
        for (app, _name), migration in MigrationLoader(None, load=True).disk_migrations.items():
            if app not in labels:
                continue
            for op in migration.operations:
                if isinstance(op, AddField) and not op.field.null and op.field.default is not NOT_PROVIDED:
                    out.append((app, op.model_name, op.name))
        return out

    def test_every_added_non_null_column_has_a_database_default(self):
        missing = []
        for app, model, name in self.added_columns():
            field = apps.get_model(app, model)._meta.get_field(name)
            if field.db_default is NOT_PROVIDED:
                missing.append(f'{app}.{model}.{name}')
        self.assertEqual(missing, [], 'add db_default= (with a migration) to columns added to existing tables')

    def test_the_columns_that_broke_a_rollout_default_in_postgres(self):
        wanted = {('projects_workspace', 'color'), ('projects_workspace', 'kind'),
                  ('projects_workspaceinvite', 'send_failed'), ('versions_projectversion', 'status'),
                  ('versions_projectversion', 'log_key'), ('versions_projectversion', 'log_size')}
        with connection.cursor() as c:
            c.execute("SELECT table_name, column_name FROM information_schema.columns "
                      "WHERE table_schema = current_schema() AND column_default IS NOT NULL")
            have = set(c.fetchall())
        self.assertEqual(wanted - have, set())
