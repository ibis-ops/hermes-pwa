from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]+")
_SECRET_LIKE = re.compile(
    r"(?i)(api[_-]?key|token|secret|password|passwd|authorization|bearer)\s*[:=]\s*\S+"
)
_URL_LIKE = re.compile(r"https?://\S+")
_BARE_SECRET_LIKE = re.compile(r"(?<![A-Za-z0-9_-])(?:[a-fA-F0-9]{32,}|[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-])")


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser().resolve()


def plugin_state_dir() -> Path:
    return hermes_home() / "plugins" / "hermes-pwa"


def push_subscriptions_path() -> Path:
    return plugin_state_dir() / "push_subscriptions.json"


def pending_approvals_path() -> Path:
    return plugin_state_dir() / "pending_approvals.json"


def endpoint_hash(endpoint: str) -> str:
    return "sha256:" + hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


def now_ts() -> float:
    return time.time()


def _read_json_list(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _write_json_list(path: Path, records: list[dict[str, Any]]) -> None:
    """Atomic write, owner-only permissions: these files hold push keys and command text."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(records, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_push_subscriptions(path: Path | None = None) -> list[dict[str, Any]]:
    return _read_json_list(path or push_subscriptions_path())


def save_push_subscriptions(records: list[dict[str, Any]], path: Path | None = None) -> None:
    _write_json_list(path or push_subscriptions_path(), records)


MAX_PUSH_SUBSCRIPTIONS_PER_PROFILE = 10
PUSH_SEND_TIMEOUT_SECONDS = 8

# Browser push services. A subscription endpoint anywhere else is not a browser
# subscription; refusing it keeps the sender from being pointed at loopback or
# tailnet services (blind SSRF) or at a black hole that would stall the hooks.
_PUSH_ENDPOINT_HOST_SUFFIXES = (
    ".push.apple.com",
    ".notify.windows.com",
    ".push.services.mozilla.com",
    ".googleapis.com",
    ".google.com",
)


def _endpoint_allowed(endpoint: str) -> bool:
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(endpoint)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host:
        return False
    if os.environ.get("HERMES_PWA_PUSH_ALLOW_ANY_ENDPOINT") == "1":
        return True
    return any(host == suffix[1:] or host.endswith(suffix) for suffix in _PUSH_ENDPOINT_HOST_SUFFIXES)


def validate_browser_subscription(subscription: Any) -> dict[str, Any]:
    if not isinstance(subscription, dict):
        raise ValueError("subscription must be an object")
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys")
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise ValueError("subscription.endpoint is required")
    if not _endpoint_allowed(endpoint.strip()):
        raise ValueError("subscription.endpoint must be an https URL on a browser push service")
    if not isinstance(keys, dict):
        raise ValueError("subscription.keys is required")
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not isinstance(p256dh, str) or not p256dh.strip():
        raise ValueError("subscription.keys.p256dh is required")
    if not isinstance(auth, str) or not auth.strip():
        raise ValueError("subscription.keys.auth is required")
    return {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}


def safe_subscription_record(record: dict[str, Any]) -> dict[str, Any]:
    """Return the API/log-safe shape. Never include endpoint or key material."""
    safe: dict[str, Any] = {
        "id": str(record.get("id") or endpoint_hash(str(record.get("endpoint", "")))),
        "enabled": bool(record.get("enabled", True)),
    }
    for key in ("profile", "label", "user_agent_hint", "created_at", "updated_at", "last_success_at", "last_error"):
        value = record.get(key)
        if value is not None:
            safe[key] = sanitize_error_text(value) if key == "last_error" else value
    return safe


def upsert_push_subscription(
    subscription: Any,
    *,
    profile: str = "default",
    label: str | None = None,
    user_agent_hint: str | None = None,
    path: Path | None = None,
) -> dict[str, Any]:
    valid = validate_browser_subscription(subscription)
    records = load_push_subscriptions(path)
    sub_id = endpoint_hash(valid["endpoint"])
    ts = now_ts()
    normalized_profile = (profile or "default").strip() or "default"
    updated: dict[str, Any] | None = None
    for record in records:
        if record.get("id") == sub_id or record.get("endpoint") == valid["endpoint"]:
            record.update(valid)
            record.update(
                {
                    "id": sub_id,
                    "profile": normalized_profile,
                    "enabled": True,
                    "updated_at": ts,
                }
            )
            if label is not None:
                record["label"] = str(label)[:80]
            if user_agent_hint is not None:
                record["user_agent_hint"] = str(user_agent_hint)[:160]
            updated = record
            break
    if updated is None:
        updated = {
            "id": sub_id,
            **valid,
            "profile": normalized_profile,
            "label": str(label)[:80] if label else None,
            "user_agent_hint": str(user_agent_hint)[:160] if user_agent_hint else None,
            "enabled": True,
            "created_at": ts,
            "updated_at": ts,
            "last_success_at": None,
            "last_error": None,
        }
        records.append(updated)
    # Cap devices per profile: keep the newest, drop the oldest beyond the limit.
    same_profile = [r for r in records if _normalized_profile(r.get("profile")) == _normalized_profile(normalized_profile)]
    if len(same_profile) > MAX_PUSH_SUBSCRIPTIONS_PER_PROFILE:
        same_profile.sort(key=lambda r: float(r.get("updated_at") or r.get("created_at") or 0))
        drop_ids = {r.get("id") for r in same_profile[: len(same_profile) - MAX_PUSH_SUBSCRIPTIONS_PER_PROFILE]}
        records = [r for r in records if r.get("id") not in drop_ids]
    save_push_subscriptions(records, path)
    return safe_subscription_record(updated)


def sanitize_notification_text(value: Any, *, limit: int) -> str:
    text = "" if value is None else str(value)
    text = _CONTROL_CHARS.sub(" ", text)
    text = _SECRET_LIKE.sub("[redacted]", text)
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def sanitize_error_text(value: Any, *, limit: int = 240) -> str:
    """Return API/log-safe push error text without endpoint or key material."""
    text = "" if value is None else str(value)
    text = _CONTROL_CHARS.sub(" ", text)
    text = _URL_LIKE.sub("[redacted-url]", text)
    text = _SECRET_LIKE.sub("[redacted]", text)
    text = _BARE_SECRET_LIKE.sub("[redacted]", text)
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _normalized_profile(value: Any) -> str:
    text = str(value or "default").strip()
    return text or "default"


def _exception_status_code(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int):
        return status
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    return None


def _approval_record_id(session_key: str, command: str, description: str, pattern_key: str) -> str:
    seed = json.dumps(
        {
            "session_key": session_key,
            "command": command,
            "description": description,
            "pattern_key": pattern_key,
        },
        sort_keys=True,
    )
    return "approval:" + endpoint_hash(seed).split(":", 1)[1][:24]


def _pending_approval_match(record: dict[str, Any], *, session_key: str, command: str, pattern_key: str) -> bool:
    if str(record.get("session_id") or "") != session_key:
        return False
    if command and str(record.get("command") or "") != command:
        return False
    if pattern_key and str(record.get("pattern_key") or "") != pattern_key:
        return False
    return True


def load_pending_approvals(*, profile: str | None = None, max_age_seconds: int = 330, path: Path | None = None) -> list[dict[str, Any]]:
    target = path or pending_approvals_path()
    records = _read_json_list(target)
    cutoff = now_ts() - max(60, int(max_age_seconds))
    normalized_profile = sanitize_notification_text(profile or "", limit=80)
    active: list[dict[str, Any]] = []
    kept: list[dict[str, Any]] = []
    changed = False
    for record in records:
        created_at = record.get("created_at")
        if not isinstance(created_at, (int, float)) or float(created_at) < cutoff:
            changed = True
            continue
        kept.append(record)
        if normalized_profile and str(record.get("profile") or "default") != normalized_profile:
            continue
        active.append(record)
    if changed:
        _write_json_list(target, kept)
    active.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)
    return active


def approval_command_text(value: Any, *, limit: int = 20_000) -> str:
    """The command exactly as it will run, for the approval card.

    No secret redaction and no short cap here: the person approving must see the
    whole thing. Only NUL and other non-printing control characters are dropped
    (newlines and tabs stay). The push payload never carries the command.
    """
    text = "" if value is None else str(value)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def record_pending_approval(**kwargs: Any) -> dict[str, Any]:
    session_key = sanitize_notification_text(kwargs.get("session_key") or "global", limit=120)
    command = approval_command_text(kwargs.get("command") or "")
    # `summary` is the redacted, one-line form for lists and notifications;
    # `command` is the full text the card shows before anyone taps Approve.
    short_command = sanitize_notification_text(command, limit=600)
    description = sanitize_notification_text(kwargs.get("description") or "Security approval required", limit=240)
    pattern_key = sanitize_notification_text(kwargs.get("pattern_key") or "", limit=120)
    profile = sanitize_notification_text(kwargs.get("profile") or "default", limit=80)
    record: dict[str, Any] = {
        "id": _approval_record_id(session_key, command, description, pattern_key),
        "kind": "approval",
        "status": "needs_you",
        "title": "Approval required",
        "summary": "\n".join(part for part in (short_command, description) if part),
        "session_id": session_key,
        "session": f"Session {session_key[:8]}",
        "command": command,
        "command_complete": not command.endswith("…"),
        "description": description,
        "pattern_key": pattern_key,
        "high_impact": True,
        "visibility": "private",
        "profile": profile,
        "created_at": now_ts(),
    }
    path = pending_approvals_path()
    records = [
        item
        for item in load_pending_approvals(path=path)
        if str(item.get("id") or "") != record["id"]
    ]
    records.append(record)
    _write_json_list(path, records)
    return record


def clear_pending_approval(**kwargs: Any) -> int:
    session_key = sanitize_notification_text(kwargs.get("session_key") or "global", limit=120)
    command = approval_command_text(kwargs.get("command") or "")
    pattern_key = sanitize_notification_text(kwargs.get("pattern_key") or "", limit=120)
    path = pending_approvals_path()
    records = _read_json_list(path)
    kept = [
        record
        for record in records
        if not _pending_approval_match(record, session_key=session_key, command=command, pattern_key=pattern_key)
    ]
    removed = len(records) - len(kept)
    if removed:
        _write_json_list(path, kept)
    return removed


def approval_push_payload(**kwargs: Any) -> dict[str, Any]:
    description = kwargs.get("description") or "Security approval required"
    session_key = sanitize_notification_text(kwargs.get("session_key") or "global", limit=80)
    command = sanitize_notification_text(kwargs.get("command") or "", limit=600)
    pattern_key = sanitize_notification_text(kwargs.get("pattern_key") or "", limit=120)
    turn_id = sanitize_notification_text(kwargs.get("turn_id") or "", limit=80)
    tool_call_id = sanitize_notification_text(kwargs.get("tool_call_id") or "", limit=80)
    fallback = endpoint_hash(json.dumps({
        "session_key": session_key,
        "description": description,
        "pattern_keys": kwargs.get("pattern_keys") or [],
    }, sort_keys=True))[:24]
    dedupe = ":".join(part for part in ("approval", session_key, turn_id, tool_call_id or fallback) if part)
    return {
        "type": "approval.request",
        "title": "Hermes needs approval",
        "body": sanitize_notification_text(f"Security approval required: {description}", limit=180),
        "tag": dedupe,
        "url": "./index.html#/approvals",
        "profile": sanitize_notification_text(kwargs.get("profile") or "default", limit=80),
        "approval_id": _approval_record_id(session_key, command, sanitize_notification_text(description, limit=240), pattern_key),
        "session_id": session_key,
    }


def turn_complete_push_payload(**kwargs: Any) -> dict[str, Any]:
    """Safe, low-noise notification for a completed PWA/TUI turn.

    The visible notification intentionally does not include the assistant answer:
    answers can contain private text and long markdown. A stable per-session tag
    lets the OS replace older "answer ready" notifications instead of stacking
    one banner per queued turn.
    """
    session_id = sanitize_notification_text(kwargs.get("session_id") or "session", limit=80)
    turn_id = sanitize_notification_text(kwargs.get("turn_id") or "", limit=80)
    dedupe_seed = turn_id or endpoint_hash(json.dumps({
        "session_id": session_id,
        "assistant_response": sanitize_notification_text(kwargs.get("assistant_response") or "", limit=240),
    }, sort_keys=True))[:24]
    return {
        "type": "turn.complete",
        "title": "Hermes replied",
        "body": "Answer ready.",
        "tag": f"hermes-turn:{session_id}",
        "dedupe_key": ":".join(part for part in ("turn", session_id, dedupe_seed) if part),
        "url": "./index.html#/chat",
        "profile": sanitize_notification_text(kwargs.get("profile") or "default", limit=80),
    }


def push_delivery_state_path() -> Path:
    return plugin_state_dir() / "push_delivery_state.json"


def _load_delivery_state(path: Path | None = None) -> dict[str, Any]:
    target = path or push_delivery_state_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def _save_delivery_state(state: dict[str, Any], path: Path | None = None) -> None:
    target = path or push_delivery_state_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(state, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, target)


def claim_push_dedupe(key: str, *, ttl_seconds: int = 21600, path: Path | None = None) -> bool:
    """Return True once per dedupe key within ttl_seconds.

    This protects against duplicate hook delivery/retries. It does not throttle
    different turns; visible no-spam behavior is handled by a stable notification
    tag in the payload so the OS replaces the previous answer-ready banner.
    """
    normalized = sanitize_notification_text(key, limit=240)
    if not normalized:
        return False
    ts = now_ts()
    cutoff = ts - max(60, int(ttl_seconds))
    state = _load_delivery_state(path)
    raw_sent = state.get("sent")
    sent_source = raw_sent if isinstance(raw_sent, dict) else {}
    sent = {str(k): float(v) for k, v in sent_source.items() if isinstance(v, (int, float)) and float(v) >= cutoff}
    if normalized in sent:
        if sent != sent_source:
            state["sent"] = sent
            _save_delivery_state(state, path)
        return False
    sent[normalized] = ts
    state["sent"] = sent
    _save_delivery_state(state, path)
    return True


def push_sender_availability() -> tuple[bool, str | None]:
    try:
        import pywebpush  # type: ignore[import-not-found]  # noqa: F401
    except Exception:
        return False, "pywebpush is not installed on this server"
    if not os.environ.get("HERMES_PWA_VAPID_PRIVATE_KEY"):
        return False, "HERMES_PWA_VAPID_PRIVATE_KEY is missing from .env"
    if not os.environ.get("HERMES_PWA_VAPID_PUBLIC_KEY"):
        return False, "HERMES_PWA_VAPID_PUBLIC_KEY is missing from .env"
    return True, None


def vapid_subject() -> str:
    return os.environ.get("HERMES_PWA_VAPID_SUBJECT") or "mailto:admin@example.com"


def send_web_push_record(record: dict[str, Any], payload: dict[str, Any]) -> None:
    from pywebpush import webpush  # type: ignore[import-not-found]

    endpoint = record.get("endpoint")
    keys = record.get("keys")
    if not isinstance(endpoint, str) or not isinstance(keys, dict):
        raise RuntimeError("stored subscription is incomplete")
    webpush(
        subscription_info={"endpoint": endpoint, "keys": keys},
        data=json.dumps(payload),
        vapid_private_key=os.environ["HERMES_PWA_VAPID_PRIVATE_KEY"].replace("\\n", "\n"),
        vapid_claims={"sub": vapid_subject()},
        timeout=PUSH_SEND_TIMEOUT_SECONDS,
    )


def send_web_push_to_enabled(payload: dict[str, Any], *, profile: str | None = None, fallback_to_any: bool = True) -> int:
    """Push to the devices subscribed for ``profile``.

    Subscriptions are per profile because the phone registers under the profile
    it was chatting with. A bot (another profile) that finishes a turn usually
    has no subscription of its own, so when the exact profile has none the
    payload goes to every enabled device instead: the person asked to hear
    when work is done, whichever bot did it. Duplicate endpoints (one phone
    subscribed under several profiles) are sent once.
    """
    available, reason = push_sender_availability()
    if not available:
        raise RuntimeError(reason or "push unavailable")
    records = load_push_subscriptions()
    target_profile = _normalized_profile(profile)
    enabled = [record for record in records if record.get("enabled", True)]
    exact = [record for record in enabled if _normalized_profile(record.get("profile")) == target_profile]
    targets = exact if exact or not fallback_to_any else enabled
    sent = 0
    changed = False
    seen_recipients: set[str] = set()
    for record in targets:
        endpoint = str(record.get("endpoint") or "")
        recipient_key = endpoint_hash(endpoint) if endpoint else str(record.get("id") or "")
        if recipient_key and recipient_key in seen_recipients:
            continue
        if recipient_key:
            seen_recipients.add(recipient_key)
        try:
            send_web_push_record(record, payload)
            record["last_success_at"] = now_ts()
            record["last_error"] = None
            sent += 1
            changed = True
        except Exception as exc:
            status_code = _exception_status_code(exc)
            if status_code in {404, 410}:
                record["enabled"] = False
            record["last_error"] = sanitize_error_text(exc)
            changed = True
    if changed:
        save_push_subscriptions(records)
    return sent
