"""Jev routing for the router bot: who should handle each of Sean's messages.

Sean put a router bot on top of his team map. For each message he sends it,
Jev (TypeSafe's decision model, called through Vercel AI Gateway or OpenRouter)
reads the message and picks who should take it: the router itself, which runs
a fast model and answers quick things at once, or one of the bots the router
can hand work to. The router is told the pick at the start of its turn, before
the model runs, and acts on it with ``delegate_task``. When Jev is unsure,
unreachable or not set up, the router is told so and decides for itself. When
Jev picks a bot that runs a team on the map and Hermes lets only the top of a
delegation hand work on (``delegation.max_spawn_depth`` 1), the router splits
the job across that team itself, since the bot could not use its team.

Settings live in the plugin's state folder (``router.json``): whether routing
is on, which bot is the router, the Jev model, and how sure Jev must be. The
key is the plugin's own ``HERMES_PWA_JEV_API_KEY`` in Hermes's ``.env`` (a
Vercel AI Gateway key, or an OpenRouter one); Hermes's own
``AI_GATEWAY_API_KEY`` or ``OPENROUTER_API_KEY`` work too. The file is read
when a decision is made, so a new key works without a restart. On Vercel each
request asks for zero data retention. Each decision is kept in a short local
log (``router_decisions.jsonl``) so the phone app can show it. Nothing here
writes Hermes configuration; it only reads the key and the router's own
delegation routes.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:  # Loaded as part of the plugin package (the hooks).
    from . import bot_graph, plugin_copies  # type: ignore
    from .push_common import state_file_lock  # type: ignore
except ImportError:  # Loaded on its own (the dashboard routes, the tests).
    import bot_graph  # type: ignore
    import plugin_copies  # type: ignore
    from push_common import state_file_lock  # type: ignore

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class JevProvider:
    """Where Jev is called, and how."""

    name: str
    label: str
    endpoint: str
    default_model: str
    model_prefixes: tuple[str, ...]


VERCEL = JevProvider(
    "vercel", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1/evaluate", "typesafe-ai/jev", ("typesafe-ai/",)
)
OPENROUTER = JevProvider(
    "openrouter", "OpenRouter", "https://openrouter.ai/api/alpha/decisions", "~typesafe/jev-latest", ("typesafe/", "~typesafe/")
)
# The plugin's own key: a Vercel AI Gateway key (vck_...) or an OpenRouter one (sk-or-...).
KEY_ENV = "HERMES_PWA_JEV_API_KEY"
# Checked in this order; Hermes's own provider keys work when the plugin's is not set.
KEY_SOURCES: tuple[tuple[str, JevProvider | None], ...] = (
    (KEY_ENV, None),
    ("AI_GATEWAY_API_KEY", VERCEL),
    ("OPENROUTER_API_KEY", OPENROUTER),
)
# After Vercel refuses zero data retention (it needs a Pro plan), ask without it for this long:
# each refusal costs a round trip, and a plan changes rarely.
ZDR_RETRY_SECONDS = 6 * 3600
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
_env_lock = threading.Lock()
_env_cache: tuple[tuple[int, int, int], dict[str, str]] | None = None
_zdr_lock = threading.Lock()
# When Vercel last refused zero data retention; None while it never has.
_zdr_refused_at: float | None = None


class JevHTTPError(RuntimeError):
    """Jev's endpoint answered with an HTTP error; ``body`` is the start of its answer."""

    def __init__(self, status: int, body: str = ""):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body


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
    # An empty jevModel means the provider's own Jev model.
    return {"enabled": False, "bot": "router", "jevModel": "", "minConfidence": DEFAULT_MIN_CONFIDENCE}


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
        if not isinstance(model, str) or (model.strip() and not MODEL_RE.match(model.strip())):
            raise RouterSettingsError("jevModel must be a model id")
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


def _clean_key(raw: object) -> str:
    """A key as pasted: no whitespace or quotes, and no ``NAME=`` from a copied env line."""
    if not isinstance(raw, str):
        return ""
    value = raw.strip().strip("\"'").strip()
    match = re.match(r"^(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*(.*)$", value)
    if match:
        value = match.group(1).strip().strip("\"'").strip()
    # An unresolved secret-manager reference is not a key.
    if not value or value.startswith("op://") or any(ch.isspace() for ch in value):
        return ""
    return value


def _env_file_values() -> dict[str, str]:
    """The key lines of Hermes's root ``.env``, read-only, cached until the file changes."""
    global _env_cache
    path = bot_graph._root_hermes_home() / ".env"
    try:
        stat = path.stat()
    except OSError:
        return {}
    stamp = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
    with _env_lock:
        if _env_cache and _env_cache[0] == stamp:
            return _env_cache[1]
    values: dict[str, str] = {}
    wanted = {name for name, _ in KEY_SOURCES}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$", line)
            if match and match.group(1) in wanted:
                values[match.group(1)] = match.group(2)
    except (OSError, UnicodeDecodeError):
        return {}
    with _env_lock:
        _env_cache = (stamp, values)
    return values


def jev_credentials() -> tuple[JevProvider, str] | None:
    """The provider and key to ask Jev with, or None when no key is set.

    The ``.env`` file wins over the process environment, so a key changed with
    ``hermes config set`` works at once, without restarting anything.
    """
    file_values = _env_file_values()
    for name, provider in KEY_SOURCES:
        key = _clean_key(file_values.get(name)) or _clean_key(os.environ.get(name))
        if key:
            return provider or (OPENROUTER if key.startswith("sk-or-") else VERCEL), key
    return None


def jev_model(provider: JevProvider, settings: dict[str, Any]) -> str:
    """The settings' model when it belongs to this provider, else the provider's own Jev."""
    model = str(settings.get("jevModel") or "").strip()
    return model if model and model.startswith(provider.model_prefixes) else provider.default_model


def _zdr_available(now: float) -> bool:
    with _zdr_lock:
        return _zdr_refused_at is None or now - _zdr_refused_at >= ZDR_RETRY_SECONDS


def _note_zdr_refused(now: float) -> None:
    global _zdr_refused_at
    with _zdr_lock:
        _zdr_refused_at = now


def _refused_zdr(exc: BaseException) -> bool:
    """Vercel said no to zero data retention (a plan without it), as opposed to any other error."""
    return isinstance(exc, JevHTTPError) and exc.status in (400, 402, 403) and bool(
        re.search(r"zero.?data.?retention|\bzdr\b", exc.body, re.I)
    )


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
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen

    request = Request(url, data=body, headers=headers, method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https endpoints
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            text = exc.read(2000).decode("utf-8", "replace")
        except Exception:
            text = ""
        finally:
            exc.close()
        raise JevHTTPError(exc.code, text) from None


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _probabilities(raw: object) -> dict[str, float]:
    """``{option: probability}`` from either shape: a mapping, or a list of ``{value, probability}``."""
    out: dict[str, float] = {}
    if isinstance(raw, dict):
        items = raw.items()
    elif isinstance(raw, list):
        items = ((entry.get("value"), entry.get("probability")) for entry in raw if isinstance(entry, dict))
    else:
        return out
    for key, value in items:
        number = _number(value)
        if key is not None and number is not None:
            out[str(key)] = number
    return out


def ask_jev(
    message: str,
    *,
    bot: str,
    options: dict[str, str],
    key: str,
    model: str,
    provider: JevProvider = VERCEL,
    zdr: bool = False,
    session_id: str = "",
    previous: tuple[float, str, str] | None = None,
    post: Poster | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """One Jev decision: ``{"choice", "confidence", "probabilities", "cost"}``. Raises on failure."""
    now = time.time() if now is None else now
    body: dict[str, Any] = {
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
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if provider is OPENROUTER:
        if session_id:
            body["session_id"] = session_id[:256]
        headers["X-Title"] = "Hermes phone app router"
    elif zdr:
        # Only providers that keep nothing may answer (TypeSafe is one of them on Vercel).
        body["providerOptions"] = {"gateway": {"zeroDataRetention": True}}
    response = (post or _post_json)(provider.endpoint, headers, json.dumps(body).encode("utf-8"), JEV_TIMEOUT_SECONDS)
    response = response if isinstance(response, dict) else {}
    answers = response.get("answers")
    if isinstance(answers, list):  # the OpenAI-style shape answers in a list, by name
        answers = {entry.get("name"): entry for entry in answers if isinstance(entry, dict)}
    answer = (answers or {}).get("route") if isinstance(answers, dict) else None
    answer = answer if isinstance(answer, dict) else {}
    choice = answer.get("choice")
    if not isinstance(choice, str) or (choice != SELF and choice not in options):
        raise ValueError("Jev returned no usable choice")
    probabilities = _probabilities(answer.get("probabilities"))
    # Vercel's answer may carry only the probabilities: the chosen option's is how sure Jev was.
    confidence = _number(answer.get("confidence"))
    if confidence is None:
        confidence = probabilities.get(choice, 0.0)
    gateway = ((response.get("providerMetadata") or response.get("provider_metadata") or {}).get("gateway")) or {}
    cost = _number((response.get("usage") or {}).get("cost"))
    if cost is None and isinstance(gateway, dict):
        cost = _number(gateway.get("cost"))
    return {
        "choice": choice,
        "confidence": max(0.0, min(1.0, confidence)),
        "probabilities": probabilities,
        "cost": cost,
        "zdrApplied": _zdr_applied(gateway),
    }


def _zdr_applied(gateway: object) -> bool | None:
    """Whether Vercel says it routed with zero data retention: its routing notes start "ZDR
    requested" when it did. A team whose plan lacks it can send the flag without it applying, so
    asking is not proof. None when the answer carries no routing notes."""
    routing = gateway.get("routing") if isinstance(gateway, dict) else None
    notes = routing.get("planningReasoning") if isinstance(routing, dict) else None
    if not isinstance(notes, str) or not notes.strip():
        return None
    return bool(re.search(r"\bZDR\b|zero.?data.?retention", notes, re.I))


def _short_error(exc: BaseException, provider: JevProvider = VERCEL) -> str:
    """Why Jev did not answer, in a few words for the router and the app."""
    label = provider.label
    status = exc.status if isinstance(exc, JevHTTPError) else getattr(exc, "code", None)
    body = exc.body if isinstance(exc, JevHTTPError) else ""
    if isinstance(status, int):
        # Vercel serves no request, free credit included, until the team has a card on file.
        if re.search(r"customer.?verification|credit card on file|add a card", body, re.I):
            return f"{label} needs a card on file"
        # Before the credits check: Vercel's free tier answer asks to "upgrade to paid credits".
        if re.search(r"free.?tier", body, re.I):
            return f"Jev is not in {label}'s free tier"
        if status == 402 or (status in (400, 403) and re.search(r"credit|insufficient|balance|funds|top.?up", body, re.I)):
            return f"{label} is out of credits"
        if re.search(r"no.?providers?.?available", body, re.I):
            return f"{label} has no Jev provider for this account"
        if status in (401, 403):
            return f"{label} refused the key"
        if status == 429:
            return f"{label} is rate limiting"
        return f"{label} answered {status}"
    if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower():
        return "Jev took too long"
    if isinstance(exc, ValueError):  # an answer that is not JSON, or names no option
        return "Jev gave no usable answer"
    return "Jev could not be reached"


def team_of(bot: str, graph: dict[str, Any] | None, options: dict[str, str]) -> dict[str, str]:
    """The bots that report to ``bot`` on the team map and that the router can hand work to."""
    nodes = (graph or {}).get("nodes") or {}
    return {
        name: options[name]
        for name, node in sorted(nodes.items())
        if isinstance(node, dict) and node.get("reportsTo") == bot and name in options and name != bot
    }


def decide(
    message: str,
    *,
    bot: str,
    settings: dict[str, Any],
    graph: dict[str, Any] | None,
    routes: dict[str, str] | None,
    session_id: str = "",
    key: str | None = None,
    provider: JevProvider = VERCEL,
    post: Poster | None = None,
    now: float | None = None,
    previous: tuple[float, str, str] | None = None,
) -> dict[str, Any]:
    """Who takes this message. ``source`` is "jev" when Jev's pick stands, else "router".

    ``previous`` is the message before this one in the chat, ``(time, text, where it went)``; when
    not given, the one this process routed last for the session."""
    now = time.time() if now is None else now
    options = candidates(bot, graph, routes)
    if previous is None and session_id:
        with _previous_lock:
            previous = _previous.get(session_id)
    decision: dict[str, Any] = {
        "route": None,
        "confidence": None,
        "guess": None,
        "source": "router",
        "reason": "",
        "options": options,
        "team": {},
        "cost": None,
        "ms": None,
        "provider": None,
        "zdr": None,
    }
    if not options:
        decision.update(route=SELF, reason="no other bot to hand work to")
    elif not key:
        decision["reason"] = "no Jev key on the Mac"
    else:
        started = time.monotonic()
        zdr = provider is VERCEL and _zdr_available(now)
        decision["provider"] = provider.name

        def ask(with_zdr: bool) -> dict[str, Any]:
            return ask_jev(
                message,
                bot=bot,
                options=options,
                key=key,
                model=jev_model(provider, settings),
                provider=provider,
                zdr=with_zdr,
                session_id=session_id,
                previous=previous,
                post=post,
                now=now,
            )

        try:
            try:
                answer = ask(zdr)
            except Exception as exc:
                if not (zdr and _refused_zdr(exc)):
                    raise
                # A Vercel plan without zero data retention: ask without it, and stop asking for it a while.
                _note_zdr_refused(now)
                zdr = False
                answer = ask(False)
        except Exception as exc:  # network, HTTP or a malformed answer: the router decides
            logger.debug("Hermes PWA router: Jev failed: %s", exc)
            decision["reason"] = _short_error(exc, provider)
            close = getattr(exc, "close", None)  # an HTTPError holds the response open
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        else:
            if provider is VERCEL:
                # Asked for it and Vercel's routing notes say so: on. Not asked: off. Asked, and
                # the answer does not say: unknown, so the app claims nothing.
                decision["zdr"] = answer.get("zdrApplied") if zdr else False
            decision.update(cost=answer["cost"], confidence=answer["confidence"])
            if answer["confidence"] >= float(settings.get("minConfidence") or DEFAULT_MIN_CONFIDENCE):
                decision.update(route=answer["choice"], source="jev")
                if answer["choice"] != SELF:
                    decision["team"] = team_of(answer["choice"], graph, options)
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


def _roster(bots: dict[str, str]) -> str:
    """``Gmail Connector (@gmail-connector): reads email; ...`` without doubled stops."""
    return "; ".join(f"{_who(name)}: {description.rstrip(' .;')}" for name, description in bots.items())


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
        picked = f"{head} Jev picked {_who(route)} for this ({_percent(decision.get('confidence'))} sure)"
        team: dict[str, str] = decision.get("team") or {}
        if team and not orchestration:
            # Hermes lets only the top of a delegation hand work on (delegation.max_spawn_depth 1), so a
            # bot that runs a team would get the job without being able to use its team.
            label = bot_graph.bot_label(route)
            roster = _roster(team)
            return (
                f"{picked}: a job for {label}'s team. Bots you hand work to cannot hand it on from here, so do "
                f"{label}'s part yourself: give each piece to the bot whose job covers it with delegate_task, one task "
                "per bot and all in one call so they work side by side, each goal with Sean's own words and everything "
                f"that bot needs. Then put their answers together for Sean in a few lines. {label}'s team: {roster}."
            )
        return (
            f"{picked}. Hand it over with delegate_task, profile \"{route}\". Put everything it needs in the goal: "
            "Sean's message in his own words, the names, dates and details he gave, and what to send back. The bot "
            "does not see this chat, so when this follows up something earlier, put that in the goal too. When it "
            "finishes, give Sean the result in a few lines."
        )
    roster = _roster(options)
    if decision.get("guess"):
        why = f"Jev was not sure who should take this (best guess {_who(decision['guess'])}, {_percent(decision.get('confidence'))})."
    else:
        why = f"Jev did not decide this time ({decision.get('reason') or 'unavailable'})."
    flat = (
        "" if orchestration else
        " Bots you hand work to cannot hand it on from here, so for a job that spans several bots give each its piece "
        "yourself, all in one call."
    )
    return (
        f"{head} {why} Decide yourself: answer quick things directly; hand real work to the bot whose job "
        f"covers it with delegate_task and its profile name.{flat} Your team: {roster}."
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
        "provider": decision.get("provider"),
        "zdr": decision.get("zdr"),
        "split": bool(decision.get("split")),
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
_TEXT_PARTS = (None, "text", "input_text")


def message_text(raw: object) -> str:
    """The words of a user message. Hermes passes a string, or a list of parts for a message with
    pictures or files; only the text parts count, so no image data goes to Jev."""
    if isinstance(raw, str):
        return raw
    words: list[str] = []
    for part in raw if isinstance(raw, list) else [raw]:
        if isinstance(part, str):
            words.append(part)
        elif isinstance(part, dict) and part.get("type") in _TEXT_PARTS and isinstance(part.get("text"), str):
            words.append(part["text"])
    return "\n".join(word for word in words if word.strip())


_NOTE_MARKERS = ("[Router note from Sean's phone app", "[Team map from Sean")


def _without_notes(text: str) -> str:
    """A user message as Sean wrote it, without a note this plugin added to it."""
    cut = min((i for i in (text.find(marker) for marker in _NOTE_MARKERS) if i >= 0), default=-1)
    return (text[:cut] if cut >= 0 else text).strip()


def earlier_message(history: object, current: str) -> str:
    """Sean's message before this one in the chat, from the history Hermes passes the hook."""
    if not isinstance(history, list):
        return ""
    passed_current = False
    for entry in reversed(history):
        if not isinstance(entry, dict) or entry.get("role") != "user":
            continue
        text = _without_notes(message_text(entry.get("content")))
        if not text or _NOTICE_RE.match(text):
            continue
        if not passed_current and text == current:
            passed_current = True  # the history may already hold this turn's message
            continue
        return text
    return ""


def _epoch(iso: object) -> float | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def previous_turn(session_id: str, history: object, current: str) -> tuple[float, str, str] | None:
    """The message before this one and where it went, ``(time, text, route)``, read from the chat
    history and the decision log, so a follow-up routes right after a restart or in a new process."""
    text = earlier_message(history, current)
    logged = recent(session_id=session_id, limit=1) if session_id else []
    if not text or not logged:
        return None
    at = _epoch(logged[0].get("at"))
    if at is None:
        return None
    return at, text, str(logged[0].get("route") or logged[0].get("guess") or "")


def hook_context(
    session_id: str,
    user_message: object,
    *,
    parent_session_id: str = "",
    bot: str | None = None,
    post: Poster | None = None,
    history: object = None,
) -> str | None:
    """The router note for this turn, or None when this bot is not the router or routing is off."""
    if not session_id or parent_session_id:
        return None
    text = message_text(user_message).strip()
    if not text or _NOTICE_RE.match(text):
        return None
    settings = load_settings()
    if not settings.get("enabled"):
        return None
    name = bot or bot_graph._current_bot()
    if not name or name != settings.get("bot"):
        return None
    routes, orchestration = delegation_routes()
    credentials = jev_credentials()
    decision = decide(
        text,
        bot=name,
        settings=settings,
        graph=bot_graph.load(),
        routes=routes,
        session_id=session_id,
        key=credentials[1] if credentials else None,
        provider=credentials[0] if credentials else VERCEL,
        post=post,
        previous=previous_turn(session_id, history, text),
    )
    # The router runs the pick's team itself when bots it hands work to cannot hand it on.
    decision["split"] = bool(decision.get("team")) and not orchestration
    record(decision, bot=name, session_id=session_id, message=text)
    return directive(name, decision, orchestration)


def status() -> dict[str, Any]:
    """What the app shows: the settings, whether Jev can be asked and through which service, and
    which bots run an older copy of this plugin (they miss the team map and the router notes)."""
    credentials = jev_credentials()
    try:
        stale = plugin_copies.stale_bots(bot_graph._root_hermes_home(), Path(__file__).resolve().parent)
    except Exception:  # pragma: no cover - defensive: the status still answers
        stale = []
    return {
        "settings": load_settings(),
        "keyConfigured": credentials is not None,
        "provider": credentials[0].label if credentials else None,
        "keyName": KEY_ENV,
        "staleBots": stale,
        "updateCommand": plugin_copies.update_command(stale),
    }


def forget_previous() -> None:
    """For tests."""
    global _settings_cache, _env_cache, _zdr_refused_at
    with _previous_lock:
        _previous.clear()
    with _settings_lock:
        _settings_cache = None
    with _env_lock:
        _env_cache = None
    with _zdr_lock:
        _zdr_refused_at = None
