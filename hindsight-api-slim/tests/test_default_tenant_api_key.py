"""DefaultTenantExtension: open until an API key is set, then only for the caller that sends it."""

import pytest

from hindsight_api.config import clear_config_cache
from hindsight_api.extensions import AuthenticationError
from hindsight_api.extensions.builtin.tenant import DefaultTenantExtension
from hindsight_api.global_settings import GlobalAuthSettings, GlobalSettings, save_global_settings
from hindsight_api.models import RequestContext

KEY = "a-sixteen-char-key-or-longer"


@pytest.fixture(autouse=True)
def _settings_file(tmp_path, monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_SETTINGS_FILE", str(tmp_path / "settings.json"))
    clear_config_cache()
    yield
    clear_config_cache()


@pytest.mark.asyncio
async def test_open_by_default():
    tenant = await DefaultTenantExtension(config={}).authenticate(RequestContext(api_key=None))
    assert tenant.schema_name


@pytest.mark.asyncio
async def test_with_a_key_set_only_that_key_gets_in():
    extension = DefaultTenantExtension(config={})
    extension.set_api_key(KEY)

    assert (await extension.authenticate(RequestContext(api_key=KEY))).schema_name
    for wrong in (None, "", "wrong", KEY + "x", KEY[:-1]):
        with pytest.raises(AuthenticationError):
            await extension.authenticate(RequestContext(api_key=wrong))
    # MCP goes through the same check unless an extension says otherwise.
    with pytest.raises(AuthenticationError):
        await extension.authenticate_mcp(RequestContext(api_key=None))


@pytest.mark.asyncio
async def test_clearing_the_key_opens_the_api_again():
    extension = DefaultTenantExtension(config={})
    extension.set_api_key(KEY)
    extension.set_api_key(None)
    assert (await extension.authenticate(RequestContext(api_key=None))).schema_name


@pytest.mark.asyncio
async def test_a_key_saved_before_startup_is_required_from_the_first_request():
    save_global_settings(GlobalSettings(auth=GlobalAuthSettings(api_key=KEY)))
    extension = DefaultTenantExtension(config={})
    with pytest.raises(AuthenticationError):
        await extension.authenticate(RequestContext(api_key=None))
    assert (await extension.authenticate(RequestContext(api_key=KEY))).schema_name
