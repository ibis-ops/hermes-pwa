"""Jev routing for the router bot: who should handle each of Sean's messages.

Sean put a router bot on top of his team map. For each message he sends it,
Jev (TypeSafe's decision model, called through OpenRouter's Decisions API)
reads the message and picks who should take it: the router itself, which runs
a fast model and answers quick things at once, or one of the bots the router
can hand work to. The router is told the pick at the start of its turn, before
the model runs, and acts on it with ``delegate_task``. When Jev is unsure,
unreachable or not set up, the router is told so and decides for itself.

Settings live in the plugin's state folder (``router.json``): whether routing
is on, which bot is the router, the Jev model, and how sure Jev must be. The
OpenRouter key comes from the environment (``OPENROUTER_API_KEY`` in Hermes's
``.env``), the same way the plugin reads its push keys. Each decision is kept
in a short local log (``router_decisions.jsonl``) so the phone app can show
it. Nothing here reads or writes Hermes configuration except a read-only look
at the router's own delegation routes.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:  # Loaded as part of the plugin package (the hooks).
    from . import bot_graph  # type: ignore
    from .push_common import state_file_lock  # type: ignore
except ImportError:  # Loaded on its own (the dashboard routes, the tests).
    import bot_graph  # type: ignore
    from push_common import state_file_lock  # type: ignore

logger = logging.getLogger(__name__)

JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_JEV_MODEL = "~typesafe/jev-latest"
DEFAULT_MIN_CONFIDENCE = 0.6
MIN_CONFIDENCE_RANGE = (0.3, 0.95)
JEV_TIMEOUT_SECONDS = 4.0
# Jev reads at most this much of a message; a longer one is real work anyway.
MAX_MESSAGE_CHARS = 6000
MAX_PREVIOUS_CHARS = 800
# A message counts as following up the previous one within this window.
FOLLOW_UP_SECONDS = 30 * 60
LOG_KEEP = 300
PREVIEW_CHARS = 60
SELF = "answer"
MODEL_RE = re.compile(r"^~?[a-z0-9][a-z0-9._/-]{0,79}$")

_settings_lock = threading.Lock()
_settings_cache: tuple[tuple[int, int, int], dict[str, Any]] | None = None
_previous_lock = threading.Lock()
# The last routed message per session, for follow-ups: {session: (time, text, route)}.
_previous: dict[str, tuple[float, str, str]] = {}


class RouterSettingsError(ValueError):
    """Router settings sent to be saved are not valid."""


def _state_dir() -> Path:
    return bot_graph.graph_path().parent


def settings_path() -> Path:
    return _state_dir() / "router.json"


def decisions_path() -> Path:
    return _state_dir() / "router_decisions.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_settings() -> dict[str, Any]:
    return {"enabled": False, "bot": "router", "jevModel": DEFAULT_JEV_MODEL, "minConfidence": DEFAULT_MIN_CONFIDENCE}


def validate_settings(raw: object, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """A clean copy of settings sent to be saved; missing keys keep ``base``."""
    if not isinstance(raw, dict):
        raise RouterSettingsError("expected a JSON object")
    settings = dict(base or default_settings())
    if "enabled" in raw:
        if not isinstance(raw["enabled"], bool):
            raise RouterSettingsError("enabled must be true or false")
        settings["enabled"] = raw["enabled"]
    if "bot" in raw:
        bot = raw["bot"]
        if not isinstance(bot, str) or not bot_graph.NAME_RE.match(bot):
            raise RouterSettingsError("bot must be a bot name")
        settings["bot"] = bot
    if "jevModel" in raw:
        model = raw["jevModel"]
        if not isinstance(model, str) or not MODEL_RE.match(model.strip()):
            raise RouterSettingsError("jevModel must be an OpenRouter model id")
        settings["jevModel"] = model.strip()
    if "minConfidence" in raw:
        value = raw["minConfidence"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise RouterSettingsError("minConfidence must be a number")
        low, high = MIN_CONFIDENCE_RANGE
        if not low <= float(value) <= high:
            raise RouterSettingsError(f"minConfidence must be between {low} and {high}")
        settings["minConfidence"] = round(float(value), 2)
    return settings


def load_settings() -> dict[str, Any]:
    """The saved settings over the defaults. Cached until the file changes."""
    global _settings_cache
    path = settings_path()
    try:
        stat = path.stat()
    except OSError:
        return default_settings()
    key = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
    with _settings_lock:
        if _settings_cache and _settings_cache[0] == key:
            return dict(_settings_cache[1])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        settings = validate_settings(data)
        settings["updatedAt"] = str(data.get("updatedAt") or "")
    except (OSError, ValueError, TypeError):
        settings = default_settings()
    with _settings_lock:
        _settings_cache = (key, settings)
    return dict(settings)


def save_settings(raw: object) -> dict[str, Any]:
    """Merge and save settings sent from the app."""
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with state_file_lock(path):
        try:
            current = validate_settings(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError):
            current = default_settings()
        settings = validate_settings(raw, current)
        record = {**settings, "updatedAt": _now_iso()}
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(record, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)
    return record


def openrouter_key() -> str | None:
    key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
    return key or None


def delegation_routes() -> tuple[dict[str, str] | None, bool]:
    """This bot's delegation profile routes as ``{profile: description}``, and whether a
    delegated bot may hand work on (orchestration). ``(None, False)`` when profile routes are off
    or the config cannot be read. Read-only: ``load_config_readonly`` is never mutated."""
    try:
        from hermes_cli.config import load_config_readonly  # type: ignore

        config = load_config_readonly() or {}
    except Exception:
        return None, False
    delegation = config.get("delegation") if isinstance(config, dict) else None
    if not isinstance(delegation, dict) or delegation.get("backend") != "profile_routes":
        return None, False
    backends = delegation.get("backends") if isinstance(delegation.get("backends"), dict) else {}
    section = backends.get("profile_routes") if isinstance(backends.get("profile_routes"), dict) else {}
    routes: dict[str, str] = {}
    for entry in section.get("profiles") or []:
        if isinstance(entry, dict) and isinstance(entry.get("name"), str) and entry["name"].strip():
            routes[entry["name"].strip()] = str(entry.get("description") or "").strip()
    try:
        depth = int(delegation.get("max_spawn_depth") or 1)
    except (TypeError, ValueError):
        depth = 1
    return routes, depth >= 2 and delegation.get("orchestrator_enabled", True) is not False


def candidates(bot: str, graph: dict[str, Any] | None, routes: dict[str, str] | None) -> dict[str, str]:
    """Who the router may hand a message to, with what each one does.

    The team map says whom the router can message; the router's delegation routes say whom it
    can actually hand work to. Both apply when both are known.
    """
    nodes = (graph or {}).get("nodes") or {}
    me = nodes.get(bot) or {}
    targets = list(me.get("canMessage") or []) if me else []
    if not targets and routes is not None:
        targets = [name for name in routes if name != bot]
    if routes is not None:
        targets = [name for name in targets if name in routes]
    out: dict[str, str] = {}
    for name in targets:
        if name == bot or name == SELF:
            continue
        role = str((nodes.get(name) or {}).get("role") or "").strip()
        description = role or (routes or {}).get(name, "") or f"The bot called {bot_graph.bot_label(name)}."
        out[name] = description
    return out


def _criteria(bot: str, options: dict[str, str]) -> dict[str, str]:
    criteria = {
        SELF: (
            f"{bot_graph.bot_label(bot)} answers on its own, at once, in a few lines: a quick fact or "
            "definition, a calculation, a short rewrite or translation, small talk, a simple how-to, or a "
            "follow-up about its own last answer. Nothing to look up in Sean's accounts, files or notes, "
            "nothing to send, schedule or change."
        )
    }
    for name, description in options.items():
        criteria[name] = f"Hand it to {bot_graph.bot_label(name)}: {description}"
    return criteria


def _state(message: str, previous: tuple[float, str, str] | None, now: float) -> dict[str, Any]:
    state: dict[str, Any] = {"message": message[:MAX_MESSAGE_CHARS]}
    if previous and now - previous[0] <= FOLLOW_UP_SECONDS:
        state["previous_message"] = previous[1][:MAX_PREVIOUS_CHARS]
        state["previous_route"] = previous[2]
    return state


Poster = Callable[[str, dict[str, str], bytes, float], dict[str, Any]]


def _post_json(url: str, headers: dict[str, str], body: bytes, timeout: float) -> dict[str, Any]:
    from urllib.request import Request, urlopen

    request = Request(url, data=body, headers=headers, method="POST")
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https endpoint
        return json.loads(response.read().decode("utf-8"))


def ask_jev(
    message: str,
    *,
    bot: str,
    options: dict[str, str],
    key: str,
    model: str,
    session_id: str = "",
    previous: tuple[float, str, str] | None = None,
    post: Poster | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """One Jev decision: ``{"choice", "confidence", "probabilities", "cost"}``. Raises on failure."""
    now = time.time() if now is None else now
    body = {
        "model": model,
        "state": _state(message, previous, now),
        "questions": {
            "route": {
                "type": "choice",
                "instructions": (
                    f"Sean sent this message to {bot_graph.bot_label(bot)}, the router bot on top of his team. "
                    "Who should handle it? Choose the router itself only for quick things it can answer at once. "
                    "Choose the bot whose job covers the work for anything that needs Sean's email, calendar, "
                    "coaching data, notes, files, research or several steps. A short follow-up goes where the "
                    "previous message went."
                ),
                "criteria": _criteria(bot, options),
            }
        },
    }
    if session_id:
        body["session_id"] = session_id[:256]
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-Title": "Hermes phone app router",
    }
    response = (post or _post_json)(JEV_ENDPOINT, headers, json.dumps(body).encode("utf-8"), JEV_TIMEOUT_SECONDS)
    answer = ((response or {}).get("answers") or {}).get("route") or {}
    choice = answer.get("choice")
    if not isinstance(choice, str) or (choice != SELF and choice not in options):
        raise ValueError("Jev returned no usable choice")
    try:
        confidence = float(answer.get("confidence"))
    except (TypeError, ValueError):
        confidence = 0.0
    probabilities = answer.get("probabilities") if isinstance(answer.get("probabilities"), dict) else {}
    cost = ((response or {}).get("usage") or {}).get("cost")
    return {
        "choice": choice,
        "confidence": max(0.0, min(1.0, confidence)),
        "probabilities": {str(k): float(v) for k, v in probabilities.items() if isinstance(v, (int, float))},
        "cost": float(cost) if isinstance(cost, (int, float)) else None,
    }


def _short_error(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        if code in (401, 403):
            return "OpenRouter refused the key"
        if code == 402:
            return "the OpenRouter account is out of credit"
        if code == 429:
            return "OpenRouter is rate limiting"
        return f"OpenRouter answered {code}"
    if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower():
        return "Jev took too long"
    return "Jev could not be reached"


def decide(
    message: str,
    *,
    bot: str,
    settings: dict[str, Any],
    graph: dict[str, Any] | None,
    routes: dict[str, str] | None,
    session_id: str = "",
    key: str | None = None,
    post: Poster | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """Who takes this message. ``source`` is "jev" when Jev's pick stands, else "router"."""
    now = time.time() if now is None else now
    options = candidates(bot, graph, routes)
    with _previous_lock:
        previous = _previous.get(session_id) if session_id else None
    decision: dict[str, Any] = {
        "route": None,
        "confidence": None,
        "guess": None,
        "source": "router",
        "reason": "",
        "options": options,
        "cost": None,
        "ms": None,
    }
    if not options:
        decision.update(route=SELF, reason="no other bot to hand work to")
    elif not key:
        decision["reason"] = "no OpenRouter key on the Mac"
    else:
        started = time.monotonic()
        try:
            answer = ask_jev(
                message,
                bot=bot,
                options=options,
                key=key,
                model=str(settings.get("jevModel") or DEFAULT_JEV_MODEL),
                session_id=session_id,
                previous=previous,
                post=post,
                now=now,
            )
        except Exception as exc:  # network, HTTP or a malformed answer: the router decides
            logger.debug("Hermes PWA router: Jev failed: %s", exc)
            decision["reason"] = _short_error(exc)
            close = getattr(exc, "close", None)  # an HTTPError holds the response open
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        else:
            decision.update(cost=answer["cost"], confidence=answer["confidence"])
            if answer["confidence"] >= float(settings.get("minConfidence") or DEFAULT_MIN_CONFIDENCE):
                decision.update(route=answer["choice"], source="jev")
            else:
                decision.update(guess=answer["choice"], reason="Jev was not sure")
        decision["ms"] = int((time.monotonic() - started) * 1000)
    if session_id:
        with _previous_lock:
            _previous[session_id] = (now, message, decision["route"] or decision["guess"] or "")
            if len(_previous) > 2000:
                for stale in sorted(_previous, key=lambda s: _previous[s][0])[:500]:
                    _previous.pop(stale, None)
    return decision


def _who(name: str) -> str:
    return f"{bot_graph.bot_label(name)} (@{name})"


def _percent(value: float | None) -> str:
    return f"{round((value or 0) * 100)}%"


def directive(bot: str, decision: dict[str, Any], orchestration: bool) -> str:
    """What the router is told before it answers."""
    route = decision.get("route")
    options: dict[str, str] = decision.get("options") or {}
    head = "[Router note from Sean's phone app, for this message only.]"
    if route == SELF:
        if decision.get("source") == "jev":
            return (
                f"{head} Jev read this message and picked you to answer it yourself "
                f"({_percent(decision.get('confidence'))} sure). Answer it directly and keep it short. "
                "Hand it on only if it turns out to need another bot's tools."
            )
        return f"{head} There is no other bot to hand work to, so answer it yourself."
    if route:
        hint = (
            f"Hand it over with delegate_task, profile \"{route}\""
            + (", role \"orchestrator\"" if orchestration and route == "manager" else "")
            + ". Put everything it needs in the goal: what Sean asked, the names, dates and details he gave, "
            "and what to send back. When it finishes, give Sean the result in a few lines."
        )
        return f"{head} Jev picked {_who(route)} for this ({_percent(decision.get('confidence'))} sure). {hint}"
    roster = "; ".join(f"{_who(name)}: {description}" for name, description in options.items())
    if decision.get("guess"):
        why = f"Jev was not sure who should take this (best guess {_who(decision['guess'])}, {_percent(decision.get('confidence'))})."
    else:
        why = f"Jev did not decide this time ({decision.get('reason') or 'unavailable'})."
    return (
        f"{head} {why} Decide yourself: answer quick things directly; hand real work to the bot whose job "
        f"covers it with delegate_task and its profile name. Your team: {roster}."
    )


def _preview(text: str) -> str:
    line = re.sub(r"\s+", " ", text).strip()
    return line if len(line) <= PREVIEW_CHARS else line[: PREVIEW_CHARS - 1].rstrip() + "…"


def text_key(text: str) -> str:
    """A short fingerprint of a message, the same one the phone app computes (FNV-1a, 32 bit),
    so a decision can be shown under the reply it led to without storing the message."""
    value = 0x811C9DC5
    for byte in re.sub(r"\s+", " ", text).strip()[:2000].encode("utf-8"):
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def record(decision: dict[str, Any], *, bot: str, session_id: str, message: str) -> dict[str, Any]:
    """Append a decision to the local log, keeping the newest ``LOG_KEEP``."""
    entry = {
        "at": _now_iso(),
        "bot": bot,
        "sessionId": session_id,
        "key": text_key(message),
        "preview": _preview(message),
        "route": decision.get("route"),
        "guess": decision.get("guess"),
        "confidence": decision.get("confidence"),
        "source": decision.get("source"),
        "reason": decision.get("reason") or "",
        "ms": decision.get("ms"),
        "cost": decision.get("cost"),
    }
    path = decisions_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with state_file_lock(path):
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                lines = []
            lines.append(json.dumps(entry, sort_keys=True))
            lines = lines[-LOG_KEEP:]
            tmp = path.with_suffix(".jsonl.tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write("\n".join(lines) + "\n")
            os.replace(tmp, path)
    except OSError as exc:
        logger.debug("Hermes PWA router: decision not logged: %s", exc)
    return entry


def recent(session_id: str = "", limit: int = 50) -> list[dict[str, Any]]:
    """The newest decisions first, for one session when given."""
    try:
        lines = decisions_path().read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out: list[dict[str, Any]] = []
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or (session_id and entry.get("sessionId") != session_id):
            continue
        out.append(entry)
        if len(out) >= max(1, min(limit, LOG_KEEP)):
            break
    return out


# Hermes wakes a bot with notices of its own (a finished background job, a delegated result).
_NOTICE_RE = re.compile(r"^\s*\[[^\]\n]*(notification|notice|background|delegat|subagent|process|system|reminder|cron)", re.I)


def hook_context(
    session_id: str,
    user_message: str,
    *,
    parent_session_id: str = "",
    bot: str | None = None,
    post: Poster | None = None,
) -> str | None:
    """The router note for this turn, or None when this bot is not the router or routing is off."""
    if not session_id or parent_session_id:
        return None
    text = str(user_message or "").strip()
    if not text or _NOTICE_RE.match(text):
        return None
    settings = load_settings()
    if not settings.get("enabled"):
        return None
    name = bot or bot_graph._current_bot()
    if not name or name != settings.get("bot"):
        return None
    routes, orchestration = delegation_routes()
    decision = decide(
        text,
        bot=name,
        settings=settings,
        graph=bot_graph.load(),
        routes=routes,
        session_id=session_id,
        key=openrouter_key(),
        post=post,
    )
    record(decision, bot=name, session_id=session_id, message=text)
    return directive(name, decision, orchestration)


def status() -> dict[str, Any]:
    """What the app shows: the settings and whether Jev can be asked."""
    return {"settings": load_settings(), "keyConfigured": openrouter_key() is not None}


def forget_previous() -> None:
    """For tests."""
    global _settings_cache
    with _previous_lock:
        _previous.clear()
    with _settings_lock:
        _settings_cache = None
