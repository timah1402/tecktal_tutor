"""MCP server exposing voice-driven in-app actions as real MCP tools.

Mirrors the function schemas declared to OpenAI's Realtime API in
``deeptutor.api.routers.voice._REALTIME_TOOLS`` — same names, same enum
constraints — but as actual ``@mcp.tool()``-decorated functions on a real
:class:`FastMCP` server, so a voice action's *execution* is a genuine MCP
``call_tool`` round-trip (see ``mcp_action_client.py``), not just a
client-side switch-statement pretending to be one.

Most tools only validate their argument and echo back the resolved value —
the actual browser-side effect (router navigation, switching the chat
composer's capability, etc.) can only happen in the browser, so that part
stays in ``web/context/VoiceCallContext.tsx``. This server is the
authoritative validation step in that round-trip. ``get_memory_overview``
is the one exception: a pure read-only data fetch with no browser-side
effect at all — its result is relayed straight back to the model as the
function's output (see that handler in VoiceCallContext.tsx).

Deliberately **not** registered with ``deeptutor.services.mcp.manager``
(the multi-server client used by chat capabilities like deep_research) —
these tools must never show up as something a reasoning agent can call
mid-conversation. Mounted directly in ``deeptutor.api.main`` instead, and
only ever reached through ``mcp_action_client.call_voice_action()``.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# This server is only ever reached two ways: (1) mcp_action_client.py's
# in-process httpx.ASGITransport call, which sets the Host header below
# itself, or (2) a real HTTP request to the mount in main.py — which would
# carry the *real* Host header (e.g. "127.0.0.1:8001"), not this one, and
# gets correctly rejected by the DNS-rebinding check below. So restricting
# `allowed_hosts` to this single never-real hostname means the mount being
# technically reachable on the main app's public port doesn't actually
# expose these tools to outside callers.
_INTERNAL_HOST = "voice-actions.internal"

mcp = FastMCP(
    "deeptutor-voice-actions",
    transport_security=TransportSecuritySettings(
        allowed_hosts=[_INTERNAL_HOST],
        allowed_origins=[f"http://{_INTERNAL_HOST}"],
    ),
)

_PAGES = (
    "home",
    "settings",
    "learning_space",
    "notebooks",
    "knowledge_center",
)
_CAPABILITIES = ("chat", "quiz", "research", "solve", "visualize", "mastery_path")
_THEMES = ("light", "dark", "glass", "snow", "brand")
_RENDER_MODES = ("auto", "svg", "chartjs", "mermaid", "html", "manim_video")
_QUIZ_MODES = ("custom", "mimic")
_QUIZ_QUESTION_TYPES = (
    "choice",
    "concept",
    "fill_in_blank",
    "short_answer",
    "written",
    "coding",
)
_RESEARCH_MODES = ("notes", "report", "comparison", "learning_path")
_RESEARCH_DEPTHS = ("quick", "standard", "deep")


def _error(message: str) -> dict[str, Any]:
    return {"status": "error", "message": message}


@mcp.tool()
def navigate_to(page: str) -> dict[str, Any]:
    """Navigate to a different page/section of the app."""
    if page not in _PAGES:
        return _error(f"Unknown page: {page}")
    return {"status": "ok", "page": page}


@mcp.tool()
def switch_capability(
    capability: str,
    request: str = "",
    render_mode: str = "auto",
    quiz_mode: str = "",
    num_questions: int = 0,
    difficulty: str = "",
    question_types: list[str] | None = None,
    research_mode: str = "",
    research_depth: str = "",
) -> dict[str, Any]:
    """Switch the chat composer to a different mode/capability.

    ``request`` is the concrete content to generate once switched (e.g. "the
    water cycle" for visualize), left empty for a bare mode switch. Echoed
    back unvalidated — the frontend decides what counts as a real request.
    ``render_mode`` (visualize only) is the visual format the user asked for;
    defaults to "auto" when unspecified. ``quiz_mode``/``num_questions``/
    ``difficulty``/``question_types`` (quiz only) and ``research_mode``/
    ``research_depth`` (research only) are likewise echoed back unvalidated
    beyond the enum/type checks below — left empty/zero/None when not
    supplied for the active capability.
    """
    if capability not in _CAPABILITIES:
        return _error(f"Unknown capability: {capability}")
    if render_mode not in _RENDER_MODES:
        return _error(f"Unknown render_mode: {render_mode}")
    if quiz_mode and quiz_mode not in _QUIZ_MODES:
        return _error(f"Unknown quiz_mode: {quiz_mode}")
    if difficulty and difficulty not in ("auto", "easy", "medium", "hard"):
        return _error(f"Unknown difficulty: {difficulty}")
    if question_types:
        unknown = [t for t in question_types if t not in _QUIZ_QUESTION_TYPES]
        if unknown:
            return _error(f"Unknown question_types: {unknown}")
    if research_mode and research_mode not in _RESEARCH_MODES:
        return _error(f"Unknown research_mode: {research_mode}")
    if research_depth and research_depth not in _RESEARCH_DEPTHS:
        return _error(f"Unknown research_depth: {research_depth}")
    return {
        "status": "ok",
        "capability": capability,
        "request": request,
        "render_mode": render_mode,
        "quiz_mode": quiz_mode,
        "num_questions": num_questions,
        "difficulty": difficulty,
        "question_types": question_types or [],
        "research_mode": research_mode,
        "research_depth": research_depth,
    }


@mcp.tool()
def start_new_chat() -> dict[str, Any]:
    """Start a brand new chat, clearing the current conversation."""
    return {"status": "ok"}


@mcp.tool()
def open_history() -> dict[str, Any]:
    """Open the panel listing the user's past conversations."""
    return {"status": "ok"}


@mcp.tool()
def close_history() -> dict[str, Any]:
    """Close the history panel and go back to the chat."""
    return {"status": "ok"}


@mcp.tool()
def open_upload() -> dict[str, Any]:
    """Open the file-attachment picker in the chat composer."""
    return {"status": "ok"}


@mcp.tool()
def set_theme(theme: str) -> dict[str, Any]:
    """Change the app's visual theme."""
    if theme not in _THEMES:
        return _error(f"Unknown theme: {theme}")
    return {"status": "ok", "theme": theme}


@mcp.tool()
def show_more() -> dict[str, Any]:
    """Expand the home-page action menu to reveal all tools and nav destinations."""
    return {"status": "ok"}


@mcp.tool()
def show_less() -> dict[str, Any]:
    """Collapse the home-page action menu back to the headline tiles."""
    return {"status": "ok"}


@mcp.tool()
def save_quiz_to_notebook() -> dict[str, Any]:
    """Save the quiz the user is currently taking to their notebook."""
    return {"status": "ok"}


@mcp.tool()
def download_quiz() -> dict[str, Any]:
    """Download the quiz the user is currently taking as a Markdown file."""
    return {"status": "ok"}


@mcp.tool()
def cancel_response() -> dict[str, Any]:
    """Stop the assistant's response while it is still streaming."""
    return {"status": "ok"}


@mcp.tool()
def regenerate_response() -> dict[str, Any]:
    """Regenerate the assistant's last response."""
    return {"status": "ok"}


@mcp.tool()
def edit_last_message(new_content: str) -> dict[str, Any]:
    """Edit the user's own last sent message and resend it."""
    if not new_content or not new_content.strip():
        return _error("new_content must not be empty")
    return {"status": "ok", "new_content": new_content}


@mcp.tool()
def delete_last_turn() -> dict[str, Any]:
    """Permanently delete the most recent user/assistant turn."""
    return {"status": "ok"}


@mcp.tool()
def switch_message_branch(direction: str) -> dict[str, Any]:
    """Switch to the previous/next sibling version of the current turn."""
    if direction not in ("previous", "next"):
        return _error(f"Unknown direction: {direction}")
    return {"status": "ok", "direction": direction}


@mcp.tool()
def rename_session(title: str) -> dict[str, Any]:
    """Rename the current chat session's title."""
    if not title or not title.strip():
        return _error("title must not be empty")
    return {"status": "ok", "title": title}


@mcp.tool()
def download_session() -> dict[str, Any]:
    """Download the current chat conversation as a Markdown file."""
    return {"status": "ok"}


@mcp.tool()
def save_chat_to_notebook() -> dict[str, Any]:
    """Save the current chat into a notebook immediately."""
    return {"status": "ok"}


@mcp.tool()
def open_save_to_notebook() -> dict[str, Any]:
    """Open the dialog to save the current chat's messages into a notebook."""
    return {"status": "ok"}


@mcp.tool()
def toggle_viewer_panel(open: bool | None = None) -> dict[str, Any]:
    """Open, close, or toggle the side viewer panel."""
    return {"status": "ok", "open": open}


@mcp.tool()
def quiz_answer(option: str = "", text: str = "") -> dict[str, Any]:
    """Select or type an answer for the current quiz question."""
    if not option and not text:
        return _error("Either option or text must be provided")
    return {"status": "ok", "option": option, "text": text}


@mcp.tool()
def quiz_navigate(direction: str = "", index: int = 0) -> dict[str, Any]:
    """Move to a different question within the current quiz."""
    if direction and direction not in ("previous", "next"):
        return _error(f"Unknown direction: {direction}")
    if not direction and index <= 0:
        return _error("Either direction or a positive index must be provided")
    return {"status": "ok", "direction": direction, "index": index}


@mcp.tool()
def quiz_submit_answer() -> dict[str, Any]:
    """Submit the currently selected/typed answer for the current quiz question."""
    return {"status": "ok"}


@mcp.tool()
def quiz_reset_answer() -> dict[str, Any]:
    """Clear/reset the answer on the current quiz question."""
    return {"status": "ok"}


@mcp.tool()
def quiz_request_judging() -> dict[str, Any]:
    """Ask the AI to judge/grade the user's submitted answer."""
    return {"status": "ok"}


@mcp.tool()
def quiz_toggle_bookmark() -> dict[str, Any]:
    """Toggle a bookmark on the current quiz question."""
    return {"status": "ok"}


@mcp.tool()
def quiz_add_to_category(category_name: str) -> dict[str, Any]:
    """File the current quiz question into a named category."""
    if not category_name or not category_name.strip():
        return _error("category_name must not be empty")
    return {"status": "ok", "category_name": category_name}


@mcp.tool()
def quiz_set_answer_view(view: str) -> dict[str, Any]:
    """Switch the current question's review block to reference or judgment."""
    if view not in ("reference", "judgment"):
        return _error(f"Unknown view: {view}")
    return {"status": "ok", "view": view}


@mcp.tool()
def quiz_toggle_review(collapsed: bool | None = None) -> dict[str, Any]:
    """Collapse or expand the current question's review block."""
    return {"status": "ok", "collapsed": collapsed}


@mcp.tool()
def quiz_open_followup() -> dict[str, Any]:
    """Open a follow-up chat about the current quiz question."""
    return {"status": "ok"}


@mcp.tool()
def research_confirm_outline() -> dict[str, Any]:
    """Confirm the current research outline and proceed to the full run."""
    return {"status": "ok"}


@mcp.tool()
def research_remove_outline_item(index: int) -> dict[str, Any]:
    """Remove a section from the research outline by 1-based position."""
    if index <= 0:
        return _error("index must be a positive 1-based position")
    return {"status": "ok", "index": index}


@mcp.tool()
def research_add_outline_item(title: str, overview: str = "") -> dict[str, Any]:
    """Add a new section to the research outline."""
    if not title or not title.strip():
        return _error("title must not be empty")
    return {"status": "ok", "title": title, "overview": overview}


@mcp.tool()
def research_edit_outline_item(
    index: int, title: str = "", overview: str = ""
) -> dict[str, Any]:
    """Rewrite an existing section's title/overview by 1-based position."""
    if index <= 0:
        return _error("index must be a positive 1-based position")
    if not title and not overview:
        return _error("Either title or overview must be provided")
    return {"status": "ok", "index": index, "title": title, "overview": overview}


@mcp.tool()
def research_toggle_outline(collapsed: bool | None = None) -> dict[str, Any]:
    """Collapse or expand the research outline card."""
    return {"status": "ok", "collapsed": collapsed}


@mcp.tool()
def visualize_fullscreen(enter: bool) -> dict[str, Any]:
    """Enter or exit fullscreen view of the current visualization."""
    return {"status": "ok", "enter": enter}


@mcp.tool()
def visualize_show_code(show: bool) -> dict[str, Any]:
    """Show or hide the underlying code of the current visualization."""
    return {"status": "ok", "show": show}


@mcp.tool()
def visualize_copy_code() -> dict[str, Any]:
    """Copy the underlying code of the current visualization to the clipboard."""
    return {"status": "ok"}


@mcp.tool()
def mastery_path_select(path_name: str) -> dict[str, Any]:
    """Open a specific existing mastery path by name."""
    if not path_name or not path_name.strip():
        return _error("path_name must not be empty")
    return {"status": "ok", "path_name": path_name}


@mcp.tool()
def mastery_path_continue(path_name: str) -> dict[str, Any]:
    """Resume an existing mastery path by name."""
    if not path_name or not path_name.strip():
        return _error("path_name must not be empty")
    return {"status": "ok", "path_name": path_name}


@mcp.tool()
def mastery_path_redo(path_name: str) -> dict[str, Any]:
    """Reset an existing mastery path's progress."""
    if not path_name or not path_name.strip():
        return _error("path_name must not be empty")
    return {"status": "ok", "path_name": path_name}


@mcp.tool()
def mastery_path_delete(path_name: str) -> dict[str, Any]:
    """Permanently delete an existing mastery path."""
    if not path_name or not path_name.strip():
        return _error("path_name must not be empty")
    return {"status": "ok", "path_name": path_name}


@mcp.tool()
def select_model(query: str) -> dict[str, Any]:
    """Switch which LLM model the next message uses."""
    if not query or not query.strip():
        return _error("query must not be empty")
    return {"status": "ok", "query": query}


@mcp.tool()
def select_persona(query: str = "") -> dict[str, Any]:
    """Switch persona by name, or clear it if query is empty."""
    return {"status": "ok", "query": query}


@mcp.tool()
def select_agent(query: str = "") -> dict[str, Any]:
    """Switch the connected agent by name, or clear it if query is empty."""
    return {"status": "ok", "query": query}


@mcp.tool()
def toggle_knowledge_base(query: str) -> dict[str, Any]:
    """Toggle a knowledge base on/off by name."""
    if not query or not query.strip():
        return _error("query must not be empty")
    return {"status": "ok", "query": query}


@mcp.tool()
def remove_attachment(all: bool = False) -> dict[str, Any]:
    """Remove a queued attachment — the most recent one, or all of them."""
    return {"status": "ok", "all": all}


@mcp.tool()
def copy_last_message() -> dict[str, Any]:
    """Copy the assistant's last message to the clipboard."""
    return {"status": "ok"}


@mcp.tool()
def attach_book_reference(query: str) -> dict[str, Any]:
    """Attach a book or book section as context to the user's next message."""
    if not query or not query.strip():
        return _error("query must not be empty")
    return {"status": "ok", "query": query}


@mcp.tool()
def attach_question_bank_entry(query: str) -> dict[str, Any]:
    """Attach a saved question-bank entry as context to the user's next message."""
    if not query or not query.strip():
        return _error("query must not be empty")
    return {"status": "ok", "query": query}


@mcp.tool()
def answer_inline_question(text: str) -> dict[str, Any]:
    """Answer the inline question card currently waiting on screen."""
    if not text or not text.strip():
        return _error("text must not be empty")
    return {"status": "ok", "text": text}


@mcp.tool()
def submit_inline_answers() -> dict[str, Any]:
    """Submit the inline question card currently waiting on screen."""
    return {"status": "ok"}


@mcp.tool()
def get_memory_overview() -> dict[str, Any]:
    """Fetch a live summary of the current user's Memory page.

    Same data MemoryHub.tsx renders (per-surface L1 entity counts, L2/L3
    doc entry totals, backup count/latest name) — user-scoped via the
    memory path service's contextvar, which propagates correctly through
    this in-process MCP round-trip since it's the same asyncio task as the
    outer request (no real network hop, no context loss). Read-only —
    nothing here mutates memory state.
    """
    from deeptutor.services.memory import SURFACES, get_memory_store, paths
    from deeptutor.services.memory import snapshot as snap

    try:
        store = get_memory_store()
        docs = store.overview()
        l1_by_surface = {
            surface: len(snap.read_snapshot(surface)) for surface in SURFACES
        }
        backup_dir = paths.backup_root()
        backups = (
            sorted(p.name for p in backup_dir.iterdir() if p.is_dir())
            if backup_dir.exists()
            else []
        )
        return {
            "status": "ok",
            "l1_total": sum(l1_by_surface.values()),
            "l1_by_surface": l1_by_surface,
            "l2_docs": [
                {
                    "surface": d.key,
                    "entries": d.entry_count,
                    "updated_at": d.updated_at,
                }
                for d in docs
                if d.layer == "L2"
            ],
            "l3_docs": [
                {"slot": d.key, "entries": d.entry_count, "updated_at": d.updated_at}
                for d in docs
                if d.layer == "L3"
            ],
            "backup_count": len(backups),
            "latest_backup": backups[-1] if backups else None,
        }
    except Exception as exc:  # noqa: BLE001 — surface as a spoken-friendly error
        return _error(f"Could not read memory overview: {exc}")


_asgi_app = None


def voice_actions_asgi_app():
    """Streamable-HTTP ASGI app for mounting into the main FastAPI app.

    Cached so ``main.py``'s mount and ``mcp_action_client.py``'s in-process
    ASGI transport (no real socket — see that module) share the exact same
    app object, not just the same underlying session manager.
    """
    global _asgi_app
    if _asgi_app is None:
        _asgi_app = mcp.streamable_http_app()
    return _asgi_app
