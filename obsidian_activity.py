"""Which Obsidian notes the agent made or changed, from Hermes' own tool-call log.

The phone app has an Obsidian tab listing the notes Hermes wrote, newest first,
each one a deep link into the Obsidian app on the phone. The activity scan
never reads a note's text: it only resolves file paths the agent passed to its
file tools, checks that they live inside a known vault, and reports names and
times. ``read_note`` is the one place note text is read, for the in-app viewer,
and only for a note file inside a known vault (see its docstring).

Sources, all read-only:

* ``obsidian.json`` (the desktop app's vault registry) says where the vaults
  are. ``HERMES_PWA_OBSIDIAN_VAULTS`` (``os.pathsep``-separated paths)
  overrides it for hosts without the desktop app.
* Hermes' ``state.db`` per profile holds every tool call the agent made.
  ``write_file`` on a path nobody read first is a new note; ``patch`` and
  later writes are edits. Shell redirects into the vault count as edits.
* The iCloud ``iCloud~md~obsidian`` folder names the vaults the phone has.
  When one mirrors a desktop vault, deep links use the phone's name for it.
"""

from __future__ import annotations

import html
import json
import os
import re
import shlex
import sqlite3
import stat as stat_module
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import unquote

NOTE_SUFFIXES = frozenset({".md", ".canvas", ".base"})
CREATE_TOOLS = frozenset({"write_file", "create_file"})
EDIT_TOOLS = frozenset({"patch", "edit_file", "append_file", "str_replace", "apply_patch", "insert"})
READ_TOOLS = frozenset({"read_file", "view_file"})
SHELL_TOOLS = frozenset({"terminal", "bash", "shell", "execute_command", "run_command"})
_PATH_KEYS = ("path", "file_path", "filename", "file", "target_file")

_SHELL_SPLIT = re.compile(r"\s*(?:&&|\|\||[;|\n])\s*")
_SHELL_WRITERS = frozenset({"mv", "cp", "touch", "tee"})
# Obsidian's Local REST API plugin: PUT/POST/PATCH http://127.0.0.1:27124/vault/<path>
# writes a note straight into the open vault without touching the file tools.
_REST_API_WRITE = re.compile(
    r"""(?is)(?:-X\s*|--request\s*|method\s*[=:]\s*['"]?)(PUT|POST|PATCH)\b.*?https?://(?:127\.0\.0\.1|localhost)(?::\d+)?/vault/([^\s'"?#]+)"""
    r"""|https?://(?:127\.0\.0\.1|localhost)(?::\d+)?/vault/([^\s'"?#]+).*?(?:-X\s*|--request\s*|method\s*[=:]\s*['"]?)(PUT|POST|PATCH)\b"""
)
_BIRTHTIME_SLACK_S = 300.0


@dataclass
class Vault:
    name: str
    path: str
    source: str = "desktop"
    is_open: bool = False
    phone_name: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "path": self.path,
            "source": self.source,
            "open": self.is_open,
            "phone_name": self.phone_name,
        }


@dataclass
class NoteEvent:
    path: str
    vault: Vault
    action: str  # created | edited | read
    at: float
    profile: str
    session_id: str


@dataclass
class _NoteState:
    vault: Vault
    created_at: float | None = None
    created_by: str | None = None
    edited_at: float | None = None
    edited_by: str | None = None
    session_id: str | None = None
    reads: set[str] = field(default_factory=set)
    touched: bool = False


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()


def user_home() -> Path:
    return Path(os.environ.get("HERMES_PWA_OBSIDIAN_HOME") or Path.home()).expanduser()


def obsidian_registry_paths(home: Path) -> list[Path]:
    return [
        home / "Library" / "Application Support" / "obsidian" / "obsidian.json",
        home / ".config" / "obsidian" / "obsidian.json",
        home / "AppData" / "Roaming" / "obsidian" / "obsidian.json",
    ]


def icloud_vault_root(home: Path) -> Path:
    return home / "Library" / "Mobile Documents" / "iCloud~md~obsidian" / "Documents"


def _norm(path: str) -> str:
    return os.path.normpath(os.path.expanduser(path))


def _looks_like_vault(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _top_level_names(path: Path) -> set[str]:
    try:
        return {entry.name for entry in path.iterdir() if not entry.name.startswith(".")}
    except OSError:
        return set()


def discover_vaults(home: Path | None = None) -> list[Vault]:
    """Desktop vaults, with the matching phone vault name attached when known."""
    home = home or user_home()
    vaults: list[Vault] = []
    seen: set[str] = set()

    override = os.environ.get("HERMES_PWA_OBSIDIAN_VAULTS", "")
    for raw in (part for part in override.split(os.pathsep) if part.strip()):
        path = Path(_norm(raw.strip()))
        if not _looks_like_vault(path) or str(path) in seen:
            continue
        seen.add(str(path))
        vaults.append(Vault(name=path.name, path=str(path), source="config", is_open=True))

    if not vaults:
        for registry in obsidian_registry_paths(home):
            if not registry.is_file():
                continue
            try:
                data = json.loads(registry.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            entries = data.get("vaults") if isinstance(data, dict) else None
            if not isinstance(entries, dict):
                continue
            for entry in entries.values():
                if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                    continue
                path = Path(_norm(entry["path"]))
                if not _looks_like_vault(path) or str(path) in seen:
                    continue
                seen.add(str(path))
                vaults.append(Vault(name=path.name, path=str(path), source="desktop", is_open=bool(entry.get("open"))))
            break

    phone_names: list[tuple[str, set[str]]] = []
    icloud_root = icloud_vault_root(home)
    if icloud_root.is_dir():
        try:
            for entry in sorted(icloud_root.iterdir()):
                if not entry.is_dir() or entry.name.startswith("."):
                    continue
                if str(entry) in seen:
                    continue
                phone_names.append((entry.name, _top_level_names(entry)))
        except OSError:
            pass

    forced_phone = os.environ.get("HERMES_PWA_OBSIDIAN_PHONE_VAULT", "").strip()
    for vault in vaults:
        if forced_phone:
            vault.phone_name = forced_phone
            continue
        names = _top_level_names(Path(vault.path))
        best: tuple[float, str] | None = None
        for phone_name, phone_entries in phone_names:
            if phone_name == vault.name:
                best = (2.0, phone_name)
                break
            if not names or not phone_entries:
                continue
            overlap = len(names & phone_entries) / max(1, min(len(names), len(phone_entries)))
            if overlap >= 0.5 and (best is None or overlap > best[0]):
                best = (overlap, phone_name)
        vault.phone_name = best[1] if best else None

    # The open vault first, then by name, so the list is stable between scans.
    vaults.sort(key=lambda vault: (not vault.is_open, vault.name.lower()))
    return vaults


def state_databases(hermes_root: Path | None = None) -> list[tuple[str, Path]]:
    """``(profile, state.db)`` for the default profile and every named one."""
    root = hermes_root or hermes_home()
    databases: list[tuple[str, Path]] = []
    main = root / "state.db"
    if main.is_file():
        databases.append(("default", main))
    profiles = root / "profiles"
    if profiles.is_dir():
        try:
            for entry in sorted(profiles.iterdir()):
                db = entry / "state.db"
                if entry.is_dir() and db.is_file():
                    databases.append((entry.name, db))
        except OSError:
            pass
    return databases


def _vault_for(path: str, vaults: Iterable[Vault]) -> Vault | None:
    for vault in vaults:
        root = vault.path.rstrip(os.sep) + os.sep
        if path.startswith(root):
            return vault
    return None


def _candidate_paths(name: str, arguments: object) -> list[tuple[str, str]]:
    """``(path, action)`` pairs one tool call may have touched."""
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            return []
    if not isinstance(arguments, dict):
        return []
    if name in CREATE_TOOLS or name in EDIT_TOOLS or name in READ_TOOLS:
        action = "created" if name in CREATE_TOOLS else "edited" if name in EDIT_TOOLS else "read"
        for key in _PATH_KEYS:
            value = arguments.get(key)
            if isinstance(value, str) and value.strip():
                return [(value, action)]
        return []
    if name in SHELL_TOOLS:
        command = arguments.get("command") or arguments.get("cmd")
        if not isinstance(command, str):
            return []
        found = [(target, "edited") for target in shell_write_targets(command)]
        found.extend(rest_api_write_targets(command))
        return found
    return []


def rest_api_write_targets(command: str) -> list[tuple[str, str]]:
    """``(vault-relative path, action)`` for Local REST API note writes in a shell command."""
    targets: list[tuple[str, str]] = []
    for match in _REST_API_WRITE.finditer(command):
        method = (match.group(1) or match.group(4) or "").upper()
        raw = match.group(2) or match.group(3) or ""
        if not raw:
            continue
        path = unquote(raw).strip("/")
        if not path:
            continue
        targets.append((f"{_REST_API_MARK}{path}", "created" if method == "PUT" else "edited"))
    return targets


def shell_write_targets(command: str) -> list[str]:
    """Files a shell command writes: redirect targets, ``tee``/``touch`` operands, ``mv``/``cp`` destinations."""
    targets: list[str] = []
    for segment in _SHELL_SPLIT.split(command):
        segment = segment.strip()
        if not segment:
            continue
        try:
            tokens = shlex.split(segment, posix=True)
        except ValueError:
            continue
        if not tokens:
            continue
        for index, token in enumerate(tokens):
            if token in {">", ">>"} and index + 1 < len(tokens):
                targets.append(tokens[index + 1])
            elif token.startswith((">>", ">")) and len(token.lstrip(">")) > 0:
                targets.append(token.lstrip(">"))
        head = tokens[0]
        if head == "sudo" and len(tokens) > 1:
            tokens = tokens[1:]
            head = tokens[0]
        if head not in _SHELL_WRITERS:
            continue
        operands: list[str] = []
        for token in tokens[1:]:
            if token.startswith(("<", ">")) or token.endswith(">"):
                break
            if not token.startswith("-"):
                operands.append(token)
        if not operands:
            continue
        if head in {"mv", "cp"}:
            targets.append(operands[-1])
        else:
            targets.extend(operands)
    return targets


def _iter_tool_calls(raw: object) -> Iterable[tuple[str, object]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return
    if not isinstance(raw, list):
        return
    for call in raw:
        if not isinstance(call, dict):
            continue
        function = call.get("function") if isinstance(call.get("function"), dict) else call
        name = function.get("name")
        if isinstance(name, str):
            yield name, function.get("arguments")


_REST_API_MARK = "vault-relative:"


def _resolve_note(raw_path: str, vaults: list[Vault]) -> tuple[str, Vault] | None:
    cleaned = html.unescape(raw_path).strip().strip('"').strip("'")
    if cleaned.startswith(_REST_API_MARK):
        # The REST API serves whichever vault the desktop app has open.
        if not vaults:
            return None
        cleaned = os.path.join(vaults[0].path, cleaned[len(_REST_API_MARK):])
    if not cleaned or not os.path.isabs(os.path.expanduser(cleaned)):
        return None
    path = _norm(cleaned)
    if Path(path).suffix.lower() not in NOTE_SUFFIXES:
        return None
    vault = _vault_for(path, vaults)
    if vault is None:
        return None
    # The vault's own settings folder is not a note.
    if f"{os.sep}.obsidian{os.sep}" in path or f"{os.sep}.trash{os.sep}" in path:
        return None
    return path, vault


def collect_events(db_path: Path, profile: str, vaults: list[Vault], since: float) -> list[NoteEvent]:
    if not vaults:
        return []
    patterns: list[str] = []
    for vault in vaults:
        patterns.append(f"%{vault.path}%")
        escaped = html.escape(vault.path, quote=False)
        if escaped != vault.path:
            patterns.append(f"%{escaped}%")
    # Local REST API writes name the note by vault-relative URL, not by path.
    patterns.append("%/vault/%")
    where = " OR ".join("tool_calls LIKE ?" for _ in patterns)
    events: list[NoteEvent] = []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return []
    try:
        rows = conn.execute(
            f"""
            SELECT session_id, timestamp, tool_calls
            FROM messages
            WHERE role = 'assistant' AND tool_calls IS NOT NULL AND timestamp >= ? AND ({where})
            ORDER BY timestamp ASC
            """,
            (since, *patterns),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    for session_id, timestamp, tool_calls in rows:
        if not isinstance(timestamp, (int, float)):
            continue
        for name, arguments in _iter_tool_calls(tool_calls):
            for raw_path, action in _candidate_paths(name, arguments):
                resolved = _resolve_note(raw_path, vaults)
                if resolved is None:
                    continue
                path, vault = resolved
                events.append(NoteEvent(path, vault, action, float(timestamp), profile, str(session_id or "")))
    return events


def _birthtime(path: str) -> float | None:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    birth = getattr(stat, "st_birthtime", None)
    return float(birth) if isinstance(birth, (int, float)) and birth > 0 else None


def fold_events(events: list[NoteEvent]) -> dict[str, _NoteState]:
    """One record per note: when the agent created it (if it did) and last changed it."""
    notes: dict[str, _NoteState] = {}
    for event in sorted(events, key=lambda item: item.at):
        state = notes.get(event.path)
        if state is None:
            state = notes[event.path] = _NoteState(vault=event.vault)
        if event.action == "read":
            state.reads.add(event.session_id)
            state.touched = True
            continue
        if event.action == "created" and not state.touched:
            birth = _birthtime(event.path)
            existed_before = birth is not None and birth < event.at - _BIRTHTIME_SLACK_S
            if not existed_before and event.session_id not in state.reads:
                state.created_at = event.at
                state.created_by = event.profile
                state.session_id = event.session_id
                state.touched = True
                continue
        state.touched = True
        if state.created_at is None or event.at > state.created_at + 1:
            state.edited_at = event.at
            state.edited_by = event.profile
            state.session_id = event.session_id
    return notes


def _entry(path: str, state: _NoteState) -> dict[str, object] | None:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    relative = os.path.relpath(path, state.vault.path)
    created = state.created_at is not None
    at = state.created_at if created else state.edited_at
    if at is None:
        return None
    folder = os.path.dirname(relative)
    return {
        "path": relative.replace(os.sep, "/"),
        "name": Path(relative).stem,
        "folder": folder.replace(os.sep, "/"),
        "vault": state.vault.name,
        "phone_vault": state.vault.phone_name,
        "action": "created" if created else "edited",
        "at": at,
        "created_at": state.created_at,
        "edited_at": state.edited_at,
        "profile": state.created_by if created and state.edited_at is None else (state.edited_by or state.created_by),
        "session_id": state.session_id,
        "size": stat.st_size,
        "modified_at": stat.st_mtime,
    }


def build_activity(
    *,
    home: Path | None = None,
    hermes_root: Path | None = None,
    days: int = 60,
    limit: int = 300,
    now: float | None = None,
) -> dict[str, object]:
    now = now if now is not None else time.time()
    days = max(1, min(int(days), 3650))
    limit = max(1, min(int(limit), 2000))
    vaults = discover_vaults(home)
    since = now - days * 86400
    events: list[NoteEvent] = []
    profiles: list[str] = []
    for profile, db_path in state_databases(hermes_root):
        profiles.append(profile)
        events.extend(collect_events(db_path, profile, vaults, since))
    entries = [entry for entry in (_entry(path, state) for path, state in fold_events(events).items()) if entry]
    entries.sort(key=lambda entry: float(entry["at"]), reverse=True)  # type: ignore[arg-type]
    return {
        "available": bool(vaults),
        "vaults": [vault.as_dict() for vault in vaults],
        "profiles": profiles,
        "days": days,
        "scanned_at": now,
        "total": len(entries),
        "notes": entries[:limit],
    }


MAX_NOTE_BYTES = 2 * 1024 * 1024


class NoteAccessError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def read_note(vault_name: str, relative_path: str, *, home: Path | None = None) -> dict[str, object]:
    """The text of one note, for the phone's viewer. Only notes inside a known vault.

    The path is resolved with ``realpath`` and must stay inside the vault; dot
    segments (``.obsidian``, ``.trash``) and anything that is not a note file
    are refused, as is anything over ``MAX_NOTE_BYTES``.
    """
    vault = next((v for v in discover_vaults(home) if v.name == vault_name), None)
    if vault is None:
        raise NoteAccessError(404, "unknown vault")
    relative = (relative_path or "").replace("\\", "/").strip().strip("/")
    if not relative or any(part in {"", ".", ".."} or part.startswith(".") for part in relative.split("/")):
        raise NoteAccessError(400, "invalid note path")
    if Path(relative).suffix.lower() not in NOTE_SUFFIXES:
        raise NoteAccessError(400, "not a note")
    root = os.path.realpath(vault.path)
    full = os.path.realpath(os.path.join(root, relative))
    if full != root and not full.startswith(root + os.sep):
        raise NoteAccessError(403, "outside the vault")
    # Open without following a final symlink, then check and read the same
    # descriptor: the path is not consulted again once it has been vetted.
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(full, flags)
    except FileNotFoundError:
        raise NoteAccessError(404, "note not found") from None
    except OSError as exc:
        raise NoteAccessError(500, "could not read the note") from exc
    try:
        stat = os.fstat(fd)
        if not stat_module.S_ISREG(stat.st_mode):
            raise NoteAccessError(404, "note not found")
        if stat.st_size > MAX_NOTE_BYTES:
            raise NoteAccessError(413, "note too large")
        handle = os.fdopen(fd, "rb")
    except NoteAccessError:
        os.close(fd)
        raise
    except OSError as exc:
        os.close(fd)
        raise NoteAccessError(500, "could not read the note") from exc
    try:
        with handle:
            data = handle.read(MAX_NOTE_BYTES + 1)
    except OSError as exc:
        raise NoteAccessError(500, "could not read the note") from exc
    if len(data) > MAX_NOTE_BYTES:
        raise NoteAccessError(413, "note too large")
    return {
        "vault": vault.name,
        "phone_vault": vault.phone_name,
        "path": relative,
        "name": Path(relative).stem,
        "text": data.decode("utf-8", errors="replace"),
        "size": stat.st_size,
        "modified_at": stat.st_mtime,
    }


# The phone asks for one of these windows; anything else is rounded up to the
# next one so the cache holds a handful of scans, not one per odd request.
DAY_BUCKETS = (7, 30, 60, 365, 3650)
MAX_LIMIT = 2000
_CACHE_MAX_ENTRIES = 4


def snap_days(days: int, buckets: tuple[int, ...] = DAY_BUCKETS) -> int:
    """The smallest bucket that covers ``days`` (the largest when none does)."""
    wanted = max(1, int(days))
    return next((bucket for bucket in buckets if wanted <= bucket), buckets[-1])


class BoundedCache:
    """A few recent results keyed by (home, days bucket), oldest evicted first.

    ``get`` builds through ``build(days, now)`` on a miss or a stale hit and
    stores the full-size result, so every ``limit`` the phone asks for is
    served from the same entry.
    """

    def __init__(self, ttl_seconds: float, max_entries: int = _CACHE_MAX_ENTRIES) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._entries: dict[tuple[str, int], tuple[float, dict[str, object]]] = {}
        self._lock = threading.Lock()

    def get(self, key: tuple[str, int], build: Callable[[], dict[str, object]]) -> dict[str, object]:
        now = time.time()
        with self._lock:
            hit = self._entries.get(key)
            if hit and now - hit[0] < self.ttl_seconds:
                return hit[1]
        result = build()
        with self._lock:
            self._entries[key] = (now, result)
            while len(self._entries) > self.max_entries:
                oldest = min(self._entries, key=lambda item: self._entries[item][0])
                del self._entries[oldest]
        return result

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_CACHE = BoundedCache(ttl_seconds=20.0)


def cached_activity(days: int = 60, limit: int = 300) -> dict[str, object]:
    """``build_activity`` with a short, bounded cache: the phone polls, the scan reads every profile's history.

    ``days`` is rounded up to a ``DAY_BUCKETS`` window (reported back as
    ``days``) and the scan keeps ``MAX_LIMIT`` rows; ``limit`` is applied to
    the cached copy on the way out.
    """
    bucket = snap_days(days)
    wanted = max(1, min(int(limit), MAX_LIMIT))
    key = (str(hermes_home()), bucket)
    result = _CACHE.get(key, lambda: build_activity(days=bucket, limit=MAX_LIMIT, now=time.time()))
    notes = result.get("notes")
    if isinstance(notes, list) and len(notes) > wanted:
        return {**result, "notes": notes[:wanted]}
    return result


def clear_cache() -> None:
    _CACHE.clear()
