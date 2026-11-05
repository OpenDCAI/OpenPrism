"""Redis key names and the small cross-replica protocol, shared by rooms (async) and views (sync)."""
import hashlib
import time

KIND_UPDATE, KIND_AWARENESS, KIND_FLUSH, KIND_SYNC, KIND_EVICT = b'U', b'A', b'F', b'S', b'E'
KIND_CLOSE = b'C'  # the file was renamed or deleted: flush now (the flush finds out which) and close
KIND_REVOKE = b'R'  # on a project channel: payload is a revoked invite's id; its live connections are closed
ORIGIN_LEN = 16
HOLDER_FRESH_SECONDS = 90


def room_key(project_id, path):
    return f'{project_id}:{path}'


def _h(key):
    return hashlib.sha1(key.encode()).hexdigest()


def channel(key):
    return f'collab:room:{_h(key)}'


def doc_channel(doc_id):
    """Edits, cursors and catch-up requests of one stored document (CollabDoc). Not the path's channel: a room left
    over for a deleted file must not exchange edits with the room of a new file at the same path."""
    return f'collab:doc:{doc_id}'


def project_channel(project_id):
    """Every room of a project also listens here (messages about the whole project, e.g. a revoked invite link)."""
    return f'collab:project:{project_id}'


def holders_key(key):
    return f'collab:holders:{_h(key)}'  # zset: replica id -> last heartbeat


def conns_key(key):
    return f'collab:conns:{_h(key)}'  # hash: replica id -> connection count


def error_key(key):
    return f'collab:error:{_h(key)}'


# Update log (#56): every edit a replica receives from its own clients is also appended to its own list for the
# document until a flush covers it, so a replica that dies before flushing loses nothing.
LOGGED = 'collab:logged'  # set: CollabDoc ids that may have logs
INSTANCES = 'collab:instances'  # zset: replica id -> last heartbeat (any room); a replica not seen for a while is dead
LOG_TTL_SECONDS = 86400


def log_key(doc_id, instance_hex):
    return f'collab:log:{doc_id}:{instance_hex}'  # list of Yjs updates


def log_owners_key(doc_id):
    return f'collab:logs:{doc_id}'  # set: replica ids with a log for this document


def pack(kind, origin, payload=b''):
    return kind + origin + payload


def unpack(message):
    return message[:1], message[1:1 + ORIGIN_LEN], message[1 + ORIGIN_LEN:]


def fresh_since():
    return time.time() - HOLDER_FRESH_SECONDS
