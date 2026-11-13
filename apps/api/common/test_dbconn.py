"""Database connections are not kept open (#182): pool threads that go idle would hold them forever."""
import threading

from django.db import connection, connections
from django.test import TransactionTestCase

from collab.dbasync import db_async


class ConnectionLeakTests(TransactionTestCase):
    def test_db_async_closes_its_connection(self):
        seen = []

        def query():
            with connection.cursor() as c:
                c.execute('select 1')
            seen.append(connections['default'])
            return threading.get_ident()

        from asgiref.sync import async_to_sync
        async_to_sync(db_async(query))()
        self.assertIsNone(seen[0].connection, 'the pool thread kept its connection open')

    def test_default_is_no_persistent_connections(self):
        import importlib, os
        from unittest import mock
        from config import settings as s
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('DB_CONN_MAX_AGE', None)
            with mock.patch.object(s, 'TESTING', False):
                self.assertEqual(s._database()['CONN_MAX_AGE'], 0)
