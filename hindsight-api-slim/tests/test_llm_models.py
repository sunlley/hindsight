"""Listing models from an endpoint, against a real local HTTP server for each wire format."""

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from hindsight_api.config import LLMConnection
from hindsight_api.llm_models import list_models


async def _serve(handler, path):
    app = web.Application()
    app.router.add_get(path, handler)
    server = TestServer(app)
    await server.start_server()
    return server


def _connection(provider, server, api_key="k"):
    return LLMConnection(provider=provider, model="m", base_url=str(server.make_url("")).rstrip("/"), api_key=api_key)


@pytest.mark.asyncio
async def test_openai_compatible_list_is_sorted_and_sends_bearer_key():
    seen = {}

    async def handler(request):
        seen["auth"] = request.headers.get("Authorization")
        return web.json_response({"data": [{"id": "b-model"}, {"id": "a-model"}, {"id": "a-model"}]})

    server = await _serve(handler, "/models")
    try:
        result = await list_models(_connection("openai", server, api_key="sk-1"))
    finally:
        await server.close()
    assert (result.status, result.models) == ("listed", ["a-model", "b-model"])
    assert seen["auth"] == "Bearer sk-1"


@pytest.mark.asyncio
async def test_anthropic_uses_its_own_headers_and_path():
    seen = {}

    async def handler(request):
        seen["key"] = request.headers.get("x-api-key")
        seen["version"] = request.headers.get("anthropic-version")
        return web.json_response({"data": [{"id": "claude-x"}]})

    server = await _serve(handler, "/v1/models")
    try:
        result = await list_models(_connection("anthropic", server, api_key="ak"))
    finally:
        await server.close()
    assert result.models == ["claude-x"]
    assert (seen["key"], seen["version"]) == ("ak", "2023-06-01")


@pytest.mark.asyncio
async def test_gemini_keeps_only_models_that_can_generate():
    async def handler(request):
        return web.json_response(
            {
                "models": [
                    {"name": "models/gemini-pro", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"]},
                ]
            }
        )

    server = await _serve(handler, "/models")
    try:
        result = await list_models(_connection("gemini", server))
    finally:
        await server.close()
    assert result.models == ["gemini-pro"]


@pytest.mark.asyncio
async def test_rejected_key_is_reported_as_auth_failed():
    async def handler(request):
        return web.Response(status=401, text="nope")

    server = await _serve(handler, "/models")
    try:
        assert (await list_models(_connection("openai", server))).status == "auth_failed"
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_redirect_is_not_followed():
    async def handler(request):
        raise web.HTTPFound("http://169.254.169.254/latest/meta-data")

    server = await _serve(handler, "/models")
    try:
        result = await list_models(_connection("openai", server))
    finally:
        await server.close()
    assert (result.status, result.models) == ("unreachable", [])


@pytest.mark.asyncio
async def test_non_model_payload_is_invalid_response():
    async def handler(request):
        return web.json_response({"hello": "world"})

    server = await _serve(handler, "/models")
    try:
        assert (await list_models(_connection("openai", server))).status == "invalid_response"
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_dead_endpoint_is_unreachable():
    result = await list_models(
        LLMConnection(provider="openai", model="m", base_url="http://127.0.0.1:1/v1", api_key="k")
    )
    assert result.status == "unreachable"


@pytest.mark.asyncio
async def test_providers_without_a_model_list_are_unsupported():
    assert (await list_models(LLMConnection("vertexai", "m", None, None))).status == "unsupported"
    # An unknown provider has no default endpoint to ask until a base URL is filled in.
    assert (await list_models(LLMConnection("my-gateway", "m", None, None))).status == "unsupported"
