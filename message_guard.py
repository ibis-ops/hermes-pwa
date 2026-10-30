"""The message guard: no bot sends anything to anyone without Sean's explicit yes.

A ``pre_tool_call`` hook. Any tool call that would put a message in front of another person goes to Hermes's
human-approval gate first: Sean sees what would be sent, and to whom, in his phone's Approvals tab and says yes or no.
Where nobody can answer (a scheduled job, a one-shot run, a hand-off to another bot), Hermes denies it. With
approvals switched off or yolo on, the guard blocks instead of asking, so there is no way around it.

What counts as sending: Gmail send, reply or forward; calendar events with attendees (Google emails the invites);
Drive shares (Google emails the person); Signal through signal-cli or its JSON-RPC; iMessage, Mail or WhatsApp
through AppleScript; command-line mailers; messaging APIs (Telegram, Slack, Discord, Twilio, WhatsApp, SendGrid,
Mailgun, Postmark); send, reply, post, share, invite or react tools, MCP ones included; a scheduled job that delivers
its output to anyone but Sean; screen control while a messaging app is in front; and a chrome call with an
"allow send" step (the chrome tool refuses send clicks, Yes in a notify prompt, Enter in a message box and sending
confirm dialogs on its own; "allow send" lifts that for one approved call). Bot to bot messages (message_agent) and
the Claude Hub tools are not messages to a person.

Each approval is keyed to the exact call, so "always" in the prompt only ever covers that same message again.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from typing import Any

INTERNAL_TOOLS = frozenset({"message_agent", "delegate_task", "chrome_history"})
INTERNAL_MCP = re.compile(r"^mcp_+claude[_-]hub_", re.I)
SEND_TOOL = re.compile(r"(?:^|_)(?:send|post|reply|notify|share|invite|email|sms|tweet|publish|react|forward|dm)(?:_|$)|"
                       r"send_?message|message_?send", re.I)
SHELL_SEND = [
    re.compile(r"google_api\.py\s+gmail\s+(?:send|reply|forward)\b"),
    re.compile(r"google_api\.py\s+calendar\s+(?:create|update)\b[^\n]*--attendees(?:\s+|=)['\"]?[^'\"\s-]"),
    re.compile(r"google_api\.py\s+drive\s+share\b"),
    re.compile(r"\bsignal-cli\b[^\n]*\b(?:send|sendReaction|sendNote)\b"),
    re.compile(r"[\"']method[\"']\s*:\s*[\"'](?:send|sendReaction|sendNote|sendTyping)\w*[\"']", re.I),
    re.compile(r"\bosascript\b[\s\S]*?\b(?:Messages|Mail|WhatsApp|Signal|Telegram)\b[\s\S]*?\bsend\b", re.I),
    re.compile(r"\b(?:sendmail|msmtp|mailx|mutt|neomutt|swaks)\b|\bmail\s+-s\b|\bhimalaya\b[^\n]*\b(?:send|write|reply|forward)\b"),
    re.compile(r"\b(?:curl|wget|http|httpie)\b[^\n]*(?:api\.telegram\.org|hooks\.slack\.com|slack\.com/api/chat|"
               r"discord(?:app)?\.com/api/(?:webhooks|channels)|api\.twilio\.com|graph\.facebook\.com|whatsapp|"
               r"api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com|gmail\.googleapis\.com[^\s]*/send)", re.I),
    re.compile(r"(?:^|[\s/])(?:send|signal_send|send_signal|send_email|send_sms|send_imessage|send_whatsapp|reply_to|"
               r"post_message|notify_client)[\w-]*\.(?:py|sh|js|mjs)\b", re.I),
]
PY_SEND = re.compile(r"\.messages\(\)\.send\(|users\(\)\.messages\(\)\.send|\bsmtplib\b|\.sendmail\(|\.send_message\(|"
                     r"\btwilio\b|\bslack_sdk\b|chat_postMessage|\bsendgrid\b|\.share\(|permissions\(\)\.create\(", re.I)
BROWSER_SEND = re.compile(r"\b(?:send|reply|post|publish|notify|share|invite|tweet)\b", re.I)
BROWSER_ACT = re.compile(r"click|press|submit|enter|type", re.I)
# In browser code, "send" is also a websocket method: only a quoted control label that sends counts.
BROWSER_CODE_SEND = re.compile(r"[\"'][^\"'\n]{0,40}\b(?:send|reply|post|publish|notify|share|invite|tweet)\b[^\"'\n]{0,30}[\"']", re.I)
ALLOW_SEND = re.compile(r"(?im)^\s*allow\s+(?:send|sending|message|messages|notify)\b")
MESSAGING_APPS = ("Messages", "WhatsApp", "Mail", "Signal", "Slack", "Discord", "Telegram", "Messenger", "Instagram",
                  "Microsoft Outlook", "Spark", "Superhuman")
SCREEN_ACT = re.compile(r"click|type|key|press|paste|drag", re.I)
OWN_DELIVERY = {"", "local", "origin", "none"}


def _text(value: Any, limit: int = 500) -> str:
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 3] + "..."


def _frontmost_app() -> str:
    try:
        out = subprocess.run(["/usr/bin/osascript", "-e",
                              'tell application "System Events" to get name of first process whose frontmost is true'],
                             capture_output=True, text=True, timeout=2)
        return out.stdout.strip()
    except Exception:
        return ""


def classify(tool: str, args: Any) -> str | None:
    """What a call would send, in a few words for Sean's approval prompt; None when it sends nothing."""
    args = args if isinstance(args, dict) else {}
    if not tool or tool in INTERNAL_TOOLS:
        return None
    if tool.startswith("mcp"):
        if INTERNAL_MCP.match(tool):
            return None
        last = re.split(r"__|(?<=mcp)_", tool)[-1]
        return f"a message through {tool}: {_text(args)}" if SEND_TOOL.search(last) else None
    if tool == "terminal":
        cmd = str(args.get("command") or "")
        if any(rx.search(cmd) for rx in SHELL_SEND) or PY_SEND.search(cmd):
            return f"a message sent from the terminal: {_text(cmd)}"
        return None
    if tool == "execute_code":
        code = str(args.get("code") or "")
        if PY_SEND.search(code) or any(rx.search(code) for rx in SHELL_SEND):
            return f"a message sent from code: {_text(code)}"
        return None
    if tool == "chrome":
        steps = args.get("steps") if "steps" in args else args.get("script")
        flat = steps if isinstance(steps, str) else json.dumps(steps, ensure_ascii=False, default=str)
        lines = flat if isinstance(steps, str) else "\n".join(
            (" ".join(f"{k} {v}" for k, v in s.items()) if isinstance(s, dict) else str(s)) for s in (steps or []))
        if ALLOW_SEND.search(lines) or re.search(r'"allow"\s*:\s*"(?:send|sending|message|messages|notify)"', flat, re.I):
            return f"a message sent from the browser (allow send): {_text(lines)}"
        return None
    if tool == "browser_exec":
        code = str(args.get("code") or args.get("script") or "")
        if BROWSER_CODE_SEND.search(code) and BROWSER_ACT.search(code):
            return f"a possible message from browser code: {_text(code)}"
        return None
    if tool.startswith("browser_") and tool != "browser_vault":
        text = json.dumps(args, ensure_ascii=False, default=str)
        if BROWSER_SEND.search(text) and BROWSER_ACT.search(tool + " " + text):
            return f"a possible message from {tool}: {_text(args)}"
        return None
    if tool == "computer_use":
        if SCREEN_ACT.search(str(args.get("action") or "")):
            app = _frontmost_app()
            if app and any(app == m or app.startswith(m) for m in MESSAGING_APPS):
                return f"typing or clicking in {app} with screen control: {_text(args, 200)}"
        return None
    if tool in ("cronjob_manage", "cronjob"):
        deliver = args.get("deliver")
        if deliver is not None and str(deliver).strip().lower() not in OWN_DELIVERY:
            return f"a scheduled job that delivers its output to {deliver}"
        return None
    if SEND_TOOL.search(tool):
        return f"a message through {tool}: {_text(args)}"
    return None


def _approvals_bypassed() -> bool:
    """Yolo or approvals switched off would wave an approval through; the guard blocks instead."""
    try:
        from tools.approval import _yolo_active  # type: ignore
        from tools import approval_context  # type: ignore

        return bool(_yolo_active()) or approval_context._get_approval_mode() == "off"
    except Exception:
        return False


def on_pre_tool_call(**kwargs: Any) -> dict[str, str] | None:
    tool = str(kwargs.get("tool_name") or "")
    args = kwargs.get("args")
    try:
        what = classify(tool, args)
    except Exception:
        what = f"a call to {tool} that the message guard could not read" if SEND_TOOL.search(tool) else None
    if not what:
        return None
    if _approvals_bypassed():
        return {"action": "block",
                "message": f"BLOCKED: {what}. No bot sends anything to anyone without Sean's explicit yes, and approvals are "
                           "switched off right now, so this is blocked. Ask Sean."}
    digest = hashlib.sha256(json.dumps([tool, args], sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:16]
    return {"action": "approve", "rule_key": f"message:{digest}",
            "message": f"Sean's explicit yes is needed: {what}"}
