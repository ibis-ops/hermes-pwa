"""Shared memory for hand-offs.

Hermes builds every delegated child (a hand-off from the router, the manager or any bot) with ``skip_memory=True``:
the bot that does the work never sees the shared MEMORY.md and USER.md that every top-level chat gets, so lessons
the team has learned (where things are, which tool works, what Sean wants) are missing exactly where the work
happens. This ``pre_llm_call`` piece hands a child the same shared memory once, on its first turn.

The memory is the one shared folder every profile links to (<Hermes root>/memories, which points at the vault's
Hermes/Memory). Read-only: nothing here writes memory.
"""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from pathlib import Path

try:  # Loaded as part of the plugin package (the gateway's hooks).
    from .bot_graph import _root_hermes_home  # type: ignore
except ImportError:  # Loaded on its own (the tests).
    from bot_graph import _root_hermes_home  # type: ignore

DELIMITER = "\n§\n"
MAX_CHARS = 30000
_SEEN_LIMIT = 4000
_seen_lock = threading.Lock()
_seen: "OrderedDict[str, bool]" = OrderedDict()


def _memory_dir() -> Path:
    return _root_hermes_home() / "memories"


def _entries(name: str) -> list[str]:
    try:
        text = (_memory_dir() / name).read_text(encoding="utf-8")
    except OSError:
        return []
    return [e.strip() for e in text.split(DELIMITER) if e.strip()]


def memory_block() -> str | None:
    memory, user = _entries("MEMORY.md"), _entries("USER.md")
    if not memory and not user:
        return None
    parts = ["SHARED MEMORY (the notes every Hermes bot keeps; a hand-off does not load them by itself, so here they "
             "are). Follow them like your own memory; your SOUL and the task come first where they differ."]
    if memory:
        parts.append("How to work:\n" + "\n".join(f"- {e}" for e in memory))
    if user:
        parts.append("About Sean:\n" + "\n".join(f"- {e}" for e in user))
    text = "\n\n".join(parts)
    return text if len(text) <= MAX_CHARS else text[: MAX_CHARS - 40] + "\n... (cut: memory longer than the cap)"


def handoff_memory_context(session_id: str, parent_session_id: str = "") -> str | None:
    """The shared memory for a hand-off's first turn; None for top-level chats (Hermes loads it for them) and for
    turns after the first."""
    if not parent_session_id or not session_id:
        return None
    with _seen_lock:
        if session_id in _seen:
            return None
        _seen[session_id] = True
        while len(_seen) > _SEEN_LIMIT:
            _seen.popitem(last=False)
    return memory_block()


def forget_seen() -> None:
    with _seen_lock:
        _seen.clear()
