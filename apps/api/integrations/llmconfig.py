"""Workspace-level LLM provider settings: the `llm` profile of a workspace (see aiprofiles). Kept as thin wrappers so the
existing /api/workspaces/:id/llm routes and callers work unchanged; only aiprofiles.usable() decrypts the key."""
from . import aiprofiles
from .aiprofiles import (LlmConfigError, MAX_DAILY_LIMIT, MAX_KEY_CHARS, UNSET, clean_daily_limit,  # noqa: F401
                         clean_endpoint)


def save(workspace, user, endpoint=None, model=None, api_key=None, daily_limit=UNSET):
    return aiprofiles.save(workspace, user, aiprofiles.LLM, endpoint, model, api_key, daily_limit)


def remove(workspace, user):
    return aiprofiles.remove(workspace, user, aiprofiles.LLM)


def workspace_llm_for(workspace, user):
    """({endpoint, model}, {apiKey}) if the workspace has an `llm` profile and `user` may use it, else None."""
    found = aiprofiles.usable(user, None, workspace, aiprofiles.LLM)
    return (found[0], {'apiKey': found[1]}) if found else None
