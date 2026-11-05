"""Live collaboration rooms.

One Room per open file per server process. It owns a pycrdt Doc, fans client edits out to the other local
connections, and talks to the other replicas over Redis pub/sub. Postgres holds the durable Yjs state; every flush
merges with it, which heals any pub/sub message a replica missed.
"""
import asyncio
import hashlib
import json
import logging
import time
import uuid

import redis.asyncio as aioredis
from django.conf import settings
from pycrdt import (Awareness, Doc, Text, YMessageType, YSyncMessageType, create_awareness_message,
                    create_sync_message, create_update_message, handle_sync_message, read_message)

from . import coord, store
from .dbasync import db_async

log = logging.getLogger(__name__)
AWARENESS = YMessageType.AWARENESS
WRITE_SYNC_TYPES = (YSyncMessageType.SYNC_STEP2, YSyncMessageType.SYNC_UPDATE)
OUTBOX_LIMIT = 2000
REMOTE, DB = 'remote', 'db'  # origins that must not be re-published to other replicas
CLOSE_FILE_GONE = 4404  # the file was renamed or deleted; a text frame before the close says which (clients must not reconnect)


def read_var_uint(buf, pos):
    result, shift = 0, 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, pos
        shift += 7


def awareness_client_ids(update):
    """Client ids in an awareness update (so a dropped connection can remove its cursors)."""
    try:
        count, pos = read_var_uint(update, 0)
        ids = []
        for _ in range(count):
            client_id, pos = read_var_uint(update, pos)
            _, pos = read_var_uint(update, pos)  # clock
            length, pos = read_var_uint(update, pos)
            pos += length  # JSON state
            ids.append(client_id)
        return ids
    except IndexError:
        return []


class Conn:
    """One websocket client. Outgoing messages are queued so Yjs callbacks (synchronous) never block."""

    def __init__(self, send, can_write, invite_id=None, on_revoke=None, close=None):
        self.send, self.can_write = send, can_write
        self.close_socket = close  # async (code, reason): close the websocket
        self.invite_id = invite_id  # set when the client joined with an invite link (it can be revoked)
        self.on_revoke = on_revoke
        self.awareness_ids = set()
        self.outbox = asyncio.Queue(OUTBOX_LIMIT)
        self.closed = False
        self._task = asyncio.ensure_future(self._pump())
        self.on_overflow = None

    def push(self, message):
        if self.closed:
            return
        try:
            self.outbox.put_nowait(message)
        except asyncio.QueueFull:  # a client that cannot keep up reconnects and resyncs instead of stalling the room
            self.closed = True
            if self.on_overflow:
                self.on_overflow()

    async def _pump(self):
        try:
            while True:
                message = await self.outbox.get()
                if isinstance(message, tuple):  # ('close', code, reason): after everything queued before it
                    if self.close_socket:
                        await self.close_socket(message[1], message[2])
                    break
                await self.send(message)
        except Exception:
            self.closed = True

    def close(self):
        self.closed = True
        self._task.cancel()

    def finish(self, notice, code, reason):
        """Send a last text frame (JSON), then close the socket with `code`; the pump stops after it."""
        if self.closed:
            return
        self.closed = True
        for message in (notice, ('close', code, reason)):
            try:
                self.outbox.put_nowait(message)
            except asyncio.QueueFull:
                self._task.cancel()
                if self.close_socket:
                    asyncio.ensure_future(self.close_socket(code, reason))
                return


class Room:
    def __init__(self, manager, project_id, path):
        self.manager, self.project_id, self.path = manager, project_id, path
        self.key = coord.room_key(project_id, path)
        self.doc_id = None  # the CollabDoc this room loaded; renames move it, deletes remove it (see store.flush)
        self.ydoc = Doc()
        self.text = self.ydoc.get('content', type=Text)
        self.awareness = Awareness(self.ydoc)
        self.awareness.set_local_state(None)  # the server is not a participant
        self.conns = set()
        self.last_error = None
        self._origin = None  # who caused the update currently being applied (set only around synchronous applies)
        self._dirty = asyncio.Event()
        self._flush_lock = asyncio.Lock()
        self._tasks = []
        self._evict = None
        self.closed = asyncio.Event()
        self._closing = False

    # ---- lifecycle ----
    async def start(self):
        state, self.doc_id = await db_async(store.load)(self.project_id, self.path)
        self._apply(state, DB)
        self.ydoc.observe(self._on_doc_update)
        self.awareness.observe(self._on_awareness)
        redis = self.manager.redis
        self._pubsub = redis.pubsub()
        await self._pubsub.subscribe(coord.channel(self.key), coord.doc_channel(self.doc_id),
                                     coord.project_channel(self.project_id))
        # Edits and cursors that only live in another replica's memory (not flushed yet, or announced before we
        # subscribed) never reach us on their own: ask the replicas that already hold this room to catch us up.
        self._publish(coord.KIND_SYNC, self.ydoc.get_state())
        self._tasks = [asyncio.ensure_future(self._listen()), asyncio.ensure_future(self._run())]
        await self._heartbeat()

    async def shutdown(self):
        self._closing = True
        self.manager.rooms.pop(self.key, None)  # new connections now get a fresh room (after we finish flushing)
        for task in self._tasks:
            task.cancel()
        try:
            await self.flush()
        finally:
            if not self.closed.is_set():
                await self._leave()

    # ---- connections ----
    def add_conn(self, conn):
        self.conns.add(conn)
        if self._evict:
            self._evict.cancel()
            self._evict = None
        conn.on_overflow = lambda: self.remove_conn(conn)
        conn.push(create_sync_message(self.ydoc))  # pycrdt helpers return complete messages
        states = list(self.awareness.states.keys())
        if states:
            conn.push(create_awareness_message(self.awareness.encode_awareness_update(states)))
        asyncio.ensure_future(self._publish_conns())

    def remove_conn(self, conn):
        if conn not in self.conns:
            return
        self.conns.discard(conn)
        conn.close()
        if conn.awareness_ids:
            self.awareness.remove_awareness_states(list(conn.awareness_ids), conn)
        asyncio.ensure_future(self._publish_conns())
        if not self.conns and not self._closing:
            self._evict = asyncio.ensure_future(self._evict_later())

    async def _evict_later(self):
        await asyncio.sleep(settings.COLLAB_ROOM_EVICT_SECONDS)
        if not self.conns:
            await self.shutdown()

    # ---- messages from a client ----
    def handle(self, conn, data):
        """Process one binary websocket message. Malformed input is dropped, never fatal."""
        if not data:
            return
        try:
            kind = data[0]
            if kind == YMessageType.SYNC:
                if len(data) > 1 and data[1] in WRITE_SYNC_TYPES and not conn.can_write:
                    return  # read-only guests may receive but not change the document
                self._origin = conn
                try:
                    reply = handle_sync_message(data[1:], self.ydoc)
                finally:
                    self._origin = None
                if reply:
                    conn.push(reply)
            elif kind == AWARENESS:
                update = read_message(data[1:])
                conn.awareness_ids.update(awareness_client_ids(update))
                self.awareness.apply_awareness_update(update, conn)
        except Exception:
            log.warning('dropped malformed collab message for %s', self.key, exc_info=True)

    # ---- document / awareness events ----
    def _apply(self, update, origin):
        self._origin = origin
        try:
            self.ydoc.apply_update(update)
        finally:
            self._origin = None

    def _on_doc_update(self, event):
        origin = self._origin
        message = create_update_message(event.update)
        for conn in list(self.conns):
            if conn is not origin:
                conn.push(message)
        if origin not in (REMOTE, DB):
            self._publish(coord.KIND_UPDATE, event.update)
        if origin != DB:
            self._dirty.set()

    def _on_awareness(self, topic, payload):
        if topic != 'update':
            return
        changes, origin = payload
        ids = changes['added'] + changes['updated'] + changes['removed']
        if not ids:
            return
        update = self.awareness.encode_awareness_update(ids)
        message = create_awareness_message(update)
        for conn in list(self.conns):
            if conn is not origin:
                conn.push(message)
        if origin != REMOTE:
            self._publish(coord.KIND_AWARENESS, update)

    # ---- other replicas ----
    def _publish(self, kind, payload=b''):
        asyncio.ensure_future(self.manager.publish(coord.doc_channel(self.doc_id), coord.pack(kind, self.manager.instance, payload)))

    async def _listen(self):
        try:
            async for item in self._pubsub.listen():
                if item.get('type') != 'message':
                    continue
                kind, origin, payload = coord.unpack(item['data'])
                if origin == self.manager.instance:
                    continue
                try:
                    if kind == coord.KIND_UPDATE:
                        self._apply(payload, REMOTE)
                    elif kind == coord.KIND_AWARENESS:
                        self.awareness.apply_awareness_update(payload, REMOTE)
                    elif kind == coord.KIND_SYNC:
                        self._answer_sync(payload)
                    elif kind == coord.KIND_FLUSH:
                        await self.flush()
                        await self.manager.redis.rpush(payload.decode(), self.manager.instance_hex)
                    elif kind == coord.KIND_CLOSE and not self._closing:
                        await self.flush()  # finds the file renamed or deleted, and closes the room
                    elif kind == coord.KIND_REVOKE:
                        self._drop_invite(payload.decode())
                    elif kind == coord.KIND_EVICT and not self.conns and not self._closing:
                        asyncio.ensure_future(self.shutdown())  # idle room: flush, leave, and forget this file's text
                except Exception:
                    log.exception('bad collab message for %s', self.key)
        except asyncio.CancelledError:
            raise

    def _drop_invite(self, invite_id):
        """Close every connection that joined with a now-revoked invite link."""
        for conn in list(self.conns):
            if conn.invite_id == invite_id:
                if conn.on_revoke:
                    asyncio.ensure_future(conn.on_revoke())
                self.remove_conn(conn)

    def _answer_sync(self, their_state):
        """A replica just opened this room: send it what it lacks, and every cursor we know about."""
        update = self.ydoc.get_update(their_state)
        if update != b'\x00\x00':
            self._publish(coord.KIND_UPDATE, update)
        states = list(self.awareness.states.keys())
        if states:
            self._publish(coord.KIND_AWARENESS, self.awareness.encode_awareness_update(states))

    async def _run(self):
        """Debounced persistence, plus a periodic merge with the DB even when idle (anti-entropy)."""
        debounce = settings.COLLAB_FLUSH_DEBOUNCE_MS / 1000
        while True:
            try:
                await asyncio.wait_for(self._dirty.wait(), timeout=settings.COLLAB_SYNC_INTERVAL_SECONDS)
                await asyncio.sleep(debounce)
            except asyncio.TimeoutError:
                pass
            await self.flush()
            await self._heartbeat()

    async def flush(self):
        """Persist now. Serialised per room; always merges with what the DB already holds."""
        async with self._flush_lock:
            self._dirty.clear()
            try:
                status, merged, path = await db_async(store.flush)(self.project_id, self.path, self.doc_id, self.ydoc.get_update())
                if status != store.OK:
                    asyncio.ensure_future(self._file_gone(status, path))
                    return
                self._apply(merged, DB)  # picks up anything another replica persisted that we missed
                if self.last_error:
                    self.last_error = None
                    await self.manager.redis.delete(coord.error_key(self.key))
            except Exception as exc:
                log.exception('collab flush failed for %s', self.key)
                self.last_error = str(exc)
                await self.manager.redis.set(coord.error_key(self.key), self.last_error, ex=3600)

    async def _file_gone(self, status, new_path):
        """The file was renamed (its text already flushed to `new_path`) or deleted: tell the clients, close them, and
        go away without another flush (it would recreate the file)."""
        if self._closing:
            return
        self._closing = True
        if self.manager.rooms.get(self.key) is self:
            self.manager.rooms.pop(self.key)
        reason = 'renamed' if status == store.MOVED else 'deleted'
        notice = json.dumps({'type': 'closed', 'reason': reason, 'path': self.path, 'to': new_path})
        for conn in list(self.conns):
            conn.finish(notice, CLOSE_FILE_GONE, f'File {reason}')
        self.conns.clear()
        if self._evict:
            self._evict.cancel()
        for task in self._tasks:
            if task is not asyncio.current_task():
                task.cancel()
        await self._leave()

    async def _leave(self):
        try:
            await self._pubsub.unsubscribe()
            await self._pubsub.aclose()
            pipe = self.manager.redis.pipeline()
            pipe.zrem(coord.holders_key(self.key), self.manager.instance_hex)
            pipe.hdel(coord.conns_key(self.key), self.manager.instance_hex)
            await pipe.execute()
        except Exception:
            log.exception('collab room cleanup failed for %s', self.key)
        self.closed.set()

    async def _heartbeat(self):
        pipe = self.manager.redis.pipeline()
        pipe.zadd(coord.holders_key(self.key), {self.manager.instance_hex: time.time()})
        pipe.expire(coord.holders_key(self.key), 3600)
        pipe.hset(coord.conns_key(self.key), self.manager.instance_hex, len(self.conns))
        pipe.expire(coord.conns_key(self.key), 3600)
        await pipe.execute()

    async def _publish_conns(self):
        try:
            await self.manager.redis.hset(coord.conns_key(self.key), self.manager.instance_hex, len(self.conns))
        except Exception:
            pass


class RoomManager:
    """The per-process registry of rooms. Tests create several to simulate multiple replicas."""

    def __init__(self):
        self.instance = uuid.uuid4().bytes
        self.instance_hex = self.instance.hex()
        self.rooms = {}
        self._locks = {}
        self._redis = None

    @property
    def redis(self):
        if self._redis is None:
            self._redis = aioredis.Redis.from_url(settings.REDIS_URL)
        return self._redis

    async def publish(self, channel, message):
        try:
            await self.redis.publish(channel, message)
        except Exception:
            log.exception('collab publish failed on %s', channel)

    async def get_room(self, project_id, path):
        key = coord.room_key(project_id, path)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            room = self.rooms.get(key)
            if room is not None and room._closing:
                await room.closed.wait()  # let a shutting-down room finish its final flush first
                room = None
            if room is None:
                room = Room(self, project_id, path)
                await room.start()
                self.rooms[key] = room
            return room

    async def close_all(self):
        for room in list(self.rooms.values()):
            await room.shutdown()


default_manager = RoomManager()
