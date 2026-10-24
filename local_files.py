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

MAX_FILE_BYTES = 200 * 1024 * 1024

_DEFAULT_ROOT_SUFFIXES = (
    (".hermes", "attachments"),
    (".hermes", "cache"),
    (".hermes", "image_cache"),
    (".hermes", "audio_cache"),
    ("Desktop",),
    ("Downloads",),
    ("Documents",),
    ("Pictures",),
    ("Movies",),
)

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


def allowed_roots() -> list[Path]:
    """Real paths of the roots files may be served from. Missing dirs are skipped."""
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
        if real.is_dir():
            roots.append(real)
    return roots


def _has_hidden_segment(relative: Path) -> bool:
    return any(part.startswith(".") for part in relative.parts)


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
    if _has_hidden_segment(real.relative_to(root)):
        raise FileAccessError(403, "hidden files are not served")

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
    from urllib.parse import quote

    ascii_name = served.download_name.encode("ascii", "replace").decode("ascii").replace('"', "")
    disposition = "inline" if served.inline else "attachment"
    headers = dict(SAFE_HEADERS)
    headers["Content-Disposition"] = (
        f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(served.download_name)}"
    )
    headers["Content-Length"] = str(served.size)
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
