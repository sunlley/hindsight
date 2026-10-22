"""MemoryEngine.reload_llm_settings: new settings reach every client at once, or not at all.

Builds a real engine (no database is touched in __init__) and probes with a stand-in, so no LLM is called.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from hindsight_api.config import clear_config_cache
from hindsight_api.engine.memory_engine import LLMSettingsRejected, MemoryEngine, _LlmProbeOutcome
from hindsight_api.global_settings import GlobalLLMSettings, GlobalSettings, save_global_settings


@pytest.fixture
def engine(tmp_path, monkeypatch):
    monkeypatch.setenv("HINDSIGHT_API_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "openai")
    monkeypatch.setenv("HINDSIGHT_API_LLM_API_KEY", "k-env")
    monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "model-1")
    monkeypatch.setenv("HINDSIGHT_API_LLM_BASE_URL", "http://one.example/v1")
    monkeypatch.setenv("HINDSIGHT_API_RETAIN_LLM_MODEL", "retain-only")
    clear_config_cache()
    engine = MemoryEngine(
        db_url="postgresql://u:p@localhost:1/x", embeddings=MagicMock(), cross_encoder=MagicMock(), run_migrations=False
    )
    yield engine
    for task in engine._llm_cleanup_tasks:
        task.cancel()
    clear_config_cache()


def _clients(engine):
    return [
        engine._llm_config,
        engine._retain_llm_config,
        engine._reflect_llm_config,
        engine._consolidation_llm_config,
    ]


@pytest.mark.asyncio
async def test_reload_swaps_every_client_and_keeps_per_operation_overrides(engine):
    old = _clients(engine)
    engine._probe_llm = AsyncMock(return_value=_LlmProbeOutcome(ok=True, status="connected", latency_ms=1.0))
    save_global_settings(
        # A new endpoint needs its own key: the environment's never follows the URL elsewhere.
        GlobalSettings(
            llm=GlobalLLMSettings(provider="openai", model="model-2", base_url="http://two.example/v1", api_key="k2")
        )
    )

    await engine.reload_llm_settings()

    new = _clients(engine)
    assert all(n is not o for n, o in zip(new, old))
    assert (engine._llm_config.model, engine._llm_config.base_url) == ("model-2", "http://two.example/v1")
    # The default changed; the retain model set for that operation alone still wins for retain.
    assert engine._retain_llm_config.model == "retain-only"
    assert engine._reflect_llm_config.model == "model-2"
    assert engine._reflect_llm_config_at_init is engine._reflect_llm_config
    # The replaced clients are closed later, not out from under a request still using them.
    assert len(engine._llm_cleanup_tasks) == 1


@pytest.mark.asyncio
async def test_reload_that_cannot_reach_the_model_changes_nothing(engine):
    old = _clients(engine)
    engine._probe_llm = AsyncMock(return_value=_LlmProbeOutcome(ok=False, status="auth_failed", latency_ms=1.0))
    save_global_settings(GlobalSettings(llm=GlobalLLMSettings(provider="openai", model="model-2")))

    with pytest.raises(LLMSettingsRejected) as rejected:
        await engine.reload_llm_settings()

    assert rejected.value.status == "auth_failed"
    assert all(n is o for n, o in zip(_clients(engine), old))
    assert not engine._llm_cleanup_tasks


@pytest.mark.asyncio
async def test_probing_a_connection_with_no_llm_reports_not_configured(engine):
    outcome = await engine.probe_llm_connection(provider="none", model="m", base_url=None, api_key=None)
    assert (outcome.ok, outcome.status) == (False, "not_configured")


def test_a_provider_that_needs_a_key_fails_at_construction_without_one(monkeypatch, tmp_path):
    """The default LLM is resolved when the engine is built, so a missing key still fails there, early."""
    monkeypatch.setenv("HINDSIGHT_API_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "openai")
    monkeypatch.delenv("HINDSIGHT_API_LLM_API_KEY", raising=False)
    clear_config_cache()
    try:
        with pytest.raises(ValueError, match="API key is required"):
            MemoryEngine(
                db_url="postgresql://u:p@localhost:1/x",
                embeddings=MagicMock(),
                cross_encoder=MagicMock(),
                run_migrations=False,
            )
    finally:
        clear_config_cache()


def test_the_config_resolver_adopts_the_rebuilt_global_config(engine, monkeypatch):
    """Bank config shows global defaults the resolver took at startup; after a save they must follow."""
    from hindsight_api.config_resolver import ConfigResolver

    resolver = ConfigResolver(backend=MagicMock(), tenant_extension=None)
    assert resolver._global_config.llm_model == "model-1"

    save_global_settings(GlobalSettings(llm=GlobalLLMSettings(provider="openai", model="model-2")))
    clear_config_cache()
    resolver.refresh_global_config()

    assert resolver._global_config.llm_model == "model-2"


@pytest.mark.asyncio
async def test_a_new_endpoint_without_a_key_is_rejected_not_crashed(engine):
    old = _clients(engine)
    save_global_settings(GlobalSettings(llm=GlobalLLMSettings(provider="openai", base_url="http://three.example/v1")))
    with pytest.raises(LLMSettingsRejected) as rejected:
        await engine.reload_llm_settings()
    assert rejected.value.status == "missing_api_key"
    assert all(n is o for n, o in zip(_clients(engine), old))


@pytest.mark.asyncio
async def test_probing_a_provider_that_needs_a_key_without_one_says_so(engine):
    outcome = await engine.probe_llm_connection(provider="openai", model="m", base_url="http://x/v1", api_key=None)
    assert (outcome.ok, outcome.status) == (False, "missing_api_key")
