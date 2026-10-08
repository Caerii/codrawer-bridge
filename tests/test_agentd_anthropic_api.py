import asyncio
import json

import httpx
import pytest

from codrawer_bridge.agentd import anthropic_api


def setup_client(monkeypatch, events, status=200):
    requests = []

    def handle(request):
        requests.append(request)
        data = "".join("data: " + json.dumps(e) + "\n\n" for e in events)
        return httpx.Response(status, text=data)

    original = httpx.AsyncClient
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-secret")
    monkeypatch.setattr(
        anthropic_api.httpx,
        "AsyncClient",
        lambda **kw: original(transport=httpx.MockTransport(handle), **kw),
    )
    return requests


def test_attaches_image_and_streams_answer(monkeypatch):
    requests = setup_client(
        monkeypatch,
        [
            {"type": "message_start", "message": {"id": "test", "usage": {"input_tokens": 12}}},
            {"type": "ping"},
            {
                "type": "content_block_delta",
                "delta": {"type": "thinking_delta", "thinking": "hidden"},
            },
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello "}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "paper"}},
            {"type": "message_stop"},
        ],
    )
    chunks = []
    reply = asyncio.run(anthropic_api.ask("Read this", b"png", "test-model", 2, chunks.append))
    assert reply.ok and reply.text == "Hello paper"
    assert chunks == ["Hello ", "Hello paper"]
    assert reply.tokens_in == 12 and reply.session_id == "test"
    payload = json.loads(requests[0].content)
    assert payload["model"] == "test-model"
    content = payload["messages"][0]["content"]
    assert content[0]["source"]["data"] == "cG5n"
    assert content[1] == {"type": "text", "text": "Read this"}
    assert "tools" not in payload and "test-secret" not in str(payload)


@pytest.mark.parametrize(
    "events,match",
    [
        ([{"type": "error", "error": {"message": "remote detail"}}], "streaming error"),
        (
            [{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "partial"}}],
            "ended before message_stop",
        ),
    ],
)
def test_failed_stream_is_not_success(monkeypatch, events, match):
    setup_client(monkeypatch, events)
    with pytest.raises(RuntimeError, match=match):
        asyncio.run(anthropic_api.ask("Read this", b"png", "test-model", 2))


def test_authentication_failure(monkeypatch):
    setup_client(monkeypatch, [], status=401)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(anthropic_api.ask("Read this", b"png", "test-model", 2))
