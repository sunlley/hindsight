"""Saving the global LLM settings changes what the very next operation calls, with no restart.

The control plane's Settings page edits the server's LLM connection: model, endpoint and key.
The promise is that a save is live: the next retain extracts with the new model and the new
key, not the ones the process booted with. Nothing visible breaks if it only half holds: the
page shows the new values while extraction keeps going to the old model, and the bill and the
behaviour belong to a model nobody chose.

The second half is the refusal. A save is only accepted if the model answers on the new
connection, and a refused one must leave the server exactly as it was, or one mistyped URL
takes every operation down.

The names are unusual on purpose: the stub is shared with every other server in the session.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from collections.abc import AsyncIterator

import pytest
from hindsight_client import Hindsight
from hindsight_client_api.exceptions import ApiException
from hindsight_client_api.models import (
    ApiAuthSettingsUpdate,
    GlobalLLMSettingsUpdate,
    LoginRequest,
    PageLoginUpdate,
)

from hindsight_system_tests import ChatRequest
from hindsight_system_tests.payloads import extracted, fact

from .conftest import BANK_PREFIX

pytestmark = pytest.mark.asyncio

BOOT_MODEL = "stub-model"
NEW_MODEL = "settings-model-zephyr"
NEW_KEY = "settings-key-zephyr"
API_KEY = "hs-systest-api-key-0123456789"
ADMIN_USER = "systest-admin"
ADMIN_PASSWORD = "systest-password-1"


@pytest.fixture
async def settings_client(settings_server) -> AsyncIterator[Hindsight]:
    client = Hindsight(base_url=settings_server.url)
    yield client
    # Leave the process open, and on the connection it booted with, for whoever comes next.
    keyed = Hindsight(base_url=settings_server.url, api_key=API_KEY)
    try:
        for caller in (keyed, client):
            with contextlib.suppress(ApiException):
                await caller.settings.remove_page_login_account()
            with contextlib.suppress(ApiException):
                await caller.settings.update_api_auth_settings(ApiAuthSettingsUpdate(enabled=False))
        await client.settings.update_global_llm_settings(GlobalLLMSettingsUpdate(provider="openai", model=BOOT_MODEL))
    finally:
        await keyed.aclose()
        await client.aclose()


@pytest.fixture
async def settings_bank(settings_client: Hindsight) -> AsyncIterator[str]:
    name = f"{BANK_PREFIX}settings-{uuid.uuid4().hex[:12]}"
    yield name
    with contextlib.suppress(Exception):
        await settings_client.banks.delete_bank(name)


def _extraction_calls(llm, marker: str) -> list[ChatRequest]:
    return [call for call in llm.calls if marker in call.all_text and "Extract facts" in call.all_text]


async def _retain(client: Hindsight, llm, bank: str, who: str) -> ChatRequest:
    llm.on_step("extract_facts", contains=who).returns(extracted(fact(f"{who} keeps bees", who=who)))
    await client.aretain(bank_id=bank, content=f"{who} keeps bees.")
    calls = _extraction_calls(llm, who)
    assert calls, f"no extraction call reached the stub for {who}"
    return calls[-1]


def _new_connection(stub_server) -> GlobalLLMSettingsUpdate:
    return GlobalLLMSettingsUpdate(
        provider="openai", model=NEW_MODEL, base_url=f"{stub_server.url}/v1", api_key=NEW_KEY
    )


async def test_a_saved_model_and_key_reach_the_next_extraction(settings_client, settings_bank, llm, stub_server):
    before = await _retain(settings_client, llm, settings_bank, "Quillon")
    assert before.model == BOOT_MODEL

    saved = await settings_client.settings.update_global_llm_settings(_new_connection(stub_server))
    assert saved.restart_required is False
    assert saved.effective_model == NEW_MODEL
    assert NEW_KEY not in saved.model_dump_json()

    after = await _retain(settings_client, llm, settings_bank, "Thessaly")
    assert (after.model, after.api_key) == (NEW_MODEL, NEW_KEY)


async def test_a_refused_save_leaves_the_server_on_its_settings(settings_client, settings_bank, llm, stub_server):
    await settings_client.settings.update_global_llm_settings(_new_connection(stub_server))

    # Nothing listens on port 1, so the model cannot be reached with this connection.
    with pytest.raises(ApiException) as refused:
        await settings_client.settings.update_global_llm_settings(
            GlobalLLMSettingsUpdate(provider="openai", model="never-used", base_url="http://127.0.0.1:1/v1")
        )
    assert refused.value.status == 409
    # Refused connection or the probe giving up on its retries: which one is timing, and both mean "not reachable".
    assert json.loads(refused.value.body)["detail"]["status"] in ("unreachable", "timeout")

    current = await settings_client.settings.get_global_llm_settings()
    assert (current.effective_model, current.model) == (NEW_MODEL, NEW_MODEL)
    after = await _retain(settings_client, llm, settings_bank, "Marguerite")
    assert (after.model, after.api_key) == (NEW_MODEL, NEW_KEY)


async def test_an_api_key_saved_from_settings_gates_every_call_until_it_is_turned_off(settings_server, settings_client):
    """Turning authorization on must reach the calls clients make, not just the page.

    The settings page is only the controls; the promise is that the very next request from a client
    without the key is refused, one with it goes through, and turning it off opens the API again.
    """
    keyed = Hindsight(base_url=settings_server.url, api_key=API_KEY)
    try:
        await settings_client.banks.list_banks()  # open to begin with

        saved = await settings_client.settings.update_api_auth_settings(
            ApiAuthSettingsUpdate(enabled=True, api_key=API_KEY)
        )
        assert saved.enabled is True
        assert API_KEY not in saved.model_dump_json()

        with pytest.raises(ApiException) as refused:
            await settings_client.banks.list_banks()
        assert refused.value.status == 401
        await keyed.banks.list_banks()

        # Changing the setting is itself behind the key.
        with pytest.raises(ApiException) as locked:
            await settings_client.settings.get_api_auth_settings()
        assert locked.value.status == 401
        assert (await keyed.settings.update_api_auth_settings(ApiAuthSettingsUpdate(enabled=False))).enabled is False
        await settings_client.banks.list_banks()
    finally:
        await keyed.aclose()


async def test_the_page_signs_in_with_an_account_while_programs_keep_using_the_api_key(
    settings_server, settings_client
):
    """Two doors, one process: the page's account hands the control plane the API key and a session, and
    taking the account away closes the page's door without touching the key.
    """
    keyed = Hindsight(base_url=settings_server.url, api_key=API_KEY)
    auth = settings_client.auth  # the sign-in endpoints are public: no key on this client
    try:
        await settings_client.settings.update_api_auth_settings(ApiAuthSettingsUpdate(enabled=True, api_key=API_KEY))
        saved = await keyed.settings.set_page_login_account(
            PageLoginUpdate(username=ADMIN_USER, password=ADMIN_PASSWORD)
        )
        assert ADMIN_PASSWORD not in saved.model_dump_json()
        assert (await auth.get_auth_status()).login_required is True

        # Signing in needs no API key (the page has none yet), but does need the right password.
        with pytest.raises(ApiException) as wrong:
            await auth.login(LoginRequest(username=ADMIN_USER, password="not-it"))
        assert wrong.value.status == 401
        session = await auth.login(LoginRequest(username=ADMIN_USER, password=ADMIN_PASSWORD))
        assert session.api_key == API_KEY

        bearer = f"Bearer {session.session_token}"
        assert (await auth.get_session(authorization=bearer)).username == ADMIN_USER
        # The session is the page's, not an API credential: it does not open the API.
        with pytest.raises(ApiException) as refused:
            await settings_client.banks.list_banks(authorization=bearer)
        assert refused.value.status == 401

        removed = await keyed.settings.remove_page_login_account()
        assert removed.admin_username is None
        assert (await auth.get_auth_status()).login_required is False
        with pytest.raises(ApiException) as gone:
            await auth.get_session(authorization=bearer)
        assert gone.value.status == 401
        # The key still gates the API.
        with pytest.raises(ApiException) as still_keyed:
            await settings_client.settings.get_api_auth_settings()
        assert still_keyed.value.status == 401
    finally:
        await keyed.aclose()
