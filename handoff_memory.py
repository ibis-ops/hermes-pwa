"""Shared memory for hand-offs.

Hermes builds every delegated child (a hand-off from the router, the manager or any bot) with ``skip_memory=True``:
the bot that does the work never sees the shared MEMORY.md and USER.md that every top-level chat gets, so lessons
the team has learned (where things are, which tool works, what Sean wants) are missing exactly where the work
happens. These ``pre_llm_call`` pieces hand a child the same shared memory once, on its first turn.

Hermes swaps any one hook's context over 10,000 characters for a preview and a file path, and the memory may reach
26,000 (20,000 for MEMORY.md plus 6,000 for USER.md), so it goes in up to ``PARTS`` pieces of at most ``PART_MAX``
characters, each from its own hook. The memory is the one shared folder every profile links to (<Hermes root>/
memories, which points at the vault's Hermes/Memory). Read-only: nothing here writes memory.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

try:  # Loaded as part of the plugin package (the gateway's hooks).
    from .bot_graph import _root_hermes_home  # type: ignore
except ImportError:  # Loaded on its own (the tests).
    from bot_graph import _root_hermes_home  # type: ignore

DELIMITER = "\n§\n"
PARTS = 3
PART_MAX = 9500
_SEEN_LIMIT = 4000
_seen_lock = threading.Lock()
_seen: "OrderedDict[tuple[int, str], bool]" = OrderedDict()


def _memory_dir() -> Path:
    return _root_hermes_home() / "memories"


def _entries(name: str) -> list[str]:
    try:
        text = (_memory_dir() / name).read_text(encoding="utf-8")
    except OSError:
        return []
    return [e.strip() for e in text.split(DELIMITER) if e.strip()]


def memory_parts() -> list[str]:
    """The shared memory as at most PARTS pieces of at most PART_MAX characters, whole entries only."""
    lines = [("About Sean", e) for e in _entries("USER.md")] + [("How to work", e) for e in _entries("MEMORY.md")]
    if not lines:
        return []
    chunks: list[list[tuple[str, str]]] = [[]]
    size = 0
    for kind, entry in lines:
        cost = len(entry) + 4 + (len(kind) + 3 if not chunks[-1] or chunks[-1][-1][0] != kind else 0)
        if chunks[-1] and size + cost > PART_MAX - 400:
            chunks.append([])
            size = 0
        chunks[-1].append((kind, entry[: PART_MAX - 600]))
        size += cost
    chunks = chunks[:PARTS]
    out = []
    for i, chunk in enumerate(chunks, 1):
        head = (f"SHARED MEMORY, part {i} of {len(chunks)} (the notes every Hermes bot keeps; a hand-off does not load them "
                "by itself, so here they are). Follow them like your own memory; your SOUL and the task come first where "
                "they differ.")
        body, last = [], None
        for kind, entry in chunk:
            if kind != last:
                body.append(f"\n{kind}:")
                last = kind
            body.append(f"- {entry}")
        out.append(head + "\n" + "\n".join(body))
    return out


def handoff_memory_part(index: int, session_id: str, parent_session_id: str = "") -> str | None:
    """Piece ``index`` of the shared memory for a hand-off's first turn; None for top-level chats (Hermes loads
    memory for them), for later turns and when the memory has fewer pieces."""
    if not parent_session_id or not session_id:
        return None
    with _seen_lock:
        key = (index, session_id)
        if key in _seen:
            return None
        _seen[key] = True
        while len(_seen) > _SEEN_LIMIT * PARTS:
            _seen.popitem(last=False)
    parts = memory_parts()
    return parts[index] if index < len(parts) else None


def part_hooks() -> list[Callable[..., Any]]:
    """One pre_llm_call hook per piece, so Hermes measures each piece on its own."""
    def make(i: int) -> Callable[..., Any]:
        def hook(**kwargs: Any) -> dict[str, str] | None:
            try:
                text = handoff_memory_part(i, str(kwargs.get("session_id") or ""), str(kwargs.get("parent_session_id") or ""))
            except Exception:
                return None
            return {"context": text} if text else None
        hook.__name__ = f"handoff_memory_part_{i}"
        return hook
    return [make(i) for i in range(PARTS)]


def handoff_memory_context(session_id: str, parent_session_id: str = "") -> str | None:
    """All pieces joined (kept for callers that want one block)."""
    pieces = [handoff_memory_part(i, session_id, parent_session_id) for i in range(PARTS)]
    joined = "\n\n".join(p for p in pieces if p)
    return joined or None


def forget_seen() -> None:
    with _seen_lock:
        _seen.clear()
