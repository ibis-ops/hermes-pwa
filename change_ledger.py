"""The change ledger: one line for every change a bot makes, so the Auditor bot can check it afterwards.

A ``post_tool_call`` hook. Reads are not changes and are not written: page reads, file reads, searches,
plain shell reads. Changes are: file writes and patches; shell commands and Python that write, move,
delete, install, commit, send or stop processes; the chrome tool's typed values, choices, ticks and
clicks (the connector keeps each with its value before and after in its own history file, and the
ledger line points at it); the screen and browser_* tools' clicks and typing; memory, skill, schedule
and connection edits; and MCP tools whose names write (send, save, remember, create, delete, ...).

One JSONL file per month for all bots, in <Hermes root>/changes/. A line holds id, ts, bot, session,
task, tool, kind, target, detail, status and error. Secrets are masked and long text is cut. The hook
never raises: a ledger problem must never break a bot's tool call.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

try:  # Loaded as part of the plugin package (the gateway's hooks).
    from .bot_graph import _current_bot, _root_hermes_home  # type: ignore
except ImportError:  # Loaded on its own (the tests, the Auditor's scripts).
    from bot_graph import _current_bot, _root_hermes_home  # type: ignore

MAX_DETAIL = 700
MAX_LINE = 3500
MAX_TARGETS = 6

_KIND_BY_TOOL = {
    "write_file": "file",
    "patch": "file",
    "memory": "memory",
    "skill_manage": "skill",
    "cronjob_manage": "schedule",
    "manage_connections": "connections",
    "manage_catalog": "connections",
    "send_message": "send",
}
_BROWSER_WRITES = re.compile(r"^browser_(click|type|fill|press|select|upload|drag|check|cdp|evaluate|key)")
_BROWSER_EXEC_WRITES = re.compile(r"\b(?:click|fill|type_text|type|press|select_option|upload|submit|set_input_files)\b")
_SCREEN_WRITES = re.compile(r"click|type|key|drag|press|paste|write|scroll_to_click", re.I)
_MCP_WRITES = re.compile(
    r"(send|save|remember|import|log_limit|create|update|delete|remove|write|edit|post|add|move|rename|"
    r"cancel|book|mark|archive|upload|reply|draft|set_|_set|publish|apply|revert)", re.I)
_CHROME_CHANGES = re.compile(r"Changes made in this call: (\d+)")

_REDIRECT = re.compile(r"(?:^|[^0-9&<>|=-])>>?[ \t]*(?!&|=|/dev/(?:null|stderr|stdout)\b)((?:[\"'][~/.$\w]|[~/.$\w])[^\s;|&)<>]*)")
# Checked on the shell around the data (quoted strings and heredoc bodies blanked), so words inside an
# echo, a SQL query or a Python heredoc do not count.
_SHELL_WRITES = [
    re.compile(r"\b(?:rm|rmdir|mv|cp|mkdir|touch|ln|chmod|chown|truncate|rsync|ditto|unzip|trash|shred|"
               r"kill|pkill|killall)\b|\btee\s+(?:-a\s+)?(?!/dev/)\S|\bcrontab\s+(?!-l)"),
    re.compile(r"\blaunchctl\s+(?:bootout|bootstrap|kickstart|load|unload|stop|start|enable|disable|kill|remove|submit)\b"),
    re.compile(r"\bdefaults\s+(?:write|delete)\b"),
    re.compile(r"\bsed\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i"),
    re.compile(r"\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|pull|merge|rebase|reset|checkout|switch|stash|tag|rm|mv|"
               r"apply|cherry-pick|revert|clean|init|clone|am|restore|add)\b"),
    re.compile(r"\b(?:pip3?|uv|npm|pnpm|yarn|brew|gem|cargo)\s+(?:install|uninstall|remove|add|upgrade|update)\b"),
    re.compile(r"\bhermes\b[^;|&\n]*\b(?:config\s+set|cron\s+(?:add|create|remove|delete|rm|pause|resume|edit|run)|"
               r"plugins?\s+(?:install|update|remove|uninstall|enable|disable)|profile\s+(?:create|delete|rename|use)|"
               r"skills?\s+(?:install|remove|uninstall)|gateway\s+(?:restart|stop|start))\b"),
    re.compile(r"\.(?:py|sh|js|mjs)\s+(?:[^\n;|&]*\s)?(?:send|create|update|delete|remove|add|move|apply|revert|"
               r"save|post|book|cancel|reply|draft|write|mark|archive|label|import|upload)\b"),
    re.compile(r"\s--(?:yes|apply|write|send|commit|delete)\b"),
]
# Checked on the whole command: what matters here sits inside quotes (AppleScript, SQL, a request body).
_SHELL_WRITES_RAW = [
    re.compile(r"\bosascript\b[^\n]*\b(?:send|keystroke|key code|click|set|make|delete|move|save|close|quit|do shell script)\b"),
    re.compile(r"\bsqlite3\s+(?![^\n]*-readonly)[^\n]*\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|"
               r"DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|CREATE\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|REPLACE\s+INTO|VACUUM)\b", re.I),
    re.compile(r"\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|\s-d\s|"
               r"--data|\s-F\s|--form|\s-T\s|--upload-file)"),
    re.compile(r"(?:^|[\s/_.-])(?:send|create|update|delete|remove|write|post|book|cancel|reply|draft|apply|revert|"
               r"import|move|rename|save|archive|label|mark|edit|patch|publish|upload)(?:[_.-][\w.-]*)?\.(?:py|sh|js|mjs|rb)\b", re.I),
]
_PY_WRITES = re.compile(
    r"\bopen\([^)\n]*,\s*(?:mode\s*=\s*)?['\"][^'\"]*[wax+]|\.write_(?:text|bytes)\(|"
    r"\bshutil\.(?:copy\w*|move|rmtree)\(|"
    r"\bos\.(?:remove|unlink|rename|replace|rmdir|removedirs|makedirs|mkdir|symlink|chmod|truncate|kill)\(|"
    r"\.(?:unlink|rmdir|symlink_to|touch)\(|"
    r"\b(?:requests|httpx|session|client)\.(?:post|put|patch|delete)\(|method\s*=\s*['\"](?:POST|PUT|PATCH|DELETE)|"
    r"\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|REPLACE\s+INTO)\b")
_PY_SHELLS = re.compile(r"(?:subprocess\.\w+|os\.system|os\.popen)\([^)]*\b(?:rm|mv|cp|git|launchctl|kill|pkill|osascript|curl|hermes)\b")
_PATHS = re.compile(r"(?:~|\$HOME|/Users|/opt|/etc|/Library|/Applications|/private|/tmp|/var)(?:/[^\s'\"<>|;&)(,`]*)?")
_V4A_FILES = re.compile(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", re.M)
_SECRETS = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|"
    r"AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|"
    r"(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,}|"
    r"(?i:(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)['\"]?[^\s'\"&]{6,})")


def ledger_dir() -> Path:
    return _root_hermes_home() / "changes"


def ledger_path(when: float | None = None) -> Path:
    return ledger_dir() / (time.strftime("%Y-%m", time.localtime(when)) + ".jsonl")


def _mask(text: str) -> str:
    try:
        from agent.redact import redact_sensitive_text  # type: ignore

        text = redact_sensitive_text(text, force=True)
    except Exception:
        pass
    return _SECRETS.sub("[secret]", text)


def _cut(text: Any, limit: int = MAX_DETAIL) -> str:
    s = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False, default=str)
    s = _mask(s.strip())
    return s if len(s) <= limit else s[: limit - 3] + "..."


def _paths(text: str) -> list[str]:
    out: list[str] = []
    for m in _PATHS.finditer(text or ""):
        p = m.group(0).rstrip(".,:'\"")
        if len(p) > 1 and p not in out and not p.startswith("/dev/"):
            out.append(p)
        if len(out) >= MAX_TARGETS:
            break
    return out


_HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n.*?\n\s*\2[ \t]*(?=\n|$)", re.S)
_QUOTED = re.compile(r"'[^'\n]*'|\"(?:[^\"\\\n]|\\.)*\"")


def _surface(command: str) -> str:
    """The shell around the data: heredoc bodies and quoted strings become a placeholder, so a ``>``
    inside SQL, awk, sed or Python is not read as a redirect (a quoted file name stays a target)."""
    text = _HEREDOC.sub(lambda m: "<<HEREDOC" + m.group(3), command)
    return _QUOTED.sub('"Q"', text)


_SCRATCH = re.compile(r"^[\"']?(?:/tmp/|/private/tmp/|/private/var/folders/|/var/folders/|/dev/)")


def shell_changes(command: str) -> tuple[list[str], list[str]]:
    """What a shell command (or the Python inside it) changes: the rules that fired and the files it
    redirects output into. Both empty for a read."""
    if not command:
        return [], []
    surface = _surface(command)
    redirects = [m.group(1).strip("\"'") for m in _REDIRECT.finditer(surface) if not re.fullmatch(r"[\d.]+", m.group(1))]
    rules = [m.group(0).strip()[:40] for rx in _SHELL_WRITES for m in [rx.search(surface)] if m]
    rules += [m.group(0).strip()[:40] for rx in _SHELL_WRITES_RAW for m in [rx.search(command)] if m]
    m = _PY_WRITES.search(command)
    if m:
        rules.append(m.group(0).strip()[:40])
    if redirects:
        rules.insert(0, "redirect")
    return rules, redirects


def shell_writes(command: str) -> bool:
    """True when a shell command (or the Python inside it) looks like it changes something."""
    return bool(shell_changes(command)[0])


def classify(tool: str, args: Any, result: Any) -> dict[str, Any] | None:
    """The ledger fields for one tool call, or None when the call changed nothing."""
    args = args if isinstance(args, dict) else {}
    text = result if isinstance(result, str) else ""
    kind = _KIND_BY_TOOL.get(tool)
    if tool == "write_file":
        content = args.get("content")
        size = len(content) if isinstance(content, str) else 0
        return {"kind": "file", "target": [str(args.get("path") or "")], "detail": f"wrote {size} chars"}
    if tool == "patch":
        if isinstance(args.get("patch"), str) and not args.get("path"):
            files = _V4A_FILES.findall(args["patch"])[:MAX_TARGETS]
            return {"kind": "file", "target": files, "detail": "patch: " + _cut(args["patch"], 400)}
        old, new = args.get("old_string") or "", args.get("new_string") or ""
        return {"kind": "file", "target": [str(args.get("path") or "")],
                "detail": f"replace{' all' if args.get('replace_all') else ''}: " + _cut(old, 250) + " => " + _cut(new, 300)}
    if kind:
        return {"kind": kind, "target": [], "detail": _cut(args)}
    if tool == "terminal":
        cmd = str(args.get("command") or "")
        rules, redirects = shell_changes(cmd)
        if not rules:
            return None
        out: dict[str, Any] = {"kind": "shell", "target": _paths(cmd), "detail": _cut(cmd), "why": rules[:5]}
        if rules == ["redirect"] and all(_SCRATCH.match(r) for r in redirects):
            out["scratch"] = True  # output saved to a scratch file only
        return out
    if tool == "execute_code":
        code = str(args.get("code") or "")
        if not (_PY_WRITES.search(code) or _PY_SHELLS.search(code)):
            return None
        return {"kind": "code", "target": _paths(code), "detail": _cut(code)}
    if tool == "chrome":
        m = _CHROME_CHANGES.search(text)
        n = int(m.group(1)) if m else 0
        if not n:
            return None
        steps = args.get("steps") if "steps" in args else args.get("script")
        urls = re.findall(r"https?://[^\s'\"<>]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:/[^\s'\"<>]*)?", _cut(steps, 2000))
        return {"kind": "web", "target": urls[:3], "detail": f"{n} change(s): " + _cut(steps, 500)}
    if tool == "browser_exec":
        code = str(args.get("code") or args.get("script") or args)
        if not _BROWSER_EXEC_WRITES.search(code):
            return None
        return {"kind": "web", "target": [], "detail": _cut(code)}
    if _BROWSER_WRITES.match(tool):
        return {"kind": "web", "target": [], "detail": _cut(args)}
    if tool == "computer_use":
        action = str(args.get("action") or "")
        if not _SCREEN_WRITES.search(action):
            return None
        return {"kind": "screen", "target": [], "detail": _cut(args)}
    if tool.startswith("mcp_") or tool.startswith("mcp__"):
        last = re.split(r"__|(?<=mcp)_", tool)[-1]
        if not _MCP_WRITES.search(last):
            return None
        return {"kind": "mcp", "target": [], "detail": _cut(args)}
    return None


def _chrome_history_file(session_id: str, task_id: str) -> str:
    try:
        try:
            from .chrome_connector import History, _session_key, load_settings  # type: ignore
        except ImportError:
            from chrome_connector import History, _session_key, load_settings  # type: ignore
        settings = load_settings()
        if settings is None:
            return ""
        return str(History(settings.history_dir, _session_key(task_id or None, session_id or None)).path)
    except Exception:
        return ""


def record(tool: str, args: Any, result: Any, *, session_id: str = "", task_id: str = "",
           status: Any = None, error: Any = None, bot: str | None = None) -> dict[str, Any] | None:
    """Classify one tool call and append it to the ledger when it changed something."""
    fields = classify(tool, args, result)
    if fields is None:
        return None
    now = time.time()
    bot = bot or _current_bot() or "default"
    entry: dict[str, Any] = {
        "id": time.strftime("%Y%m%dT%H%M%S", time.localtime(now)) + f".{int(now * 1000) % 1000:03d}-{bot}-{secrets.token_hex(2)}",
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now)),
        "bot": bot,
        "session": session_id,
        "task": task_id if task_id and task_id != session_id else "",
        "tool": tool,
        **fields,
        "status": str(status or "ok"),
    }
    if error:
        entry["error"] = _cut(error, 300)
    if fields["kind"] == "web" and tool == "chrome":
        entry["history"] = _chrome_history_file(session_id, task_id)
    line = json.dumps(entry, ensure_ascii=False)
    if len(line) > MAX_LINE:
        entry["detail"] = entry["detail"][: max(100, MAX_LINE - (len(line) - len(entry["detail"])) - 10)] + "..."
        line = json.dumps(entry, ensure_ascii=False)
    path = ledger_path(now)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    return entry


def on_post_tool_call(**kwargs: Any) -> None:
    """The hook: never raises, costs a dict lookup for reads."""
    try:
        tool = str(kwargs.get("tool_name") or "")
        if not tool:
            return
        record(tool, kwargs.get("args"), kwargs.get("result"),
               session_id=str(kwargs.get("session_id") or ""), task_id=str(kwargs.get("task_id") or ""),
               status=kwargs.get("status"), error=kwargs.get("error_message"))
    except Exception:
        pass


def read_entries(since_id: str = "", months: int = 2) -> list[dict[str, Any]]:
    """Ledger lines newer than ``since_id`` (ids sort by time), oldest first, from the last ``months`` files."""
    files = sorted(ledger_dir().glob("*.jsonl"))[-months:]
    out: list[dict[str, Any]] = []
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(e, dict) and str(e.get("id", "")) > since_id:
                        out.append(e)
        except OSError:
            continue
    out.sort(key=lambda e: str(e.get("id", "")))
    return out
