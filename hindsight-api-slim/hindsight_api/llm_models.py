"""List the models an LLM endpoint offers, for the control plane's model picker.

Three wire formats cover the supported providers: Anthropic's ``/v1/models``, Gemini's
``/v1beta/models`` and the OpenAI-style ``/models`` that every OpenAI-compatible server
(OpenAI, Groq, DeepSeek, OpenRouter, Ollama, LM Studio, gateways, ...) implements.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Literal

from .config import LLMConnection
from .engine.aiohttp_session import LoopLocalSession, per_phase_timeout, raise_for_status

logger = logging.getLogger(__name__)

ModelListStatus = Literal["listed", "auth_failed", "unreachable", "timeout", "unsupported", "invalid_response"]

_TIMEOUT_SECONDS = 15
_MAX_MODELS = 1000
_ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com"
_GEMINI_DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta"
_OPENAI_COMPATIBLE_DEFAULT_URLS = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "deepseek": "https://api.deepseek.com",
    "openrouter": "https://openrouter.ai/api/v1",
    "ollama": "http://localhost:11434/v1",
    "ollama-cloud": "https://ollama.com/v1",
    "lmstudio": "http://localhost:1234/v1",
}
# Providers that are not an HTTP endpoint with a model list (local CLIs, cloud IAM, no LLM).
# Headers (the key) go per request, so one session per loop serves every connection being edited.
_session = LoopLocalSession(timeout=per_phase_timeout(_TIMEOUT_SECONDS))
_UNLISTABLE = {"none", "mock", "claude-code", "openai-codex", "vertexai", "bedrock", "litellm", "litellmrouter"}


@dataclass(frozen=True)
class ModelList:
    status: ModelListStatus
    models: list[str]


def _unlisted(status: ModelListStatus) -> ModelList:
    return ModelList(status=status, models=[])


async def list_models(connection: LLMConnection) -> ModelList:
    """Ask the endpoint for its models. Failures become a status; the detail is only logged."""
    provider = connection.provider.lower()
    if provider in _UNLISTABLE:
        return _unlisted("unsupported")

    if provider == "anthropic":
        base = (connection.base_url or _ANTHROPIC_DEFAULT_URL).rstrip("/").removesuffix("/v1")
        url = f"{base}/v1/models?limit={_MAX_MODELS}"
        headers = {"anthropic-version": "2023-06-01"}
        if connection.api_key:
            headers["x-api-key"] = connection.api_key
    elif provider == "gemini":
        base = (connection.base_url or _GEMINI_DEFAULT_URL).rstrip("/")
        url = f"{base}/models?pageSize={_MAX_MODELS}"
        headers = {"x-goog-api-key": connection.api_key} if connection.api_key else {}
    else:
        base = connection.base_url or _OPENAI_COMPATIBLE_DEFAULT_URLS.get(provider)
        if not base:
            # No endpoint to ask: an unknown provider needs its base URL filled in first.
            return _unlisted("unsupported")
        url = f"{base.rstrip('/')}/models"
        headers = {"Authorization": f"Bearer {connection.api_key}"} if connection.api_key else {}

    try:
        # No redirects: the key must not follow a 30x to a host the operator never named.
        async with _session.get().get(url, headers=headers, allow_redirects=False) as response:
            if response.status in (401, 403):
                return _unlisted("auth_failed")
            await raise_for_status(response)
            payload = await response.json(content_type=None)
    except (TimeoutError, asyncio.TimeoutError):
        return _unlisted("timeout")
    except Exception as e:
        logger.warning("Listing models failed (provider=%s): %s", provider, e)
        return _unlisted("unreachable")

    models = _parse_models(provider, payload)
    return ModelList(status="listed", models=models) if models is not None else _unlisted("invalid_response")


def _parse_models(provider: str, payload: Any) -> list[str] | None:
    """Model ids from a response, or ``None`` when it is not a model list."""
    if not isinstance(payload, dict):
        return None
    if provider == "gemini":
        # Gemini also lists embedding and tuning models; only generative ones can answer a prompt.
        entries = payload.get("models")
        if not isinstance(entries, list):
            return None
        names = [
            str(e["name"]).removeprefix("models/")
            for e in entries
            if isinstance(e, dict) and "name" in e and "generateContent" in e.get("supportedGenerationMethods", [])
        ]
    else:
        entries = payload.get("data")
        if not isinstance(entries, list):
            return None
        names = [str(e["id"]) for e in entries if isinstance(e, dict) and "id" in e]
    return sorted(set(names))[:_MAX_MODELS]
