"""Direct Anthropic vision turns with a small, ARMv7-friendly HTTP client.

Uses the documented Messages SSE protocol. Only text deltas become handwriting;
errors and incomplete streams never count as completed answers. Credentials stay
in ANTHROPIC_API_KEY, outside request records and page data.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from collections.abc import Callable

import httpx

from .terminal import Reply


async def ask(
    text: str,
    png: bytes,
    model: str,
    timeout_s: float,
    on_text: Callable[[str], None] | None = None,
) -> Reply:
    start = time.monotonic()
    result = Reply()
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")
    body = {
        "model": model,
        "max_tokens": 512,
        "stream": True,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": base64.b64encode(png).decode("ascii"),
                        },
                    },
                    {"type": "text", "text": text},
                ],
            }
        ],
    }
    complete = False
    async with asyncio.timeout(timeout_s):
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            async with client.stream(
                "POST",
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                json=body,
            ) as response:
                response.raise_for_status()
                data: list[str] = []
                async for line in response.aiter_lines():
                    if line.startswith("data:"):
                        data.append(line[5:].lstrip())
                        continue
                    if line or not data:
                        continue
                    event = json.loads("\n".join(data))
                    data.clear()
                    kind = event.get("type")
                    if kind == "error":
                        # Do not log request headers or arbitrary remote error bodies.
                        raise RuntimeError("Anthropic streaming error")
                    if kind == "message_start":
                        message = event.get("message", {})
                        result.session_id = message.get("id", "")
                        result.tokens_in = message.get("usage", {}).get("input_tokens")
                    elif kind == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            chunk = delta.get("text", "")
                            if chunk and result.first_text_s is None:
                                result.first_text_s = result.first_answer_s = (
                                    time.monotonic() - start
                                )
                            result.text += chunk
                            if on_text is not None:
                                on_text(result.text)
                    elif kind == "message_stop":
                        complete = True
                        break
    if not complete:
        raise RuntimeError("Anthropic stream ended before message_stop")
    result.ok = bool(result.text.strip())
    result.done_s = time.monotonic() - start
    return result
