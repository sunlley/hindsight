"""Operator-editable global settings, persisted to a JSON file.

The file overlays the environment when the config is built, so a value saved here wins over
``HINDSIGHT_API_LLM_PROVIDER`` / ``_MODEL`` / ``_BASE_URL`` / ``_API_KEY``. It is read at startup and
again when settings are saved, which rebuilds the engine's LLM clients without a restart.
It holds the API key in plain text, like a ``.env`` would, so it is written readable by its owner only.
"""

import json
import logging
import os
from pathlib import Path

from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

ENV_SETTINGS_FILE = "HINDSIGHT_API_SETTINGS_FILE"


class GlobalLLMSettings(BaseModel):
    """Global LLM overrides. ``None`` means "use the environment"."""

    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None


class AdminAccount(BaseModel):
    """The one account that signs in to the control plane page. The password is only ever stored hashed."""

    username: str
    password_hash: str


class GlobalAuthSettings(BaseModel):
    """How callers are let in: an API key for programs, an admin account for the control plane page."""

    api_key: str | None = None
    """The API access key clients must send as a Bearer token. ``None`` leaves the API open."""
    admin: AdminAccount | None = None
    """When set, the control plane page asks for this account's username and password."""
    session_secret: str | None = None
    """Signs the page's session tokens; replaced whenever the account changes, which ends every session."""


class GlobalSettings(BaseModel):
    llm: GlobalLLMSettings = GlobalLLMSettings()
    auth: GlobalAuthSettings = GlobalAuthSettings()


def settings_path() -> Path:
    return Path(os.getenv(ENV_SETTINGS_FILE) or Path.home() / ".hindsight" / "settings.json")


def load_global_settings() -> GlobalSettings:
    """Read the settings file; a missing or unreadable file means no overrides."""
    path = settings_path()
    try:
        return GlobalSettings.model_validate_json(path.read_text())
    except FileNotFoundError:
        return GlobalSettings()
    except (OSError, ValidationError, json.JSONDecodeError) as e:
        logger.warning("Ignoring unreadable global settings file %s: %s", path, e)
        return GlobalSettings()


def save_global_settings(settings: GlobalSettings) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename so a crash mid-write never leaves a truncated file for the next startup.
    tmp = path.with_suffix(path.suffix + ".tmp")
    # Created 0600 from the start, so the key is never readable by others even briefly.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(settings.model_dump_json(indent=2))
    tmp.replace(path)
