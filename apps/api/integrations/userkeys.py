"""A person's own AI keys. Since #78 these are the profiles of their personal workspace, so the settings UI that edits
"your keys" and the workspace settings are the same data; only that workspace's projects use them (a team workspace's
members use the team's settings). Saved and removed through the API, never returned, decrypted only by aiprofiles."""
from projects.models import Workspace

from . import aiprofiles
from .aiprofiles import LlmConfigError  # noqa: F401  (re-exported)

PROFILES = aiprofiles.PROFILES


def personal_workspace(user):
    return Workspace.objects.filter(kind=Workspace.PERSONAL, memberships__user=user, memberships__role='owner') \
        .order_by('created_at', 'id').first()


def status(user):
    ws = personal_workspace(user)
    if ws is None:
        return {p: None for p in PROFILES}
    return {p: ({k: v[k] for k in ('endpoint', 'model', 'lastFour', 'updatedAt')} if (v := s) else None)
            for p, s in aiprofiles.status(ws).items()}


def save(user, profile, endpoint=None, model=None, api_key=None):
    ws = personal_workspace(user)
    if ws is None:
        raise LlmConfigError('You have no personal workspace to keep this in.')
    return aiprofiles.save(ws, user, profile, endpoint, model, api_key)


def remove(user, profile):
    ws = personal_workspace(user)
    return bool(ws and aiprofiles.remove(ws, user, profile))


def resolve(user, profile):
    """({endpoint, model}, key) of the user's personal-workspace profile, or None. Accounts only."""
    ws = personal_workspace(user)
    found = aiprofiles.usable(user, None, ws, profile if profile in PROFILES else aiprofiles.LLM) if ws else None
    return (found[0], found[1]) if found else None
