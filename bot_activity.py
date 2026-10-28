"""What each Hermes bot is working on right now, for the phone's Bots tab.

During a turn Hermes stamps the session row's ``last_activity_at`` and
``last_activity_description`` (``"executing tool: terminal"``, ``"starting API
call #3"``) about once a minute, and clears the description to ``''`` when the
turn ends (the time is kept). An open session whose label is set and younger
than ``WORKING_WINDOW_S`` is live work; a turn that died stops counting once
its label goes stale.

Delegated runs are rows in the delegating bot's ``state.db``: ``source``
``'subagent'``, or a child row (``parent_session_id`` set) whose
``profile_name`` is another bot. Every row is credited to the bot its
``profile_name`` names, and a delegated row also names the bot that asked.

Read-only, metadata only: titles, activity labels and times, never message text.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from agent_history import SUBAGENT_SOURCES, _columns, _goal
from obsidian_activity import BoundedCache, hermes_home, state_databases

WORKING_WINDOW_S = 180
RECENT_DAYS = 30
WORKING_LIMIT = 50
RECENT_LIMIT = 300
WORK_PER_BOT = 5
TITLE_CHARS = 160
ACTIVITY_CHARS = 120
MESSAGING_SOURCES = frozenset(
    {"signal", "telegram", "whatsapp", "slack", "discord", "sms", "email", "matrix", "imessage"}
)

_COLUMNS = (
    "id", "source", "title", "profile_name", "parent_session_id",
    "started_at", "ended_at", "last_activity_at", "last_activity_description",
)
# When a session was last active: the first of these that is set (SQL COALESCE order).
_SEEN_COLUMNS = ("last_activity_at", "ended_at", "started_at")


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def _clip(value: object, limit: int) -> str | None:
    """``value`` on one line, cut at ``limit`` characters with an ellipsis; None when empty."""
    text = " ".join(str(value or "").split())
    if not text:
        return None
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def _seen(row: dict[str, object]) -> float | None:
    for name in _SEEN_COLUMNS:
        if row.get(name) is not None:
            return _number(row.get(name))
    return None


def _bot(row: dict[str, object], owner: str) -> str:
    return _text(row.get("profile_name")) or owner


def _attribution(row: dict[str, object], owner: str) -> tuple[str, str, str | None]:
    """``(bot, kind, requested_by)`` for one session row found in ``owner``'s database."""
    bot = _bot(row, owner)
    source = _text(row.get("source")).lower()
    child_of_another_bot = bool(_text(row.get("parent_session_id"))) and bot != owner
    if source in SUBAGENT_SOURCES or child_of_another_bot:
        kind = "delegated"
    elif source == "cron":
        kind = "scheduled"
    elif source in MESSAGING_SOURCES:
        kind = "messaging"
    else:
        kind = "chat"
    return bot, kind, owner if kind == "delegated" and owner != bot else None


def _working_rows(conn: sqlite3.Connection, columns: set[str], selected: list[str], now: float) -> list[dict[str, object]]:
    """Open sessions whose activity label is set and fresh, newest first."""
    if "last_activity_at" not in columns or "last_activity_description" not in columns:
        return []
    still_open = "ended_at IS NULL AND " if "ended_at" in columns else ""
    try:
        rows = conn.execute(
            f"""
            SELECT {', '.join(selected)} FROM sessions
            WHERE {still_open}TRIM(COALESCE(last_activity_description, '')) != '' AND last_activity_at >= ?
            ORDER BY last_activity_at DESC LIMIT ?
            """,
            (now - WORKING_WINDOW_S, WORKING_LIMIT),
        ).fetchall()
    except sqlite3.Error:
        return []
    return [dict(zip(selected, row)) for row in rows]


def _recent_rows(conn: sqlite3.Connection, columns: set[str], selected: list[str], now: float) -> list[dict[str, object]]:
    """The newest sessions of the last ``RECENT_DAYS``, by when each was last active."""
    present = [name for name in _SEEN_COLUMNS if name in columns]
    if not present:
        return []
    seen = f"COALESCE({', '.join(present)})" if len(present) > 1 else present[0]
    try:
        rows = conn.execute(
            f"SELECT {', '.join(selected)} FROM sessions WHERE {seen} >= ? ORDER BY {seen} DESC LIMIT ?",
            (now - RECENT_DAYS * 86400, RECENT_LIMIT),
        ).fetchall()
    except sqlite3.Error:
        return []
    return [dict(zip(selected, row)) for row in rows]


def collect_sessions(db_path: Path, now: float) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """``(working, recent)`` session rows from one ``state.db``; both empty when it cannot be read."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return [], []
    try:
        columns = _columns(conn, "sessions")
        if "id" not in columns:
            return [], []
        selected = [name for name in _COLUMNS if name in columns]
        return _working_rows(conn, columns, selected, now), _recent_rows(conn, columns, selected, now)
    finally:
        conn.close()


def _work_item(row: dict[str, object], kind: str, requested_by: str | None) -> dict[str, object] | None:
    activity = _clip(row.get("last_activity_description"), ACTIVITY_CHARS)
    updated = _number(row.get("last_activity_at"))
    session_id = str(row.get("id") or "")
    if activity is None or updated is None or not session_id:
        return None
    return {
        "kind": kind,
        "title": _clip(_goal(row.get("title")), TITLE_CHARS),
        "activity": activity,
        "requested_by": requested_by,
        "source": _text(row.get("source")) or None,
        "session_id": session_id,
        "started_at": _number(row.get("started_at")),
        "updated_at": updated,
    }


def build_activity(*, hermes_root: Path | None = None, now: float | None = None) -> dict[str, object]:
    now = float(now) if now is not None else time.time()
    owners: list[str] = []
    work: dict[str, list[dict[str, object]]] = {}
    newest: dict[str, tuple[float, str | None]] = {}
    listed: set[str] = set()
    for owner, db_path in state_databases(hermes_root):
        owners.append(owner)
        working, recent = collect_sessions(db_path, now)
        for row in working:
            bot, kind, requested_by = _attribution(row, owner)
            item = _work_item(row, kind, requested_by)
            if item is not None and item["session_id"] not in listed:
                listed.add(str(item["session_id"]))
                work.setdefault(bot, []).append(item)
        for row in (*working, *recent):
            bot, seen = _bot(row, owner), _seen(row)
            if seen is not None and (bot not in newest or seen > newest[bot][0]):
                newest[bot] = (seen, _clip(_goal(row.get("title")), TITLE_CHARS))
    bots: dict[str, object] = {}
    for bot in [*dict.fromkeys(owners), *sorted((set(work) | set(newest)) - set(owners))]:
        items = sorted(work.get(bot, []), key=lambda item: float(item["updated_at"]), reverse=True)  # type: ignore[arg-type]
        last = newest.get(bot)
        bots[bot] = {
            "working": bool(items),
            "work": items[:WORK_PER_BOT],
            "last_active_at": last[0] if last else None,
            "last_title": last[1] if last else None,
        }
    return {"scanned_at": now, "working_window_seconds": WORKING_WINDOW_S, "bots": bots}


_CACHE = BoundedCache(ttl_seconds=3.0)


def cached_activity() -> dict[str, object]:
    """``build_activity`` behind a 3 second cache per Hermes home: the phone polls it while a bot works.

    The key carries ``WORKING_WINDOW_S`` only to fit ``BoundedCache``'s (home, int) keys.
    """
    key = (str(hermes_home()), WORKING_WINDOW_S)
    return _CACHE.get(key, lambda: build_activity(now=time.time()))


def clear_cache() -> None:
    _CACHE.clear()


__all__ = [
    "MESSAGING_SOURCES",
    "WORKING_WINDOW_S",
    "build_activity",
    "cached_activity",
    "clear_cache",
    "collect_sessions",
]
