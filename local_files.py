"""Serve files Hermes produced on the host machine to the authenticated phone client.

Hermes' chat channel has no outbound attachment path: when the agent saves a
screenshot or an export it prints the absolute path. The PWA detects those paths
and asks this module for the bytes, so an image shows inline and any other file
gets a download card.

Security boundaries (all enforced here, tests in dashboard/tests):

* Only files under an explicit allowlist of roots are readable. The default
  list is the Hermes attachment/cache dirs and the user's Desktop, Downloads,
  Documents, Pictures and Movies. ``HERMES_PWA_FILE_ROOTS`` (os.pathsep
  separated) replaces the list.
* Paths are resolved with ``realpath`` before the root check, so symlinks and
  ``..`` segments cannot escape a root. A relative path is taken relative to
  the Hermes home (that is how Hermes names phone uploads), and still has to
  land inside a root. Dot-files and dot-directories *inside*
  a root are refused (``~/.hermes`` itself is a root; its own name is fine).
* Only regular files are served, up to ``MAX_FILE_BYTES``.
* The response media type comes from the file extension, never from content
  sniffing, and only a short allowlist (images, PDF, audio, video, plain text)
  is sent for inline display. Everything else, including HTML and SVG which can
  run script on the dashboard origin, is sent as ``attachment`` with the generic
  ``application/octet-stream`` type.
* Every response carries ``X-Content-Type-Options: nosniff`` and a sandboxing
  ``Content-Security-Policy`` so a served document cannot act on the origin.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

MAX_FILE_BYTES = 100 * 1024 * 1024

# Default roots: where Hermes stages uploads and writes its own output, plus
# the two folders it is told to save deliverables to. Documents, Pictures and
# Movies are deliberately not here (tax PDFs, the Photos library, personal
# video); opt in with HERMES_PWA_FILE_ROOTS when needed.
_DEFAULT_ROOT_SUFFIXES = (
    (".hermes", "attachments"),
    (".hermes", "cache"),
    (".hermes", "image_cache"),
    (".hermes", "audio_cache"),
    ("Desktop",),
    ("Downloads",),
)

# Roots that would expose credential stores or whole accounts are refused even
# when configured: the home directory itself, filesystem roots, and ~/Library
# (Keychains, Messages, Safari and Mail databases live there).
_FORBIDDEN_ROOT_SUFFIXES = (("Library",),)

# Package bundles are directories macOS shows as one item; their internals are
# regular files (Photos.sqlite, originals/*.jpeg) and never something Hermes
# hands over on purpose.
_BUNDLE_SUFFIXES = (".photoslibrary", ".app", ".framework", ".appex", ".bundle", ".plugin", ".keychain-db", ".keychain")

# Extension -> media type for files that may render inline in the browser.
_INLINE_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".markdown": "text/plain; charset=utf-8",
    ".csv": "text/plain; charset=utf-8",
    ".tsv": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".json": "text/plain; charset=utf-8",
    ".yaml": "text/plain; charset=utf-8",
    ".yml": "text/plain; charset=utf-8",
    ".toml": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".js": "text/plain; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".jsx": "text/plain; charset=utf-8",
    ".css": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8",
    ".sql": "text/plain; charset=utf-8",
    ".xml": "text/plain; charset=utf-8",
}

IMAGE_EXTENSIONS = frozenset(ext for ext, mime in _INLINE_TYPES.items() if mime.startswith("image/"))

SAFE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    # No script, no forms, no top-level navigation from a served document.
    "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
}


class FileAccessError(Exception):
    """Refused request. ``status`` is the HTTP status to answer with."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class ServedFile:
    path: Path
    size: int
    media_type: str
    inline: bool
    download_name: str


def _home() -> Path:
    return Path(os.environ.get("HERMES_PWA_FILE_HOME") or Path.home()).expanduser()


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or _home() / ".hermes").expanduser()


def _forbidden_root(real: Path) -> bool:
    home = Path(os.path.realpath(_home()))
    if real == home or real == home.parent or real == Path(real.anchor):
        return True
    if real in (Path("/Users"), Path("/System"), Path("/private"), Path("/var"), Path("/etc")):
        return True
    for parts in _FORBIDDEN_ROOT_SUFFIXES:
        forbidden = home.joinpath(*parts)
        if real == forbidden or real.is_relative_to(forbidden):
            return True
    return False


def allowed_roots() -> list[Path]:
    """Real paths of the roots files may be served from.

    Missing directories are skipped; roots that would expose the whole account
    (see ``_forbidden_root``) are skipped too, even when configured.
    """
    raw = os.environ.get("HERMES_PWA_FILE_ROOTS")
    candidates: Iterable[Path]
    if raw and raw.strip():
        candidates = (Path(p).expanduser() for p in raw.split(os.pathsep) if p.strip())
    else:
        home = _home()
        candidates = (home.joinpath(*parts) for parts in _DEFAULT_ROOT_SUFFIXES)
    roots: list[Path] = []
    for candidate in candidates:
        try:
            real = Path(os.path.realpath(candidate))
        except OSError:
            continue
        if real.is_dir() and not _forbidden_root(real):
            roots.append(real)
    return roots


def _has_hidden_segment(relative: Path) -> bool:
    return any(part.startswith(".") for part in relative.parts)


def _inside_bundle(relative: Path) -> bool:
    return any(part.lower().endswith(_BUNDLE_SUFFIXES) for part in relative.parts[:-1])


def _verify_same_file(real: Path, expected: os.stat_result) -> None:
    """Open without following a final symlink and check it is the file we vetted.

    Narrows the window between the checks above and the response reading the
    path again. The remaining race is only open to a local process running as
    the same user, which can already read the file directly.
    """
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(real, flags)
    except OSError as exc:
        raise FileAccessError(403, f"cannot read file: {exc.strerror or exc}") from None
    try:
        current = os.fstat(fd)
    finally:
        os.close(fd)
    if (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino):
        raise FileAccessError(409, "file changed while being checked")


def resolve_served_file(raw_path: str) -> ServedFile:
    """Validate ``raw_path`` against the allowlist and describe how to serve it."""
    text = (raw_path or "").strip()
    if not text:
        raise FileAccessError(400, "path is required")
    if "\x00" in text:
        raise FileAccessError(400, "invalid path")
    if text.startswith("~"):
        text = str(_home() / text[1:].lstrip("/"))
    elif not os.path.isabs(text):
        # Hermes writes `@file:attachments/<name>` for phone uploads, relative to
        # its home directory; resolve the same way so those cards work. Any
        # other relative path lands outside the roots and is refused below, and
        # a relative path has no business climbing with `..` at all.
        if ".." in Path(text).parts:
            raise FileAccessError(400, "invalid path")
        text = str(_hermes_home() / text)

    real = Path(os.path.realpath(text))
    root = next((r for r in allowed_roots() if real == r or real.is_relative_to(r)), None)
    if root is None or real == root:
        raise FileAccessError(403, "path is outside the folders Hermes Mobile may read")
    relative = real.relative_to(root)
    if _has_hidden_segment(relative):
        raise FileAccessError(403, "hidden files are not served")
    if _inside_bundle(relative):
        raise FileAccessError(403, "files inside app and library bundles are not served")

    try:
        stat = real.stat()
    except FileNotFoundError:
        raise FileAccessError(404, "file not found") from None
    except OSError as exc:
        raise FileAccessError(403, f"cannot read file: {exc.strerror or exc}") from None
    if not real.is_file():
        raise FileAccessError(404, "not a regular file")
    if stat.st_size > MAX_FILE_BYTES:
        raise FileAccessError(413, "file is too large to send")
    _verify_same_file(real, stat)

    inline_type = _INLINE_TYPES.get(real.suffix.lower())
    return ServedFile(
        path=real,
        size=stat.st_size,
        media_type=inline_type or "application/octet-stream",
        inline=inline_type is not None,
        download_name=real.name,
    )


def response_headers(served: ServedFile) -> dict[str, str]:
    """Headers for the FileResponse, including a safe Content-Disposition."""
    # RFC 6266: ASCII fallback plus UTF-8 encoded filename*.
    import re
    from urllib.parse import quote

    # ASCII fallback: printable characters only, no quotes or backslashes, so the
    # on-disk name (which the model may have chosen) cannot break the header.
    ascii_name = served.download_name.encode("ascii", "replace").decode("ascii")
    ascii_name = re.sub(r"[^\x20-\x7e]", "_", ascii_name).replace("\\", "_").replace('"', "")
    disposition = "inline" if served.inline else "attachment"
    headers = dict(SAFE_HEADERS)
    headers["Content-Disposition"] = (
        f"{disposition}; filename=\"{ascii_name or 'file'}\"; filename*=UTF-8''{quote(served.download_name)}"
    )
    return headers


def describe(served: ServedFile) -> dict[str, object]:
    """JSON description for the client's file card."""
    return {
        "name": served.download_name,
        "size": served.size,
        "mime": served.media_type.split(";", 1)[0],
        "inline": served.inline,
        "image": served.path.suffix.lower() in IMAGE_EXTENSIONS,
    }
