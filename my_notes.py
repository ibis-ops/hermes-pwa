"""Sean's own notes in Obsidian: the "Notes from Sean" folder, read and written from the phone.

The phone app's Obsidian tab has a Notes from Sean view: the notes in this
folder, newest first, each one readable, and a way to write a new note or
edit one. Nothing is deleted from here. The files on the Mac are the source
of truth; Obsidian Sync carries them to Obsidian on the phone.

Which vault, in this order:

1. ``HERMES_PWA_NOTES_VAULT`` when it is set: a vault's folder name or its
   path. It must be one of the vaults the plugin knows
   (``obsidian_activity.discover_vaults``); a value that matches none is
   reported as an error, never quietly replaced by another vault.
2. Else the first known vault that already has a ``Notes from Sean`` folder
   (a real folder, not a link).
3. Else the vault the Obsidian app on the Mac has open, and with several
   open, or none, the first by name. That is the order ``discover_vaults``
   returns, so the choice is the same on every call.

The folder is created inside that vault on the first save.

Path safety lives here, not on the phone. Only ``.md`` files directly inside
the folder are listed, read or written. A name from the phone may not hold a
path separator, start with a dot, or be anything but a ``.md`` file name. The
folder must be a real folder directly inside the vault (a link there is
refused, wherever it points), and note files are opened without following
links. A title becomes a readable file name ("Gym ideas.md"). A new note
never replaces a file: a taken name gets the next free one, numbered the way
Obsidian numbers "Untitled 1". Every write goes to a hidden temporary file in
the same folder first and then replaces the note in one step. Notes are
capped at ``MAX_NOTE_BYTES``. An edit sends back the ``version`` (SHA-256 of
the bytes) it started from and is refused when the file has changed since,
so an edit from the phone never overwrites a newer edit made on the Mac.
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import os
import re
import secrets
import stat as stat_module
import threading
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from obsidian_activity import Vault, discover_vaults

NOTES_FOLDER = "Notes from Sean"
VAULT_ENV = "HERMES_PWA_NOTES_VAULT"
NOTE_SUFFIX = ".md"
MAX_NOTE_BYTES = 1024 * 1024
# The JSON body of a save: escaping can double the text (newlines, quotes).
MAX_REQUEST_BYTES = 2 * MAX_NOTE_BYTES + 64 * 1024
MAX_LIST = 500
PREVIEW_BYTES = 4096
PREVIEW_CHARS = 140
MAX_TITLE_CHARS = 120
# File names are at most 255 bytes; this leaves room for " 999" and ".md".
MAX_TITLE_BYTES = 200
MAX_NAME_BYTES = 255
UNTITLED = "Untitled"
_DERIVED_TITLE_CHARS = 60
_MAX_NUMBERED = 1000

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
# A FIFO named like a note must not hang the request: open it without waiting.
_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
_LINK_ERRNOS = frozenset({errno.ELOOP, getattr(errno, "EMLINK", errno.ELOOP)})

# One writer at a time inside this process: two quick saves from the phone
# cannot interleave, and the second one sees the first one's version.
_WRITE_LOCK = threading.Lock()

_NUL = chr(0)
_BOM = chr(0xFEFF)
_ZERO_WIDTH_JOINER = chr(0x200D)
_ELLIPSIS = chr(0x2026)

# Characters a file name cannot hold on the Mac, the phone or Windows, or that
# break Obsidian links: path separators read as a dash, the rest as a space.
_AS_DASH = str.maketrans({"/": "-", "\\": "-", "|": "-"})
_AS_SPACE = re.compile(r'[:*?"<>#^\[\]]')
# Invisible characters that would make two names look alike or reorder text.
# The zero width joiner stays: emoji are built with it.
_INVISIBLE = frozenset(
    chr(code)
    for code in (
        0x061C,  # Arabic letter mark
        0x180E,  # Mongolian vowel separator
        0x200B,  # zero width space
        0x200E,  # left-to-right mark
        0x200F,  # right-to-left mark
        *range(0x202A, 0x202F),  # bidi embeddings and overrides
        *range(0x2060, 0x2065),  # word joiner, invisible operators
        *range(0x2066, 0x206A),  # bidi isolates
        0xFEFF,  # byte order mark
    )
)
_WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
)

# Markdown that a one-line preview or a title from the first line leaves out.
_MARKERS = re.compile(r"^(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)")
_WIKILINK = re.compile(r"!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_EMPHASIS = re.compile(r"\*\*|__|~~|==|`")
_FENCE = re.compile(r"^\s*(?:```|~~~)")
_RULE = re.compile(r"[-*_=~`\s]+")


class NotesError(Exception):
    """A refusal: the HTTP status the route answers, a short ``detail``, and any extra fields.

    ``reason`` among the extras is a stable code the phone explains in its own
    words: ``no_vault``, ``bad_setting``, ``not_allowed`` (a link, or a folder
    that is not a plain folder), ``gone``, ``too_large``, ``changed``,
    ``read_only`` or ``taken``.
    """

    def __init__(self, status: int, detail: str, **extra: object) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.extra = extra

    @property
    def reason(self) -> object:
        return self.extra.get("reason")


@dataclass(frozen=True)
class NotesVault:
    """The vault the notes folder lives in, and which rule picked it."""

    vault: Vault
    chosen_by: str  # setting | folder | open | first

    @property
    def folder(self) -> str:
        # The vault's own location may run through links; the folder inside it may not.
        return os.path.join(os.path.realpath(self.vault.path), NOTES_FOLDER)


def _same_place(a: str, b: str) -> bool:
    try:
        return os.path.realpath(os.path.expanduser(a)) == os.path.realpath(os.path.expanduser(b))
    except (OSError, ValueError):
        return False


def _is_real_folder(path: str) -> bool:
    try:
        return stat_module.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def choose_vault(home: Path | None = None) -> NotesVault:
    """The vault for the notes folder, by the rule in the module docstring."""
    vaults = discover_vaults(home)
    wanted = os.environ.get(VAULT_ENV, "").strip()
    if wanted:
        for vault in vaults:
            if vault.name == wanted or _same_place(vault.path, wanted):
                return NotesVault(vault, "setting")
        raise NotesError(404, f"{VAULT_ENV} does not name an Obsidian vault on this Mac", reason="bad_setting")
    if not vaults:
        raise NotesError(404, "no Obsidian vault was found on this Mac", reason="no_vault")
    for vault in vaults:
        if _is_real_folder(os.path.join(os.path.realpath(vault.path), NOTES_FOLDER)):
            return NotesVault(vault, "folder")
    first = vaults[0]
    return NotesVault(first, "open" if first.is_open else "first")


def _folder_exists(folder: str) -> bool:
    """True when the notes folder is there, False before the first save.

    Anything at that name other than a real folder (a link, wherever it
    points, or a file) is refused rather than followed or replaced.
    """
    try:
        info = os.lstat(folder)
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise NotesError(500, "could not open the notes folder") from exc
    if not stat_module.S_ISDIR(info.st_mode):
        raise NotesError(403, f"{NOTES_FOLDER} in the vault is not a plain folder", reason="not_allowed")
    return True


def _ensure_folder(folder: str) -> None:
    if _folder_exists(folder):
        return
    try:
        os.mkdir(folder, 0o755)
    except FileExistsError:
        pass
    except OSError as exc:
        raise NotesError(500, "could not create the notes folder") from exc
    if not _folder_exists(folder):
        raise NotesError(500, "could not create the notes folder")


def _fold(name: str) -> str:
    """Names as the Mac's and the phone's file systems compare them: case and Unicode form ignored."""
    return unicodedata.normalize("NFC", name).casefold()


def _utf8_size(text: str) -> int | None:
    try:
        return len(text.encode("utf-8"))
    except UnicodeEncodeError:
        return None


def is_note_name(name: object) -> bool:
    """A file name the folder may hold a note under: ``<something>.md``, no separators, not hidden."""
    if not isinstance(name, str):
        return False
    size = _utf8_size(name)
    return (
        size is not None
        and size <= MAX_NAME_BYTES
        and len(name) > len(NOTE_SUFFIX)
        and not name.startswith(".")
        and "/" not in name
        and "\\" not in name
        and _NUL not in name
        and name.lower().endswith(NOTE_SUFFIX)
    )


def _check_name(name: object) -> str:
    if not isinstance(name, str) or not is_note_name(name):
        raise NotesError(400, "invalid note name")
    return name


def title_of(name: str) -> str:
    """The title Obsidian shows for a note file: its name without ``.md``."""
    return name[: -len(NOTE_SUFFIX)] if name.lower().endswith(NOTE_SUFFIX) else name


def _clip_title(text: str) -> str:
    text = text[:MAX_TITLE_CHARS]
    while text and len(text.encode("utf-8")) > MAX_TITLE_BYTES:
        text = text[:-1]
    # No trailing dot or space, nor a joiner left from an emoji cut in half.
    return text.rstrip(" ." + _ZERO_WIDTH_JOINER)


def safe_title(raw: str) -> str:
    """A readable file name, without ``.md``, for a note title; empty when nothing usable is left.

    "Gym ideas" stays "Gym ideas" and "Q3/Q4: plan?" becomes "Q3-Q4 plan".
    Path separators, characters file systems or Obsidian links cannot hold,
    control and invisible characters, leading dots (a hidden file) and
    trailing dots or spaces go, and the result is capped for the file system.
    """
    text = unicodedata.normalize("NFC", raw)
    text = re.sub(r"\s+", " ", text)
    text = "".join(ch for ch in text if ch not in _INVISIBLE and unicodedata.category(ch) not in ("Cc", "Cs"))
    text = _AS_SPACE.sub(" ", text.translate(_AS_DASH))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"(?:\.md)+$", "", text, flags=re.IGNORECASE)
    text = _clip_title(text.strip(" ."))
    if text.upper() in _WINDOWS_RESERVED:
        text = f"{text} note"
    return text


def _content_lines(text: str) -> list[str]:
    """A note's lines after its frontmatter; none when the frontmatter does not end."""
    lines = text.lstrip(_BOM).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() in ("---", "..."):
                return lines[index + 1 :]
        return []
    return lines


def _plain_line(line: str) -> str:
    """One line of Markdown as plain words: no heading, list or quote marks, links as their text."""
    text = line.strip()
    for _ in range(4):
        stripped = _MARKERS.sub("", text, count=1).strip()
        if stripped == text:
            break
        text = stripped
    text = _WIKILINK.sub(lambda match: (match.group(2) or match.group(1).split("#")[0].split("/")[-1]).strip(), text)
    text = _LINK.sub(lambda match: match.group(1), text)
    text = _EMPHASIS.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def _text_lines(text: str) -> list[str]:
    """The plain, non-empty lines of a note's body; code fences and rules left out."""
    lines: list[str] = []
    for line in _content_lines(text):
        if _FENCE.match(line):
            continue
        plain = _plain_line(line)
        if plain and not _RULE.fullmatch(plain):
            lines.append(plain)
    return lines


def _repeats_title(line: str, title: str) -> bool:
    """True when a note's first line is its title again, so the preview should skip it.

    That is a heading that repeats the title, the line a title was made from
    (a long first line is cut at a word, so the line starts with the title),
    or either of those under a numbered name ("Plan the week 1").
    """
    line = line.casefold()
    for candidate in {title.casefold(), re.sub(r" \d{1,3}$", "", title).casefold()}:
        if not candidate:
            continue
        if line == candidate:
            return True
        # Titles cut from a long line are at least this long; a short title that
        # only begins the line ("Gym" before "Gym ideas for Monday") is not one.
        if len(candidate) >= _DERIVED_TITLE_CHARS // 3 and line.startswith(candidate):
            return True
    return False


def preview_of(text: str, title: str) -> str:
    """The first line of words in a note, for the list.

    A first line that repeats the title is skipped, as Notes on the iPhone
    does (see ``_repeats_title``).
    """
    for index, plain in enumerate(_text_lines(text)):
        if index == 0 and _repeats_title(plain, title):
            continue
        return plain if len(plain) <= PREVIEW_CHARS else plain[: PREVIEW_CHARS - 1].rstrip() + _ELLIPSIS
    return ""


def _title_from_text(text: str) -> str:
    """A title from the note's first line of words, the way Notes on the iPhone names a note."""
    for plain in _text_lines(text):
        if len(plain) > _DERIVED_TITLE_CHARS:
            cut = plain[: _DERIVED_TITLE_CHARS + 1]
            space = cut.rfind(" ")
            plain = cut[:space] if space >= _DERIVED_TITLE_CHARS // 3 else plain[:_DERIVED_TITLE_CHARS]
        title = safe_title(plain)
        if title:
            return title
    return ""


def note_version(data: bytes) -> str:
    """What an edit must match: the SHA-256 of the note's bytes."""
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class _NoteFile:
    data: bytes
    size: int
    modified_at: float
    mode: int


def _read_note_file(folder: str, name: str, limit: int | None = None) -> _NoteFile:
    """One note, read through a descriptor opened without following links.

    With ``limit`` only that many bytes are read (a preview); without it the
    whole note, refused past ``MAX_NOTE_BYTES``. The path is not consulted
    again once the descriptor is open.
    """
    try:
        fd = os.open(os.path.join(folder, name), os.O_RDONLY | _NOFOLLOW | _CLOEXEC | _NONBLOCK)
    except FileNotFoundError:
        raise NotesError(404, "note not found", reason="gone") from None
    except OSError as exc:
        if exc.errno in _LINK_ERRNOS:
            raise NotesError(403, "links are not followed", reason="not_allowed") from None
        raise NotesError(500, "could not read the note") from exc
    chunks: list[bytes] = []
    try:
        info = os.fstat(fd)
        if not stat_module.S_ISREG(info.st_mode):
            raise NotesError(404, "note not found", reason="gone")
        if limit is None and info.st_size > MAX_NOTE_BYTES:
            raise NotesError(413, "note too large", reason="too_large")
        wanted = limit if limit is not None else MAX_NOTE_BYTES + 1
        while wanted > 0:
            chunk = os.read(fd, min(wanted, 1 << 16))
            if not chunk:
                break
            chunks.append(chunk)
            wanted -= len(chunk)
    except OSError as exc:
        raise NotesError(500, "could not read the note") from exc
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if limit is None and len(data) > MAX_NOTE_BYTES:
        raise NotesError(413, "note too large", reason="too_large")
    return _NoteFile(
        data=data,
        size=len(data) if limit is None else info.st_size,
        modified_at=info.st_mtime,
        mode=stat_module.S_IMODE(info.st_mode),
    )


def _note_payload(place: NotesVault, name: str, data: bytes, modified_at: float) -> dict[str, object]:
    try:
        text = data.decode("utf-8")
        editable = _NUL not in text
    except UnicodeDecodeError:
        # Shown as well as it can be; saving it back from the phone would garble the bytes.
        text = data.decode("utf-8", errors="replace")
        editable = False
    return {
        "vault": place.vault.name,
        "phone_vault": place.vault.phone_name,
        "folder": NOTES_FOLDER,
        "name": name,
        "title": title_of(name),
        "path": f"{NOTES_FOLDER}/{name}",
        "text": text,
        "size": len(data),
        "modified_at": modified_at,
        "version": note_version(data),
        "editable": editable,
    }


def _encode(text: object) -> bytes:
    if not isinstance(text, str):
        raise NotesError(400, "text must be a string")
    if _NUL in text:
        raise NotesError(400, "the note holds a character that cannot be saved")
    try:
        data = text.encode("utf-8")
    except UnicodeEncodeError:
        raise NotesError(400, "the note holds a character that cannot be saved") from None
    if len(data) > MAX_NOTE_BYTES:
        raise NotesError(413, "note too large", reason="too_large")
    return data


def _sync_folder(folder: str) -> None:
    """Best effort: make the swap itself durable."""
    try:
        fd = os.open(folder, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _CLOEXEC)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write_atomically(
    folder: str,
    name: str,
    data: bytes,
    *,
    mode: int | None = None,
    check: Callable[[], None] | None = None,
) -> float:
    """Write ``data`` to a hidden temporary file in ``folder``, then swap it in as ``name`` in one step.

    ``check`` runs once the bytes are on disk, right before the swap, so a
    change made on the Mac in the meantime still stops the save. Returns the
    note's new modification time.
    """
    temp = os.path.join(folder, f".hermes-note-{secrets.token_hex(8)}.tmp")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC, 0o644)
    except OSError as exc:
        raise NotesError(500, "could not save the note") from exc
    try:
        try:
            if mode is not None:
                os.fchmod(fd, mode)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view) :]
            os.fsync(fd)
        finally:
            os.close(fd)
        if check is not None:
            check()
        os.replace(temp, os.path.join(folder, name))
    except BaseException as exc:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        if isinstance(exc, OSError):
            raise NotesError(500, "could not save the note") from exc
        raise
    _sync_folder(folder)
    try:
        return os.stat(os.path.join(folder, name), follow_symlinks=False).st_mtime
    except OSError:
        return time.time()


def _release_claim(folder: str, name: str) -> None:
    """Remove the empty file that held a name for a save that then failed."""
    path = os.path.join(folder, name)
    with contextlib.suppress(OSError):
        info = os.lstat(path)
        if stat_module.S_ISREG(info.st_mode) and info.st_size == 0:
            os.unlink(path)


def list_notes(*, home: Path | None = None, limit: int = MAX_LIST, now: float | None = None) -> dict[str, object]:
    """The notes in the folder, newest first, each with a one-line preview.

    Never raises for a missing vault or folder: ``available`` and ``exists``
    say what is there, and ``error`` (with a ``reason`` code) why not.
    """
    now = time.time() if now is None else now
    limit = max(1, min(int(limit), MAX_LIST))
    payload: dict[str, object] = {
        "available": False,
        "vault": None,
        "phone_vault": None,
        "chosen_by": None,
        "folder": NOTES_FOLDER,
        "exists": False,
        "notes": [],
        "total": 0,
        "scanned_at": now,
        "max_bytes": MAX_NOTE_BYTES,
    }
    try:
        place = choose_vault(home)
    except NotesError as exc:
        return {**payload, "error": exc.detail, "reason": exc.reason}
    payload.update(available=True, vault=place.vault.name, phone_vault=place.vault.phone_name, chosen_by=place.chosen_by)
    folder = place.folder
    found: list[tuple[float, str, int]] = []
    try:
        if not _folder_exists(folder):
            return payload
        with os.scandir(folder) as entries:
            for entry in entries:
                if not is_note_name(entry.name):
                    continue
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                found.append((info.st_mtime, entry.name, info.st_size))
    except NotesError as exc:
        return {**payload, "error": exc.detail, "reason": exc.reason}
    except OSError:
        return {**payload, "exists": True, "error": "could not read the notes folder", "reason": None}
    found.sort(key=lambda item: (-item[0], _fold(item[1])))
    notes: list[dict[str, object]] = []
    for modified_at, name, size in found[:limit]:
        title = title_of(name)
        try:
            head = _read_note_file(folder, name, limit=PREVIEW_BYTES).data
        except NotesError:
            continue  # gone, or swapped for something else, since the folder was read
        notes.append(
            {
                "name": name,
                "title": title,
                "path": f"{NOTES_FOLDER}/{name}",
                "modified_at": modified_at,
                "size": size,
                "preview": preview_of(head.decode("utf-8", errors="ignore"), title),
            }
        )
    return {**payload, "exists": True, "notes": notes, "total": len(found)}


def read_note(name: object, *, home: Path | None = None) -> dict[str, object]:
    """One note's text and version, for the phone's viewer and editor."""
    checked = _check_name(name)
    place = choose_vault(home)
    folder = place.folder
    if not _folder_exists(folder):
        raise NotesError(404, "note not found", reason="gone")
    note = _read_note_file(folder, checked)
    return _note_payload(place, checked, note.data, note.modified_at)


def _numbered_names(stem: str) -> list[str]:
    return [f"{stem}{NOTE_SUFFIX}", *(f"{stem} {number}{NOTE_SUFFIX}" for number in range(1, _MAX_NUMBERED))]


def create_note(title: object, text: object, *, home: Path | None = None) -> dict[str, object]:
    """Write a new note into the folder, creating the folder on the first save.

    The file is named after the title, or after the first line of text when
    there is no title. It never replaces a file: a taken name gets the next
    free one ("Gym ideas 1.md"). Returns the note as ``read_note`` does.
    """
    if title is None:
        title = ""
    if not isinstance(title, str):
        raise NotesError(400, "title must be a string")
    data = _encode(text)
    body = data.decode("utf-8")
    if not title.strip() and not body.strip():
        raise NotesError(400, "write a title or some text first")
    stem = safe_title(title) or _title_from_text(body) or UNTITLED
    place = choose_vault(home)
    folder = place.folder
    with _WRITE_LOCK:
        _ensure_folder(folder)
        try:
            taken = {_fold(existing) for existing in os.listdir(folder)}
        except OSError as exc:
            raise NotesError(500, "could not read the notes folder") from exc
        for candidate in _numbered_names(stem):
            if _fold(candidate) in taken:
                continue
            # Claim the name first: O_EXCL fails when anything already has it, so nothing is replaced.
            try:
                claim = os.open(
                    os.path.join(folder, candidate),
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC,
                    0o644,
                )
            except FileExistsError:
                continue
            except OSError as exc:
                raise NotesError(500, "could not save the note") from exc
            os.close(claim)
            try:
                modified_at = _write_atomically(folder, candidate, data)
            except BaseException:
                _release_claim(folder, candidate)
                raise
            return _note_payload(place, candidate, data, modified_at)
    raise NotesError(409, "too many notes have this title", reason="taken")


def save_note(name: object, text: object, version: object, *, home: Path | None = None) -> dict[str, object]:
    """Replace a note's text, but only while it is still the ``version`` the edit started from.

    A note that changed on the Mac since is refused with 409 and the current
    version, so the phone can keep its text and save it as a new note instead.
    """
    checked = _check_name(name)
    data = _encode(text)
    if not isinstance(version, str) or not version:
        raise NotesError(400, "version is required")
    place = choose_vault(home)
    folder = place.folder

    def still_unchanged(note: _NoteFile) -> None:
        found = note_version(note.data)
        if found != version:
            raise NotesError(
                409,
                "the note changed on the Mac after it was opened",
                reason="changed",
                version=found,
                modified_at=note.modified_at,
            )

    with _WRITE_LOCK:
        if not _folder_exists(folder):
            raise NotesError(404, "note not found", reason="gone")
        current = _read_note_file(folder, checked)
        still_unchanged(current)
        if not current.mode & stat_module.S_IWUSR:
            raise NotesError(403, "the note is read-only on the Mac", reason="read_only")
        if current.data == data:
            return _note_payload(place, checked, data, current.modified_at)
        modified_at = _write_atomically(
            folder,
            checked,
            data,
            mode=current.mode,
            check=lambda: still_unchanged(_read_note_file(folder, checked)),
        )
        return _note_payload(place, checked, data, modified_at)
