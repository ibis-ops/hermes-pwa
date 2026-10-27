"""Every agent Hermes delegated to, across all profiles, for the phone's Agents tab.

A delegated task runs as its own Hermes session: ``source='subagent'`` in the
delegating profile's ``state.db``, ``profile_name`` naming the bot that ran
it, ``title`` holding the goal, ``parent_session_id`` pointing at the chat
that asked for it. Reading those rows gives a durable history of which bots
did what and when, long after the live subagent events are gone.

Read-only, metadata plus each run's final answer (trimmed), never the full
transcript.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from obsidian_activity import BoundedCache, hermes_home, snap_days, state_databases

SUBAGENT_SOURCES = ("subagent", "delegate", "delegation", "spawn")
TITLE_PREFIXES = ("Subagent: ", "Subagent:", "Delegate: ", "Delegation: ")
RESULT_CHARS = 4000
RUNNING_GRACE_S = 15 * 60

_SESSION_COLUMNS = (
    "id", "profile_name", "title", "model", "started_at", "ended_at", "end_reason",
    "message_count", "tool_call_count", "input_tokens", "output_tokens",
    "estimated_cost_usd", "actual_cost_usd", "parent_session_id", "last_activity_at",
    "last_activity_description",
)


def _goal(title: object) -> str:
    text = str(title or "").strip()
    for prefix in TITLE_PREFIXES:
        if text.startswith(prefix):
            return text[len(prefix):].strip()
    return text


def _status(row: dict[str, object], now: float) -> str:
    ended = row.get("ended_at")
    reason = str(row.get("end_reason") or "").lower()
    if not isinstance(ended, (int, float)):
        last = row.get("last_activity_at") or row.get("started_at")
        recent = isinstance(last, (int, float)) and now - float(last) < RUNNING_GRACE_S
        return "running" if recent else "unknown"
    if any(word in reason for word in ("error", "fail", "timeout", "crash")):
        return "failed"
    if any(word in reason for word in ("interrupt", "cancel", "reap", "orphan", "abort", "kill")):
        return "interrupted"
    return "completed"


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _result_text(conn: sqlite3.Connection, session_id: str) -> str | None:
    try:
        row = conn.execute(
            """
            SELECT content FROM messages
            WHERE session_id = ? AND role = 'assistant' AND content IS NOT NULL AND TRIM(content) != ''
            ORDER BY timestamp DESC, id DESC LIMIT 1
            """,
            (session_id,),
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row or not isinstance(row[0], str):
        return None
    text = row[0].strip()
    return text if len(text) <= RESULT_CHARS else text[:RESULT_CHARS].rstrip() + "…"


def _parent(conn: sqlite3.Connection, parent_id: object, columns: set[str]) -> dict[str, object] | None:
    if not isinstance(parent_id, str) or not parent_id:
        return None
    wanted = [name for name in ("id", "title", "source", "profile_name") if name in columns]
    try:
        row = conn.execute(f"SELECT {', '.join(wanted)} FROM sessions WHERE id = ?", (parent_id,)).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return {"id": parent_id, "title": None, "source": None, "profile": None}
    record = dict(zip(wanted, row))
    return {
        "id": parent_id,
        "title": record.get("title"),
        "source": record.get("source"),
        "profile": record.get("profile_name"),
    }


def collect_runs(db_path: Path, owner_profile: str, since: float, now: float, limit: int) -> list[dict[str, object]]:
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return []
    runs: list[dict[str, object]] = []
    try:
        columns = _columns(conn, "sessions")
        if "source" not in columns or "started_at" not in columns:
            return []
        selected = [name for name in _SESSION_COLUMNS if name in columns]
        placeholders = ", ".join("?" for _ in SUBAGENT_SOURCES)
        try:
            rows = conn.execute(
                f"""
                SELECT {', '.join(selected)} FROM sessions
                WHERE source IN ({placeholders}) AND started_at >= ?
                ORDER BY started_at DESC LIMIT ?
                """,
                (*SUBAGENT_SOURCES, since, limit),
            ).fetchall()
        except sqlite3.Error:
            return []
        for raw in rows:
            row = dict(zip(selected, raw))
            started = row.get("started_at")
            if not isinstance(started, (int, float)):
                continue
            ended = row.get("ended_at") if isinstance(row.get("ended_at"), (int, float)) else None
            status = _status(row, now)
            duration = (float(ended) - float(started)) if ended is not None else (
                now - float(started) if status == "running" else None
            )
            cost = row.get("actual_cost_usd") if isinstance(row.get("actual_cost_usd"), (int, float)) else row.get("estimated_cost_usd")
            runs.append(
                {
                    "id": str(row.get("id") or ""),
                    "bot": str(row.get("profile_name") or owner_profile),
                    "owner_profile": owner_profile,
                    "goal": _goal(row.get("title")),
                    "model": row.get("model"),
                    "status": status,
                    "started_at": float(started),
                    "ended_at": float(ended) if ended is not None else None,
                    "duration_seconds": duration,
                    "message_count": row.get("message_count") or 0,
                    "tool_call_count": row.get("tool_call_count") or 0,
                    "input_tokens": row.get("input_tokens") or 0,
                    "output_tokens": row.get("output_tokens") or 0,
                    "cost_usd": float(cost) if isinstance(cost, (int, float)) else None,
                    "last_activity": row.get("last_activity_description"),
                    "parent": _parent(conn, row.get("parent_session_id"), columns),
                    "result": _result_text(conn, str(row.get("id") or "")),
                }
            )
    finally:
        conn.close()
    return runs


def build_history(*, hermes_root: Path | None = None, days: int = 30, limit: int = 200, now: float | None = None) -> dict[str, object]:
    now = now if now is not None else time.time()
    days = max(1, min(int(days), 3650))
    limit = max(1, min(int(limit), 1000))
    since = now - days * 86400
    runs: list[dict[str, object]] = []
    profiles: list[str] = []
    for profile, db_path in state_databases(hermes_root):
        profiles.append(profile)
        runs.extend(collect_runs(db_path, profile, since, now, limit))
    runs.sort(key=lambda run: float(run["started_at"]), reverse=True)  # type: ignore[arg-type]
    return {
        "profiles": profiles,
        "days": days,
        "scanned_at": now,
        "total": len(runs),
        "runs": runs[:limit],
    }


MAX_LIMIT = 1000
_CACHE = BoundedCache(ttl_seconds=10.0)


def cached_history(days: int = 30, limit: int = 200) -> dict[str, object]:
    """``build_history`` behind a short, bounded cache keyed by (home, days bucket).

    ``days`` is rounded up to one of ``obsidian_activity.DAY_BUCKETS`` and the
    scan keeps ``MAX_LIMIT`` runs; ``limit`` is applied to the cached copy.
    """
    bucket = snap_days(days)
    wanted = max(1, min(int(limit), MAX_LIMIT))
    key = (str(hermes_home()), bucket)
    result = _CACHE.get(key, lambda: build_history(days=bucket, limit=MAX_LIMIT, now=time.time()))
    runs = result.get("runs")
    if isinstance(runs, list) and len(runs) > wanted:
        return {**result, "runs": runs[:wanted]}
    return result


def clear_cache() -> None:
    _CACHE.clear()


__all__ = ["build_history", "cached_history", "clear_cache", "collect_runs", "MAX_LIMIT", "SUBAGENT_SOURCES"]
