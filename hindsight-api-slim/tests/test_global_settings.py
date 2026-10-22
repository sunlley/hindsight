"""Global LLM settings: the JSON overlay on the environment and the /v1/default/settings/llm API.

Deterministic, no LLM calls.
"""

import os
import signal
import stat
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import pytest_asyncio

from hindsight_api.api import create_app
from hindsight_api.config import HindsightConfig, clear_config_cache
from hindsight_api.engine.memory_engine import LLMSettingsRejected, _LlmProbeOutcome
from hindsight_api.extensions import AuthenticationError
from hindsight_api.extensions.builtin.tenant import DefaultTenantExtension
from hindsight_api.global_settings import (
    GlobalSettingsUnreadable,
    GlobalLLMSettings,
    GlobalSettings,
    load_global_settings,
    save_global_settings,
    settings_path,
)
from hindsight_api.llm_models import ModelList

URL = "/v1/default/settings/llm"


@pytest.fixture(autouse=True)
def _settings_file(tmp_path, monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "openai")
    monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "env-model")
    monkeypatch.setenv("HINDSIGHT_API_LLM_BASE_URL", "http://env.example/v1")
    monkeypatch.setenv("HINDSIGHT_API_LLM_API_KEY", "env-key-0000")
    clear_config_cache()
    yield
    clear_config_cache()


def test_a_missing_file_means_no_overrides():
    assert load_global_settings() == GlobalSettings()


def test_an_unreadable_file_stops_the_server_instead_of_opening_the_api(tmp_path):
    """It holds the API key and the page login: reading it as empty would start the server open."""
    (tmp_path / "settings.json").write_text("{not json")
    with pytest.raises(GlobalSettingsUnreadable, match="settings.json"):
        load_global_settings()
    with pytest.raises(GlobalSettingsUnreadable):
        HindsightConfig.from_env()


def test_settings_file_is_owner_only():
    save_global_settings(GlobalSettings(llm=GlobalLLMSettings(provider="openai", api_key="secret-key")))
    assert stat.S_IMODE(settings_path().stat().st_mode) == 0o600


def test_saved_values_override_environment():
    save_global_settings(
        GlobalSettings(
            llm=GlobalLLMSettings(provider="anthropic", model="m", base_url="http://x/v1", api_key="saved-key")
        )
    )
    config = HindsightConfig.from_env()
    assert (config.llm_provider, config.llm_model, config.llm_base_url, config.llm_api_key) == (
        "anthropic",
        "m",
        "http://x/v1",
        "saved-key",
    )


def test_same_provider_inherits_unset_values_from_environment():
    save_global_settings(GlobalSettings(llm=GlobalLLMSettings(provider="openai", model="saved-model")))
    config = HindsightConfig.from_env()
    assert config.llm_model == "saved-model"
    assert (config.llm_base_url, config.llm_api_key) == ("http://env.example/v1", "env-key-0000")


def test_the_environment_key_never_follows_a_saved_url_to_another_host():
    save_global_settings(GlobalSettings(llm=GlobalLLMSettings(provider="openai", base_url="https://elsewhere/v1")))
    config = HindsightConfig.from_env()
    assert config.llm_base_url == "https://elsewhere/v1"
    assert config.llm_api_key is None


def test_other_provider_does_not_inherit_environment_values():
    save_global_settings(GlobalSettings(llm=GlobalLLMSettings(provider="groq")))
    config = HindsightConfig.from_env()
    assert config.llm_provider == "groq"
    assert config.llm_model != "env-model"
    assert (config.llm_base_url, config.llm_api_key) == (None, None)


def test_empty_settings_keep_environment():
    config = HindsightConfig.from_env()
    assert (config.llm_provider, config.llm_model, config.llm_api_key) == ("openai", "env-model", "env-key-0000")


@pytest_asyncio.fixture
async def api_client(monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_ENABLE_GLOBAL_SETTINGS_API", "true")
    clear_config_cache()
    # The settings endpoints barely touch the engine, so a stand-in avoids booting a database.
    memory = MagicMock()
    # The real reload rebuilds the config from the saved file; that is what the endpoint reports from.
    memory._authenticate_tenant = AsyncMock()
    memory.tenant_extension = DefaultTenantExtension(config={})
    memory.reload_llm_settings = AsyncMock(side_effect=clear_config_cache)
    memory.probe_llm_connection = AsyncMock(return_value=_LlmProbeOutcome(ok=True, status="connected", latency_ms=12.0))
    app = create_app(memory, initialize_memory=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        client.memory = memory  # ty: ignore[unresolved-attribute]
        yield client


@pytest.mark.asyncio
async def test_api_disabled_by_default(api_client, monkeypatch):
    monkeypatch.delenv("HINDSIGHT_API_ENABLE_GLOBAL_SETTINGS_API")
    clear_config_cache()
    assert (await api_client.get(URL)).status_code == 404
    assert (await api_client.put(URL, json={"provider": "openai"})).status_code == 404
    assert (await api_client.post(f"{URL}/test", json={"provider": "openai"})).status_code == 404
    assert (await api_client.post(f"{URL}/models", json={"provider": "openai"})).status_code == 404
    assert (await api_client.post("/v1/default/settings/restart")).status_code == 404
    assert (await api_client.get("/v1/default/settings/auth")).status_code == 404
    assert (await api_client.put("/v1/default/settings/auth", json={"enabled": False})).status_code == 404


@pytest.mark.asyncio
async def test_api_save_applies_at_once_and_never_returns_the_key(api_client):
    body = (await api_client.get(URL)).json()
    assert body["restart_required"] is False
    assert body["api_key_set"] is True
    # What is running is reported separately from what a restart would use.
    # Lets the UI show that the backend (not just the page) restarted.
    assert body["server_started_at"] == (await api_client.get(URL)).json()["server_started_at"]
    assert body["effective_api_key_set"] is True
    assert body["effective_api_key_hint"] == "…0000"

    response = await api_client.put(
        URL,
        json={
            "provider": "anthropic",
            "model": "m1",
            "base_url": "https://gateway.example/v1",
            "api_key": "sk-secret-abcdef123456",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["provider"], body["model"], body["base_url"]) == ("anthropic", "m1", "https://gateway.example/v1")
    # Applied on save: the running values are now the saved ones, so nothing is waiting for a restart.
    api_client.memory.reload_llm_settings.assert_awaited_once()
    assert body["restart_required"] is False
    assert (body["effective_provider"], body["effective_model"]) == ("anthropic", "m1")
    assert body["api_key_hint"] == "…3456"
    assert "sk-secret" not in response.text
    assert "sk-secret" not in (await api_client.get(URL)).text


@pytest.mark.asyncio
async def test_api_omitted_key_is_kept_for_the_same_provider_only(api_client):
    await api_client.put(URL, json={"provider": "anthropic", "api_key": "sk-first-key-1234"})

    await api_client.put(URL, json={"provider": "anthropic", "model": "m2"})
    assert load_global_settings().llm.api_key == "sk-first-key-1234"

    await api_client.put(URL, json={"provider": "gemini"})
    assert load_global_settings().llm.api_key is None


@pytest.mark.asyncio
async def test_api_clear_api_key(api_client):
    await api_client.put(URL, json={"provider": "anthropic", "api_key": "sk-first-key-1234"})
    await api_client.put(URL, json={"provider": "anthropic", "clear_api_key": True})
    assert load_global_settings().llm.api_key is None


@pytest.mark.asyncio
async def test_api_rejects_malformed_input(api_client):
    assert (await api_client.put(URL, json={"provider": "Bad Provider!"})).status_code == 422
    assert (await api_client.put(URL, json={"provider": "openai", "base_url": "ftp://x"})).status_code == 422
    assert (await api_client.put(URL, json={})).status_code == 422


@pytest.mark.asyncio
async def test_api_test_probes_the_candidate_without_saving(api_client):
    response = await api_client.post(
        f"{URL}/test",
        json={"provider": "anthropic", "model": "m1", "base_url": "https://gw.example/v1", "api_key": "sk-test-key-1"},
    )
    assert response.json() == {"ok": True, "status": "connected", "latency_ms": 12.0}
    api_client.memory.probe_llm_connection.assert_awaited_once_with(
        provider="anthropic", model="m1", base_url="https://gw.example/v1", api_key="sk-test-key-1"
    )
    assert load_global_settings() == GlobalSettings()


@pytest.mark.asyncio
async def test_api_test_reports_failure_status(api_client):
    api_client.memory.probe_llm_connection.return_value = _LlmProbeOutcome(
        ok=False, status="auth_failed", latency_ms=5.0
    )
    body = (await api_client.post(f"{URL}/test", json={"provider": "openai"})).json()
    assert (body["ok"], body["status"]) == (False, "auth_failed")


@pytest.mark.asyncio
async def test_api_models_lists_from_the_candidate_connection(api_client, monkeypatch):
    seen = {}

    async def fake_list_models(connection):
        seen["connection"] = connection
        return ModelList(status="listed", models=["m-a", "m-b"])

    monkeypatch.setattr("hindsight_api.llm_models.list_models", fake_list_models)
    body = (
        await api_client.post(
            f"{URL}/models",
            json={"provider": "anthropic", "base_url": "https://gw.example", "api_key": "sk-list-key-1"},
        )
    ).json()
    assert body == {"status": "listed", "models": ["m-a", "m-b"]}
    assert (seen["connection"].provider, seen["connection"].api_key) == ("anthropic", "sk-list-key-1")
    assert load_global_settings() == GlobalSettings()


@pytest.mark.asyncio
async def test_api_restart_sends_sigterm_to_itself_after_responding(api_client, monkeypatch):
    sent = []
    monkeypatch.setattr("os.kill", lambda pid, sig: sent.append((pid, sig)))
    monkeypatch.setattr("hindsight_api.api.http.asyncio.get_running_loop", lambda: _ImmediateLoop())

    response = await api_client.post("/v1/default/settings/restart")
    assert response.json() == {"restarting": True}
    assert sent == [(os.getpid(), signal.SIGTERM)]


@pytest.mark.asyncio
async def test_api_restart_refused_with_several_workers(api_client, monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_WORKERS", "2")
    clear_config_cache()
    assert (await api_client.post("/v1/default/settings/restart")).status_code == 409


class _ImmediateLoop:
    """Runs call_later callbacks at once, so the test needs no sleeping."""

    def call_later(self, delay, callback, *args):
        callback(*args)


@pytest.mark.asyncio
async def test_api_rejected_settings_change_nothing(api_client):
    await api_client.put(URL, json={"provider": "anthropic", "model": "kept", "api_key": "sk-kept-key-1234"})
    before = settings_path().read_text()

    api_client.memory.reload_llm_settings.side_effect = LLMSettingsRejected("auth_failed")
    response = await api_client.put(URL, json={"provider": "openai", "model": "bad", "api_key": "sk-bad-key-9999"})

    assert response.status_code == 409
    assert response.json()["detail"] == {"status": "auth_failed"}
    # The file is put back, so a restart cannot come up on settings that were refused.
    assert settings_path().read_text() == before


@pytest.mark.asyncio
async def test_api_several_workers_save_but_wait_for_a_restart(api_client, monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_WORKERS", "2")
    clear_config_cache()
    body = (await api_client.put(URL, json={"provider": "anthropic", "model": "m1"})).json()
    api_client.memory.reload_llm_settings.assert_not_awaited()
    assert body["restart_required"] is True


@pytest.mark.asyncio
async def test_api_refuses_unauthenticated_callers_and_changes_nothing(api_client):
    """The settings rewrite the server-wide LLM connection and restart the process: a caller the tenant
    extension rejects must not read, save, probe, list models or restart."""
    api_client.memory._authenticate_tenant.side_effect = AuthenticationError("bad key")
    attempts = [
        api_client.get(URL),
        api_client.put("/v1/default/settings/auth/admin", json={"username": "admin", "password": "pw-12345678"}),
        api_client.delete("/v1/default/settings/auth/admin"),
        api_client.get("/v1/default/settings/auth"),
        api_client.put("/v1/default/settings/auth", json={"enabled": False}),
        api_client.put(URL, json={"provider": "anthropic", "model": "m", "api_key": "sk-intruder-key-1"}),
        api_client.post(f"{URL}/test", json={"provider": "openai"}),
        api_client.post(f"{URL}/models", json={"provider": "openai"}),
        api_client.post("/v1/default/settings/restart"),
    ]
    for attempt in attempts:
        assert (await attempt).status_code == 401

    assert load_global_settings() == GlobalSettings()
    api_client.memory.reload_llm_settings.assert_not_awaited()
    api_client.memory.probe_llm_connection.assert_not_awaited()


AUTH_URL = "/v1/default/settings/auth"
API_KEY = "sk-api-access-key-1234567890"


@pytest.mark.asyncio
async def test_auth_turn_on_requires_the_key_and_never_returns_it(api_client):
    assert (await api_client.get(AUTH_URL)).json() == {
        "enabled": False,
        "api_key_hint": None,
        "managed_by_extension": False,
        "admin_username": None,
    }

    response = await api_client.put(AUTH_URL, json={"enabled": True, "api_key": API_KEY})
    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "api_key_hint": "…7890",
        "managed_by_extension": False,
        "admin_username": None,
        "admin_username": None,
    }
    assert API_KEY not in response.text
    assert API_KEY not in (await api_client.get(AUTH_URL)).text

    # Applied at once to the extension every request goes through, and saved for the next start.
    assert api_client.memory.tenant_extension.api_key == API_KEY
    assert load_global_settings().auth.api_key == API_KEY


@pytest.mark.asyncio
async def test_auth_turn_on_without_any_key_is_refused(api_client):
    response = await api_client.put(AUTH_URL, json={"enabled": True})
    assert response.status_code == 422
    assert api_client.memory.tenant_extension.api_key is None


@pytest.mark.asyncio
async def test_auth_keeps_the_saved_key_when_none_is_sent_and_clears_it_on_turn_off(api_client):
    await api_client.put(AUTH_URL, json={"enabled": True, "api_key": API_KEY})
    kept = await api_client.put(AUTH_URL, json={"enabled": True})
    assert kept.json()["api_key_hint"] == "…7890"
    assert api_client.memory.tenant_extension.api_key == API_KEY

    off = await api_client.put(AUTH_URL, json={"enabled": False})
    assert off.json()["enabled"] is False
    assert api_client.memory.tenant_extension.api_key is None
    assert load_global_settings().auth.api_key is None


@pytest.mark.asyncio
async def test_auth_rejects_short_or_spaced_keys(api_client):
    for bad in ("short", "has a space in it 123456"):
        assert (await api_client.put(AUTH_URL, json={"enabled": True, "api_key": bad})).status_code == 422


@pytest.mark.asyncio
async def test_auth_belongs_to_the_tenant_extension_when_one_is_configured(api_client):
    api_client.memory.tenant_extension = MagicMock()
    assert (await api_client.get(AUTH_URL)).json()["managed_by_extension"] is True
    assert (await api_client.put(AUTH_URL, json={"enabled": True, "api_key": API_KEY})).status_code == 409


@pytest.mark.asyncio
async def test_saving_the_llm_connection_keeps_the_api_key(api_client):
    await api_client.put(AUTH_URL, json={"enabled": True, "api_key": API_KEY})
    await api_client.put(URL, json={"provider": "anthropic", "model": "m1"})
    assert load_global_settings().auth.api_key == API_KEY


ADMIN_URL = "/v1/default/settings/auth/admin"
ADMIN = {"username": "admin", "password": "correct-horse-1"}


async def _login(api_client, password=ADMIN["password"], username=ADMIN["username"]):
    return await api_client.post("/v1/default/auth/login", json={"username": username, "password": password})


@pytest.mark.asyncio
async def test_the_page_login_account_is_stored_hashed_and_turns_the_login_on(api_client):
    assert (await api_client.get("/v1/default/auth/status")).json() == {"login_required": False}

    response = await api_client.put(ADMIN_URL, json=ADMIN)
    assert response.status_code == 200
    assert response.json()["admin_username"] == "admin"
    assert ADMIN["password"] not in response.text

    saved = load_global_settings().auth
    assert saved.admin.username == "admin"
    assert saved.admin.password_hash.startswith("scrypt$")
    assert ADMIN["password"] not in settings_path().read_text()
    assert saved.session_secret
    assert (await api_client.get("/v1/default/auth/status")).json() == {"login_required": True}


@pytest.mark.asyncio
async def test_a_short_password_or_odd_username_is_refused(api_client):
    for bad in ({"username": "admin", "password": "short"}, {"username": "a b", "password": "long-enough-pw"}):
        assert (await api_client.put(ADMIN_URL, json=bad)).status_code == 422
    assert load_global_settings().auth.admin is None


@pytest.mark.asyncio
async def test_signing_in_hands_the_api_key_to_the_control_plane_and_a_session_that_checks_out(api_client):
    await api_client.put(AUTH_URL, json={"enabled": True, "api_key": API_KEY})
    await api_client.put(ADMIN_URL, json=ADMIN)

    ok = await _login(api_client)
    assert ok.status_code == 200
    body = ok.json()
    assert body["api_key"] == API_KEY

    session = await api_client.get(
        "/v1/default/auth/session", headers={"Authorization": f"Bearer {body['session_token']}"}
    )
    assert session.json() == {"username": "admin"}
    # The page's session is not an API credential: a bad token and no token both get nothing.
    assert (
        await api_client.get("/v1/default/auth/session", headers={"Authorization": "Bearer nope"})
    ).status_code == 401
    assert (await api_client.get("/v1/default/auth/session")).status_code == 401


@pytest.mark.asyncio
async def test_signing_in_with_an_open_api_returns_no_key(api_client):
    await api_client.put(ADMIN_URL, json=ADMIN)
    assert (await _login(api_client)).json()["api_key"] is None


@pytest.mark.asyncio
async def test_wrong_credentials_are_refused_the_same_way_whichever_part_is_wrong(api_client):
    await api_client.put(ADMIN_URL, json=ADMIN)
    wrong_password = await _login(api_client, password="not-the-password")
    wrong_user = await _login(api_client, username="nobody")
    assert (wrong_password.status_code, wrong_user.status_code) == (401, 401)
    assert wrong_password.json() == wrong_user.json()


@pytest.mark.asyncio
async def test_signing_in_with_no_account_set_up_is_refused(api_client):
    assert (await _login(api_client)).status_code == 401


@pytest.mark.asyncio
async def test_repeated_failures_are_throttled_and_the_right_password_is_held_back_too(api_client):
    await api_client.put(ADMIN_URL, json=ADMIN)
    for _ in range(5):
        assert (await _login(api_client, password="guess")).status_code == 401

    held = await _login(api_client)
    assert held.status_code == 429
    assert int(held.headers["Retry-After"]) > 0


@pytest.mark.asyncio
async def test_changing_or_removing_the_account_ends_every_session(api_client):
    await api_client.put(ADMIN_URL, json=ADMIN)
    token = (await _login(api_client)).json()["session_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert (await api_client.get("/v1/default/auth/session", headers=headers)).status_code == 200

    await api_client.put(ADMIN_URL, json={**ADMIN, "password": "a-new-password-2"})
    assert (await api_client.get("/v1/default/auth/session", headers=headers)).status_code == 401

    fresh = (await _login(api_client, password="a-new-password-2")).json()["session_token"]
    removed = await api_client.delete(ADMIN_URL)
    assert removed.json()["admin_username"] is None
    assert (await api_client.get("/v1/default/auth/status")).json() == {"login_required": False}
    assert (
        await api_client.get("/v1/default/auth/session", headers={"Authorization": f"Bearer {fresh}"})
    ).status_code == 401


@pytest.mark.asyncio
async def test_the_sign_in_endpoints_work_without_the_api_key_but_the_settings_do_not(api_client):
    api_client.memory._authenticate_tenant.side_effect = AuthenticationError("bad key")
    await_status = (await api_client.get("/v1/default/auth/status")).status_code
    assert await_status == 200
    assert (await _login(api_client)).status_code == 401  # reached, not blocked by the API key
    assert (await api_client.put(ADMIN_URL, json=ADMIN)).status_code == 401


@pytest.mark.asyncio
async def test_saving_the_api_key_or_the_llm_keeps_the_page_login_account(api_client):
    await api_client.put(ADMIN_URL, json=ADMIN)
    secret = load_global_settings().auth.session_secret

    await api_client.put(AUTH_URL, json={"enabled": True, "api_key": API_KEY})
    await api_client.put(URL, json={"provider": "anthropic", "model": "m1"})

    saved = load_global_settings().auth
    assert saved.admin.username == "admin"
    assert saved.session_secret == secret


@pytest.mark.asyncio
async def test_a_test_or_model_list_aimed_at_another_host_does_not_carry_the_saved_or_env_key(api_client):
    """Whoever may edit the settings must not be able to make the server send its key to their own host."""
    await api_client.put(URL, json={"provider": "openai", "model": "m", "api_key": "sk-saved-key-12345"})

    await api_client.post(f"{URL}/test", json={"provider": "openai", "base_url": "https://attacker.example/v1"})
    sent = api_client.memory.probe_llm_connection.await_args.kwargs
    assert sent["base_url"] == "https://attacker.example/v1"
    assert sent["api_key"] is None

    # Same endpoint as saved: the saved key is used, so "Test" works without retyping it.
    await api_client.post(f"{URL}/test", json={"provider": "openai"})
    assert api_client.memory.probe_llm_connection.await_args.kwargs["api_key"] == "sk-saved-key-12345"


@pytest.mark.asyncio
async def test_saving_a_new_url_without_a_key_drops_the_saved_key(api_client):
    await api_client.put(URL, json={"provider": "openai", "api_key": "sk-saved-key-12345"})
    await api_client.put(URL, json={"provider": "openai", "base_url": "https://elsewhere.example/v1"})
    assert load_global_settings().llm.api_key is None


@pytest.mark.asyncio
async def test_the_api_key_cannot_be_turned_on_for_only_one_of_several_workers(api_client, monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_WORKERS", "2")
    clear_config_cache()
    assert (await api_client.put(AUTH_URL, json={"enabled": True, "api_key": API_KEY})).status_code == 409
    assert api_client.memory.tenant_extension.api_key is None


@pytest.mark.asyncio
async def test_failed_sign_ins_from_one_browser_do_not_lock_out_another(api_client):
    """Every sign-in reaches the API from the control plane; the throttle must count per browser."""
    await api_client.put(ADMIN_URL, json=ADMIN)
    for _ in range(5):
        await api_client.post(
            "/v1/default/auth/login",
            json={"username": "admin", "password": "guess"},
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
    blocked = await api_client.post("/v1/default/auth/login", json=ADMIN, headers={"X-Forwarded-For": "203.0.113.9"})
    admin = await api_client.post("/v1/default/auth/login", json=ADMIN, headers={"X-Forwarded-For": "198.51.100.7"})
    assert (blocked.status_code, admin.status_code) == (429, 200)


@pytest.mark.asyncio
async def test_a_failed_llm_save_does_not_undo_an_auth_change_made_meanwhile(api_client):
    async def auth_changes_then_probe_fails():
        save_global_settings(
            load_global_settings().model_copy(
                update={"auth": load_global_settings().auth.model_copy(update={"api_key": API_KEY})}
            )
        )
        raise LLMSettingsRejected("unreachable")

    api_client.memory.reload_llm_settings.side_effect = auth_changes_then_probe_fails
    assert (await api_client.put(URL, json={"provider": "anthropic"})).status_code == 409
    saved = load_global_settings()
    assert saved.auth.api_key == API_KEY
    assert saved.llm.provider is None


@pytest.mark.asyncio
async def test_saving_a_new_endpoint_without_its_key_is_refused_clearly(api_client):
    async def reload_refuses():
        raise LLMSettingsRejected("missing_api_key")

    api_client.memory.reload_llm_settings.side_effect = reload_refuses
    response = await api_client.put(URL, json={"provider": "openai", "base_url": "https://new.example/v1"})
    assert response.status_code == 409
    assert response.json()["detail"] == {"status": "missing_api_key"}
