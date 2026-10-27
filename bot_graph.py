"""The team map: who each bot reports to and which bots it can message.

Sean draws it in the phone app's Bots tab. It is a map, not a gate: nothing
is blocked. A ``pre_llm_call`` hook tells each bot its place the first time a
chat sees the current map, and again after the map changes, so every bot
knows who it answers to and whom it should hand work to.

The map lives in the plugin's own state folder, next to its other state
files. Nothing here reads or writes Hermes configuration.
"""

from __future__ import annotations

import json
import os
import re
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # Loaded as part of the plugin package (the gateway's hooks).
    from .push_common import plugin_state_dir, state_file_lock  # type: ignore
except ImportError:  # Loaded on its own (the dashboard routes, the tests).
    from push_common import plugin_state_dir, state_file_lock  # type: ignore

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_BOTS = 64
MAX_ROLE_CHARS = 300
# Sessions remembered per process as having seen a given map version.
_SEEN_LIMIT = 4000

_seen_lock = threading.Lock()
_seen: "OrderedDict[str, int]" = OrderedDict()
_cache_lock = threading.Lock()
_cache: tuple[tuple[int, int, int], dict[str, Any] | None] | None = None


class GraphError(ValueError):
    """The map sent to be saved is not a valid team map."""


def _root_hermes_home() -> Path:
    """The Hermes root, never a profile's home: the map is one for all bots."""
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore

        return Path(get_default_hermes_root())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()
        if home.parent.name == "profiles":
            return home.parent.parent
        return home


def graph_path() -> Path:
    try:
        base = _root_hermes_home() / "plugins" / "hermes-pwa"
    except Exception:
        base = plugin_state_dir()
    return base / "bot_graph.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def bot_label(name: str) -> str:
    """``gmail-connector`` reads as "Gmail Connector"."""
    words = [w for w in re.split(r"[-_]+", name) if w]
    return " ".join(w if w.isupper() else w.capitalize() for w in words) or name


def validate(raw: object) -> dict[str, Any]:
    """A clean copy of a map sent to be saved, or GraphError."""
    if not isinstance(raw, dict):
        raise GraphError("expected a JSON object")
    nodes_in = raw.get("nodes")
    if not isinstance(nodes_in, dict):
        raise GraphError("nodes must be an object keyed by bot name")
    if len(nodes_in) > MAX_BOTS:
        raise GraphError(f"a map holds at most {MAX_BOTS} bots")
    names = list(nodes_in.keys())
    for name in names:
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise GraphError(f"not a bot name: {name!r}")
    known = set(names)
    nodes: dict[str, dict[str, Any]] = {}
    for name in names:
        entry = nodes_in[name]
        if not isinstance(entry, dict):
            raise GraphError(f"{name}: expected an object")
        reports_to = entry.get("reportsTo")
        if reports_to is not None:
            if not isinstance(reports_to, str) or reports_to not in known:
                raise GraphError(f"{name}: reports to a bot that is not on the map")
            if reports_to == name:
                raise GraphError(f"{name}: a bot cannot report to itself")
        can_message_in = entry.get("canMessage", [])
        if not isinstance(can_message_in, list) or not all(isinstance(x, str) for x in can_message_in):
            raise GraphError(f"{name}: canMessage must be a list of bot names")
        can_message: list[str] = []
        for target in can_message_in:
            if target == name:
                continue
            if target not in known:
                raise GraphError(f"{name}: can message a bot that is not on the map")
            if target not in can_message:
                can_message.append(target)
        role = entry.get("role", "")
        if role is None:
            role = ""
        if not isinstance(role, str):
            raise GraphError(f"{name}: role must be text")
        role = re.sub(r"\s+", " ", role).strip()
        if len(role) > MAX_ROLE_CHARS:
            raise GraphError(f"{name}: role is longer than {MAX_ROLE_CHARS} characters")
        nodes[name] = {"reportsTo": reports_to, "canMessage": sorted(can_message), "role": role}
    # The reporting lines must form a hierarchy: no bot may end up reporting to itself.
    for start in nodes:
        seen = {start}
        current = nodes[start]["reportsTo"]
        while current is not None:
            if current in seen:
                raise GraphError(f"{start}: the reporting lines go in a circle")
            seen.add(current)
            current = nodes[current]["reportsTo"]
    return {"nodes": nodes}


def load() -> dict[str, Any] | None:
    """The saved map, or None when none was saved. Cached until the file changes."""
    global _cache
    path = graph_path()
    try:
        stat = path.stat()
    except OSError:
        with _cache_lock:
            _cache = None
        return None
    # Each save replaces the file, so the inode changes even within one clock tick.
    key = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
    with _cache_lock:
        if _cache and _cache[0] == key:
            return _cache[1]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        graph = validate(data)
        graph["version"] = int(data.get("version") or 1)
        graph["updatedAt"] = str(data.get("updatedAt") or "")
    except (OSError, ValueError, TypeError):
        graph = None
    with _cache_lock:
        _cache = (key, graph)
    return graph


def save(raw: object) -> dict[str, Any]:
    """Validate and save a map; the version goes up by one each time."""
    graph = validate(raw)
    path = graph_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with state_file_lock(path):
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
            version = int(previous.get("version") or 0) + 1
        except (OSError, ValueError, TypeError, AttributeError):
            version = 1
        record = {"version": version, "updatedAt": _now_iso(), "nodes": graph["nodes"]}
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(record, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)
    return record


def _names(names: list[str]) -> str:
    return ", ".join(f"{bot_label(n)} (@{n})" for n in names)


def context_for(name: str, graph: dict[str, Any]) -> str | None:
    """What a bot is told about its place on the map, or None when it is not on it."""
    nodes = graph.get("nodes") or {}
    me = nodes.get(name)
    if me is None:
        return None
    lines = ["[Team map from Sean, set in the Hermes phone app. A guide for who to work with; nothing is blocked.]"]
    lines.append(f"You are {bot_label(name)} (@{name}).")
    if me.get("role"):
        lines.append(f"Your role: {me['role']}")
    boss = me.get("reportsTo")
    lines.append(f"You report to {bot_label(boss)} (@{boss})." if boss else "You report directly to Sean.")
    team = sorted(n for n, node in nodes.items() if node.get("reportsTo") == name)
    if team:
        lines.append(f"Reporting to you: {_names(team)}.")
    can_message = list(me.get("canMessage") or [])
    if can_message:
        lines.append(f"You can message or hand work to: {_names(can_message)}.")
        lines.append("Keep bot-to-bot messages within these lines unless Sean asks otherwise.")
    else:
        lines.append("You do not message other bots; bring anything you need to Sean.")
    return "\n".join(lines)


def _current_bot() -> str | None:
    try:
        from hermes_cli.profiles import current_profile_name  # type: ignore

        return current_profile_name("default")
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()
        return home.name if home.parent.name == "profiles" else "default"


def hook_context(session_id: str, parent_session_id: str = "", bot: str | None = None) -> str | None:
    """The map for this turn, once per session per map version.

    Delegated child runs (a parent session asked for them) are left alone:
    they carry one task from their parent, not a seat on the team.
    """
    if not session_id or parent_session_id:
        return None
    graph = load()
    if not graph:
        return None
    name = bot or _current_bot()
    if not name:
        return None
    version = int(graph.get("version") or 1)
    with _seen_lock:
        if _seen.get(session_id) == version:
            _seen.move_to_end(session_id)
            return None
    text = context_for(name, graph)
    if text is None:
        return None
    with _seen_lock:
        _seen[session_id] = version
        _seen.move_to_end(session_id)
        while len(_seen) > _SEEN_LIMIT:
            _seen.popitem(last=False)
    return text


def forget_seen() -> None:
    """For tests: every session sees the map again."""
    with _seen_lock:
        _seen.clear()
    global _cache
    with _cache_lock:
        _cache = None
