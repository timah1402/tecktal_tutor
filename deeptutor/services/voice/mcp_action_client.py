"""Dedicated MCP client for the internal voice-actions server.

Deliberately separate from ``deeptutor.services.mcp.manager`` (the
multi-server client used by chat capabilities) — see
``mcp_action_server.py``'s docstring for why these tools must stay isolated
from the general agent tool registry.

Connects over an in-process ASGI transport (``httpx.ASGITransport``)
rather than a real TCP socket: the voice-actions server is mounted in the
same process (see ``deeptutor.api.main``), so there's no separate host/port
to discover or configure, and no real network round-trip — just a direct
in-memory ASGI call into the same Starlette app object the FastAPI process
already mounted.

Opens a fresh client/session per call rather than holding a persistent
one: voice actions are infrequent (one per spoken command), so the
per-call connection overhead is negligible and this avoids session-
lifecycle/concurrency bookkeeping entirely.
"""

from __future__ import annotations

from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from deeptutor.services.voice.mcp_action_server import _INTERNAL_HOST
from deeptutor.services.voice.mcp_action_server import mcp as _voice_actions_mcp
from deeptutor.services.voice.mcp_action_server import voice_actions_asgi_app

_BASE_URL = f"http://{_INTERNAL_HOST}"


async def call_voice_action(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Call a voice-action tool through a real MCP ``call_tool`` round-trip.

    Returns the tool's structured result (``{"status": "ok", ...}`` or
    ``{"status": "error", "message": ...}``), or an error dict if the MCP
    round-trip itself fails (unknown tool name, malformed arguments, etc.).
    """
    url = f"{_BASE_URL}{_voice_actions_mcp.settings.streamable_http_path}"
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=voice_actions_asgi_app()),
        base_url=_BASE_URL,
    )
    try:
        async with client:
            async with streamable_http_client(url, http_client=client) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(name, arguments)
    except Exception as exc:
        return {"status": "error", "message": f"MCP call failed: {exc}"}

    if result.isError:
        text = result.content[0].text if result.content else "Voice action tool call failed."
        return {"status": "error", "message": text}

    if result.structuredContent is not None:
        return result.structuredContent

    # FastMCP serialises tool return-dicts as TextContent (JSON string), not
    # as structuredContent, so the block above is often a no-op. Parse the
    # text payload rather than silently dropping all fields (capability, page,
    # theme, …) — losing them causes switch_capability to see result.capability
    # = undefined and exit early without doing anything.
    if result.content:
        import json as _json
        try:
            parsed = _json.loads(result.content[0].text)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

    return {"status": "ok"}
