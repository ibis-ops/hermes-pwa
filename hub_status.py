"""Claude Hub status in the phone app, fast.

``/hub`` answers at once with what every running Claude Code chat is doing, straight from Claude Hub and with no model
call. ``/hub all``, ``/hub chat <id> [n]`` and ``/hub search <text>`` read deeper; ``/hub <words>`` searches.

A Claude Hub question typed to the router or the Claude bot gets the same digest added to the message, so the bot
answers in one model call instead of calling a tool first and then answering (about 9 s became the goal of 3 to 5 s).
Questions that ask a bot to send or save something are left alone: Hub writes keep their ask-first path.

Reads through hubq.py, the Claude bot's claude-hub-reader skill. Read only.
"""
from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

HUBQ = Path.home() / ".hermes" / "profiles" / "claude-cowork-driver" / "skills" / "claude-hub-reader" / "scripts" / "hubq.py"
PYTHON = "/usr/bin/python3"
HUB_BOTS = frozenset({"router", "claude-cowork-driver"})
SUBCOMMANDS = frozenset({"now", "chat", "search", "bots", "accounts", "schedule", "brief"})

_HUB_QUESTION = re.compile(
    r"\bclaude[\s-]*hub\b"
    r"|\bhub\b.*\b(running|working|doing|status|chats?|sessions?|busy|up to)\b"
    r"|\b(running|working|doing|status)\b.*\bhub\b"
    r"|\bclaude code\b.*\b(running|working|doing|chats?|sessions?|status)\b",
    re.I | re.S)
_WRITE_WORDS = re.compile(r"\b(tell|send|message|say|save|remember|write|post|reply|type)\b", re.I)


def _run(args: list[str], timeout: float = 10.0) -> str:
    try:
        r = subprocess.run([PYTHON, "-I", str(HUBQ), *args], capture_output=True, text=True, timeout=timeout)
        return (r.stdout or r.stderr or "").strip() or "Claude Hub returned nothing."
    except Exception as exc:  # the command must answer even when the Hub cannot be read
        return "Claude Hub could not be read (%s)." % exc.__class__.__name__


def hub_command(raw_args: str = "") -> str:
    """``/hub`` handler: the brief view, or a deeper read when arguments name one."""
    args = (raw_args or "").split()
    if not args:
        return _run(["brief"])
    first = args[0].lower()
    if first == "all":
        return _run(["now", "--all"])
    if first in SUBCOMMANDS:
        return _run([first, *args[1:]])
    return _run(["search", *args])


def _message_text(message: Any) -> str:
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        return " ".join(str(p.get("text", "")) for p in message if isinstance(p, dict))
    return ""


def is_hub_question(message: Any) -> bool:
    """A short question about what Claude Hub or its Claude Code chats are doing, and not a request to write."""
    text = _message_text(message).strip()
    if not text or len(text) > 400:
        return False
    return bool(_HUB_QUESTION.search(text)) and not _WRITE_WORDS.search(text)


def _profile_name() -> str:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
        return home.name if home.parent.name == "profiles" else "default"
    except Exception:
        return ""


def hub_context(session_id: str, user_message: Any, parent_session_id: str = "") -> str | None:
    """Digest to add before the model call, for a Hub question in the router's or the Claude bot's own chat."""
    if parent_session_id or _profile_name() not in HUB_BOTS or not is_hub_question(user_message):
        return None
    digest = _run(["brief"])
    return ("CLAUDE HUB, read just now with hubq.py (under a second). This is a Claude Hub read: answer it yourself from "
            "this text, without calling a tool or delegating, in a few short plain lines with no numbered lists. Run "
            "hubq.py only if Sean asks for more detail than this shows.\n" + digest)
