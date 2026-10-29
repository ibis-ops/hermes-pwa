from __future__ import annotations

import logging
import os
import queue
import threading
from typing import Any, Callable

from .bot_graph import hook_context as team_map_context
from .pwa_router import hook_context as router_context
from .hub_status import hub_command, hub_context
from .push_common import (
    approval_push_payload,
    claim_push_dedupe,
    clear_pending_approval,
    record_pending_approval,
    send_web_push_to_enabled,
    turn_complete_push_payload,
)

logger = logging.getLogger(__name__)

_PWA_TURN_COMPLETE_PLATFORMS = {"tui", "pwa", "desktop", "web"}
_APPROVAL_PUSH_TTL_SECONDS = 10 * 60
_TURN_COMPLETE_TTL_SECONDS = 6 * 60 * 60
_TURN_COMPLETE_SESSION_COOLDOWN_SECONDS = 90


class _PushWorker:
    """One daemon thread that sends pushes so the hooks return at once.

    A send can wait on the push service for seconds per device, and Hermes
    calls the approval hook on the thread that is waiting for the answer. The
    hook only claims the dedupe key and writes the pending record (both fast,
    both local), then hands the network work here. Daemon, so a slow push
    service never holds up a gateway restart; started lazily so a process that
    forks after import gets its own thread.
    """

    def __init__(self) -> None:
        self._jobs: "queue.SimpleQueue[Callable[[], None]]" = queue.SimpleQueue()
        self._state = threading.Condition()
        self._pending = 0
        self._thread: threading.Thread | None = None

    def submit(self, job: Callable[[], None]) -> None:
        with self._state:
            self._pending += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="hermes-pwa-push", daemon=True)
                self._thread.start()
        self._jobs.put(job)

    def _run(self) -> None:
        while True:
            job = self._jobs.get()
            try:
                job()
            except Exception as exc:  # pragma: no cover - defensive: a failed push is logged, never raised
                logger.debug("Hermes PWA push worker ignored error: %s", exc)
            finally:
                with self._state:
                    self._pending -= 1
                    self._state.notify_all()

    def flush(self, timeout: float = 10.0) -> bool:
        """Wait until every submitted job has run; True when the queue drained in time."""
        with self._state:
            return self._state.wait_for(lambda: self._pending == 0, timeout=timeout)


_push_worker = _PushWorker()


def _send_in_background(payload: dict[str, Any], profile: str, kind: str) -> None:
    def job() -> None:
        try:
            sent = send_web_push_to_enabled(payload, profile=profile)
        except Exception as exc:
            logger.debug("Hermes PWA %s push not sent: %s", kind, exc)
            return
        logger.debug(
            "Hermes PWA %s push sent: tag=%s profile=%s devices=%s",
            kind,
            payload.get("tag"),
            payload.get("profile"),
            sent,
        )

    _push_worker.submit(job)


def _approval_surface(kwargs: dict[str, Any]) -> str:
    return str(kwargs.get("surface") or "gateway").strip().lower()


def _is_gateway_approval(kwargs: dict[str, Any]) -> bool:
    """Only gateway approvals can be answered by PWA approval.respond.

    Hermes also fires approval hooks for local CLI prompts. Those observer
    events are not backed by the gateway approval queue, so surfacing them in
    the mobile PWA creates stale cards that return 4009 "no pending approval".
    """
    return _approval_surface(kwargs) == "gateway"


def _notification_profile(kwargs: dict[str, Any]) -> str:
    value = kwargs.get("profile") or os.environ.get("HERMES_PROFILE") or "default"
    return str(value or "default")


def _approval_session_key(kwargs: dict[str, Any]) -> str:
    return str(kwargs.get("session_key") or kwargs.get("session_id") or "")


def _approval_platform(kwargs: dict[str, Any]) -> str:
    explicit = str(kwargs.get("platform") or kwargs.get("source") or kwargs.get("channel") or "").strip().lower()
    if explicit:
        return explicit
    session_key = _approval_session_key(kwargs).lower()
    if session_key.startswith("telegram:") or ":telegram:" in session_key or "telegram" in session_key.split(":"):
        return "telegram"
    return ""


def _should_surface_pwa_approval(kwargs: dict[str, Any]) -> bool:
    """Return True when the approval should be visible/recoverable in PWA.

    Telegram-origin approvals already have a native Telegram approval surface.
    Mirroring them into the mobile PWA creates duplicate push/card noise and can
    leave stale PWA cards for a request that was meant to be handled in Telegram.
    """
    return _approval_platform(kwargs) != "telegram"


def _on_pre_approval_request(**kwargs: Any) -> None:
    """Observe Hermes approval requests.

    Claims the dedupe key and writes the pending record synchronously (the
    phone may open the card before the push lands), then sends the push from
    the background worker. This hook must never block or break approval flow.
    """
    try:
        if not _is_gateway_approval(kwargs):
            logger.debug(
                "Hermes PWA approval hook ignored non-gateway surface: %s",
                _approval_surface(kwargs),
            )
            return
        if not _should_surface_pwa_approval(kwargs):
            logger.debug(
                "Hermes PWA approval hook ignored Telegram-origin approval: session=%s",
                _approval_session_key(kwargs),
            )
            return
        profile = _notification_profile(kwargs)
        kwargs = {**kwargs, "profile": profile}
        payload = approval_push_payload(**kwargs)
        dedupe_key = str(payload.get("tag") or "")
        if not claim_push_dedupe(dedupe_key, ttl_seconds=_APPROVAL_PUSH_TTL_SECONDS):
            logger.debug(
                "Hermes PWA approval push deduped: key=%s profile=%s",
                dedupe_key,
                profile,
            )
            return
        record_pending_approval(**kwargs)
        _send_in_background(payload, profile, "approval")
    except Exception as exc:  # pragma: no cover - defensive observer hook
        logger.debug("Hermes PWA approval hook ignored error: %s", exc)


def _on_post_approval_response(**kwargs: Any) -> None:
    """Remove approval recovery records once Hermes has a decision/timeout."""
    try:
        if not _is_gateway_approval(kwargs):
            return
        clear_pending_approval(**kwargs)
    except Exception as exc:  # pragma: no cover - defensive observer hook
        logger.debug("Hermes PWA approval clear hook ignored error: %s", exc)


def _on_post_llm_call(**kwargs: Any) -> None:
    """Send one low-noise answer-ready push after PWA/TUI turns complete."""
    try:
        platform = str(kwargs.get("platform") or "").lower()
        if platform not in _PWA_TURN_COMPLETE_PLATFORMS:
            return
        if not str(kwargs.get("assistant_response") or "").strip():
            return
        profile = _notification_profile(kwargs)
        payload = turn_complete_push_payload(**{**kwargs, "profile": profile})
        dedupe_key = str(payload.get("dedupe_key") or "")
        if not claim_push_dedupe(dedupe_key, ttl_seconds=_TURN_COMPLETE_TTL_SECONDS):
            return
        session_cooldown_key = ":".join(
            part for part in ("turn-session", profile, str(payload.get("tag") or "")) if part
        )
        if not claim_push_dedupe(
            session_cooldown_key,
            ttl_seconds=_TURN_COMPLETE_SESSION_COOLDOWN_SECONDS,
        ):
            logger.debug(
                "Hermes PWA turn-complete push suppressed by session cooldown: tag=%s profile=%s",
                payload.get("tag"),
                profile,
            )
            return
        _send_in_background(payload, profile, "turn-complete")
    except Exception as exc:  # pragma: no cover - defensive observer hook
        logger.debug("Hermes PWA turn-complete hook ignored error: %s", exc)


def _on_pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
    """Tell a bot its place on Sean's team map (once per chat, and again after the map changes),
    and tell the router bot who Jev picked to take this message."""
    session_id = str(kwargs.get("session_id") or "")
    parent_session_id = str(kwargs.get("parent_session_id") or "")
    parts: list[str] = []
    try:
        team = team_map_context(session_id, parent_session_id=parent_session_id)
        if team:
            parts.append(team)
    except Exception as exc:  # pragma: no cover - defensive: the turn goes ahead without the map
        logger.debug("Hermes PWA team map hook ignored error: %s", exc)
    try:
        # As Hermes passed it: a string, or a list of parts when pictures came with it. The history
        # gives a follow-up the message before it, even after a restart.
        route = router_context(
            session_id,
            kwargs.get("user_message"),
            parent_session_id=parent_session_id,
            history=kwargs.get("conversation_history"),
        )
        if route:
            parts.append(route)
    except Exception as exc:  # pragma: no cover - defensive: the router decides for itself
        logger.debug("Hermes PWA router hook ignored error: %s", exc)
    try:
        hub = hub_context(session_id, kwargs.get("user_message"), parent_session_id=parent_session_id)
        if hub:
            parts.append(hub)
    except Exception as exc:  # pragma: no cover - defensive: the bot reads the Hub itself
        logger.debug("Hermes PWA Claude Hub hook ignored error: %s", exc)
    return {"context": "\n\n".join(parts)} if parts else None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_approval_request", _on_pre_approval_request)
    ctx.register_hook("post_approval_response", _on_post_approval_response)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    # /hub: what every running Claude Code chat is doing, straight from Claude Hub, with no model call.
    if hasattr(ctx, "register_command"):
        try:
            ctx.register_command("hub", hub_command, args_hint="[all | chat <id> | search <text>]",
                                 description="Claude Hub now: what each running Claude Code chat is doing (instant, no model)")
        except Exception as exc:  # pragma: no cover - defensive: the rest of the plugin must load regardless
            logger.warning("Hermes PWA /hub command not registered: %s", exc)
    # The Chrome connector's tools; each one shows only in a profile with <HERMES_HOME>/chrome/connector.json.
    if hasattr(ctx, "register_tool"):
        try:
            from .chrome_connector import register_tools as register_chrome_tools

            register_chrome_tools(ctx)
        except Exception as exc:  # pragma: no cover - defensive: the rest of the plugin must load regardless
            logger.warning("Hermes PWA Chrome connector tools not registered: %s", exc)
