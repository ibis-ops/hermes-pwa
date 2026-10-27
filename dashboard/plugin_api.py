from __future__ import annotations

import base64
import inspect
import json
import logging
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import Request as UrlRequest, urlopen

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

router = APIRouter()
_file_log = logging.getLogger("hermes_pwa.files")

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    # Appended, not prepended: the plugin directory must never shadow Hermes'
    # own modules (a planted hermes_cli/ here would otherwise replace auth).
    sys.path.append(str(_PLUGIN_ROOT))

from local_files import (  # noqa: E402
    FileAccessError,
    describe as describe_local_file,
    iter_file as iter_local_file,
    open_served_file,
    resolve_served_file,
    response_headers as local_file_headers,
)
from agent_history import cached_history as agent_cached_history  # noqa: E402
import pwa_speech  # noqa: E402
import bot_graph  # noqa: E402
import pwa_router  # noqa: E402
import obsidian_sync  # noqa: E402
from obsidian_activity import (  # noqa: E402
    NoteAccessError,
    cached_activity as obsidian_cached_activity,
    clear_cache as obsidian_clear_cache,
    read_note as obsidian_read_note,
)
from push_common import (  # noqa: E402
    load_pending_approvals,
    load_push_subscriptions,
    push_sender_availability,
    push_subscriptions_path,
    safe_subscription_record,
    sanitize_error_text,
    save_push_subscriptions,
    send_web_push_record,
    state_file_lock,
    update_push_subscription_records,
    upsert_push_subscription,
)

try:  # Optional during rsync/prototype deployments.
    from pywebpush import WebPushException, webpush  # type: ignore
except Exception:  # pragma: no cover - depends on host optional deps
    WebPushException = Exception  # type: ignore
    webpush = None  # type: ignore

_DIST_ROOT = (Path(__file__).resolve().parent / "dist" / "mobile").resolve()
_APP_SCOPE = "/api/plugins/hermes-pwa/app/"
_UPDATE_SOURCE = "npm"
_UPDATE_PACKAGE = "hermes-pwa"
_INSTALL_MARKER_NAMES = (
    ".hermes-pwa-install.json",
    ".hermes-plugin-install.json",
)

_BACKUP_ARCHIVE_SUFFIXES = (".zip", ".tgz", ".tar.gz")

# Request bodies on the JSON routes are tiny (a push subscription, an id); a
# body over this is refused before it is parsed.
MAX_JSON_BODY_BYTES = 64 * 1024

# Every JSON data route answers with these: the body is private to this
# origin, must not be framed, embedded by another origin, sniffed, or cached.
_DATA_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
}


def _data_response(payload: object, status_code: int = 200) -> JSONResponse:
    """A JSON response for data the dashboard session may read (see ``_DATA_HEADERS``)."""
    return JSONResponse(payload, status_code=status_code, headers=dict(_DATA_HEADERS))


_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _reject_cross_site_write(request: Request) -> None:
    """Refuse state-changing requests that did not come from this origin.

    SameSite=Lax cookies do not isolate tailnet nodes: ``ts.net`` is on the
    Public Suffix List, so every ``*.<tailnet>.ts.net`` host is the same site as
    the dashboard and a page on any other node could POST here with the cookie.
    Browsers always send ``Sec-Fetch-Site`` (and ``Origin`` on cross-origin
    POSTs); non-browser clients send neither and are not CSRF targets.
    """
    if request.method in _SAFE_METHODS:
        return
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    if fetch_site and fetch_site not in ("same-origin", "none"):
        raise HTTPException(status_code=403, detail="cross-site request refused")
    origin = request.headers.get("origin")
    if origin:
        from urllib.parse import urlsplit

        origin_host = (urlsplit(origin).netloc or "").lower()
        request_host = (request.headers.get("host") or "").lower()
        forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip().lower()
        if origin_host not in {request_host, forwarded_host} or not origin_host:
            raise HTTPException(status_code=403, detail="cross-site request refused")
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type and content_type != "application/json":
            # A cross-origin "simple" request can only carry form or text bodies;
            # insisting on JSON forces a preflight this API never answers.
            raise HTTPException(status_code=415, detail="application/json required")


def _require_dashboard_auth(request: Request) -> None:
    """Defense-in-depth auth check for sensitive plugin API routes.

    Hermes' dashboard normally protects `/api/*` before plugin routes run. Keep
    an explicit check here too so this plugin does not rely solely on mount-time
    namespace policy for endpoints that expose local transcripts, backups, or
    push subscription state.
    """
    _reject_cross_site_write(request)
    try:
        from hermes_cli.web_server import _require_token  # type: ignore
    except Exception as exc:  # pragma: no cover - production Hermes provides it
        if getattr(request.app.state, "auth_required", False) and getattr(request.state, "session", None) is not None:
            return
        raise HTTPException(status_code=401, detail="Unauthorized") from exc
    result = _require_token(request)
    if inspect.isawaitable(result):
        # A future async Hermes would return a coroutine that never raises;
        # treat that as "could not verify" rather than "verified".
        result.close() if hasattr(result, "close") else None
        raise HTTPException(status_code=401, detail="Unauthorized")

_MESSAGING_SOURCES = {
    "api_server",
    "bluebubbles",
    "discord",
    "email",
    "homeassistant",
    "matrix",
    "mattermost",
    "qqbot",
    "signal",
    "slack",
    "sms",
    "telegram",
    "webhook",
    "wecom",
    "weixin",
    "whatsapp",
    "yuanbao",
}

_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
}


def _safe_dist_path(relative_path: str) -> Path:
    candidate = (_DIST_ROOT / relative_path).resolve()
    if not candidate.is_relative_to(_DIST_ROOT):
        raise HTTPException(status_code=404, detail="Not found")
    return candidate


def _headers_for(path: Path) -> dict[str, str]:
    name = path.name
    suffix = path.suffix.lower()
    headers: dict[str, str] = {
        "X-Content-Type-Options": "nosniff",
    }
    if suffix in (".html", ".htm"):
        headers["X-Frame-Options"] = "DENY"
        headers["Content-Security-Policy"] = "frame-ancestors 'none'"

    if name == "index.html":
        headers["Cache-Control"] = "no-store"
    elif name == "service-worker.js":
        headers["Cache-Control"] = "no-cache"
        headers["Service-Worker-Allowed"] = _APP_SCOPE
    elif name == "manifest.json":
        headers["Cache-Control"] = "no-cache"
    elif "/assets/" in path.as_posix():
        headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        headers["Cache-Control"] = "public, max-age=86400"

    return headers


def _file_response(path: Path) -> FileResponse:
    media_type = (
        "application/manifest+json"
        if path.name == "manifest.json"
        else _MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
    )
    return FileResponse(path, media_type=media_type, headers=_headers_for(path))


def _public_url_from_config_text(text: str) -> str | None:
    """Read ``dashboard.public_url`` from config.yaml text without a YAML parser.

    Hermes ships its own YAML stack, so a plain ``yaml`` import is not
    guaranteed inside the dashboard process. This only looks at the direct
    children of a top-level ``dashboard:`` block, which is where Hermes keeps
    the key; anything fancier (anchors, flow mappings) is out of scope.
    """
    in_dashboard = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        if indent == 0:
            in_dashboard = raw.split(":", 1)[0].strip() == "dashboard" and ":" in raw
            continue
        if in_dashboard and indent == 2 and stripped.startswith("public_url:"):
            value = stripped.split(":", 1)[1].strip()
            if value[:1] in ("'", '"'):
                quote_char = value[0]
                end = value.find(quote_char, 1)
                value = value[1:end] if end > 0 else value[1:]
            elif " #" in value:
                value = value.split(" #", 1)[0].strip()
            return value.strip() or None
    return None


def _raw_public_url() -> str:
    """Operator-configured public URL, from the same sources Hermes itself uses.

    Order: ``HERMES_DASHBOARD_PUBLIC_URL`` env, then Hermes' own resolver when
    the plugin runs inside the dashboard, then ``dashboard.public_url`` read
    straight from ``config.yaml``.
    """
    raw = os.environ.get("HERMES_DASHBOARD_PUBLIC_URL", "").strip()
    if raw:
        return raw
    try:
        from hermes_cli.dashboard_auth.prefix import resolve_public_url  # type: ignore[import-not-found]

        raw = str(resolve_public_url() or "").strip()
    except Exception:
        raw = ""
    if raw:
        return raw
    try:
        text = (_hermes_home() / "config.yaml").read_text(encoding="utf-8")
    except OSError:
        return ""
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:
        return _public_url_from_config_text(text) or ""
    try:
        data = yaml.safe_load(text) or {}
    except Exception:
        return ""
    dashboard = data.get("dashboard") if isinstance(data, dict) else None
    value = dashboard.get("public_url") if isinstance(dashboard, dict) else None
    return value.strip() if isinstance(value, str) else ""


def _configured_public_url() -> str | None:
    """``dashboard.public_url`` when it names a host a phone could reach.

    Returns ``None`` when nothing is configured, the value is not an http(s)
    URL, or it points at loopback (then it adds nothing over the request's own
    origin). A path prefix is kept, since Hermes mounts under it.
    """
    raw = _raw_public_url()
    if not raw:
        return None
    parsed = urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or not parsed.hostname:
        return None
    if _is_localhost(parsed.hostname):
        return None
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"


def _origin(request: Request) -> str:
    """Origin to build phone-facing links from.

    The Mobile tab is usually opened on the machine running Hermes, so the
    request origin is a loopback address the phone cannot reach. When the
    operator configured ``dashboard.public_url`` (a Tailscale name, a reverse
    proxy host), links and the QR code use that instead.
    """
    request_origin = str(request.base_url).rstrip("/")
    if _is_localhost(request.url.hostname or ""):
        configured = _configured_public_url()
        if configured:
            return configured
    return request_origin


def _public_mobile_base(request: Request) -> str:
    """Public static PWA shell URL.

    Dashboard plugin assets under /dashboard-plugins/ are intentionally public so
    browser manifest and service-worker fetches can work without custom auth
    headers. The mobile app can still call protected /api endpoints after load.
    """
    return f"{_origin(request)}/dashboard-plugins/hermes-pwa/dist/mobile"


def _app_url(request: Request) -> str:
    return f"{_public_mobile_base(request)}/index.html"


def _manifest_url(request: Request) -> str:
    return f"{_public_mobile_base(request)}/manifest.json"


def _service_worker_url(request: Request) -> str:
    return f"{_public_mobile_base(request)}/service-worker.js"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_package_version() -> str:
    package_path = _PLUGIN_ROOT / "package.json"
    try:
        data = json.loads(package_path.read_text(encoding="utf-8"))
        version = data.get("version")
        return str(version) if version else "0.0.0"
    except Exception:
        return "0.0.0"


def _parse_semver(value: str) -> tuple[int, int, int, str]:
    raw = str(value or "").strip().lstrip("v")
    core, _, suffix = raw.partition("-")
    parts = core.split(".")
    nums: list[int] = []
    for part in parts[:3]:
        digits = "".join(ch for ch in part if ch.isdigit())
        try:
            nums.append(int(digits or "0"))
        except ValueError:
            nums.append(0)
    while len(nums) < 3:
        nums.append(0)
    return nums[0], nums[1], nums[2], suffix


def _is_newer_version(latest: str | None, current: str) -> bool:
    if not latest:
        return False
    return _parse_semver(latest)[:3] > _parse_semver(current)[:3]


def _read_install_marker() -> dict[str, object]:
    for name in _INSTALL_MARKER_NAMES:
        path = _PLUGIN_ROOT / name
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}
    return {}


def _detect_install_method() -> str:
    marker = _read_install_marker()
    method = marker.get("install_method")
    if method in {"npm", "npx", "npm-symlink"}:
        return "npm"
    if method == "git":
        return "git"
    if (_PLUGIN_ROOT / ".git").exists():
        return "git"
    return "unknown"


def _fetch_npm_latest_version(package_name: str = _UPDATE_PACKAGE, timeout: float = 2.5) -> str:
    url = f"https://registry.npmjs.org/{quote(package_name)}/latest"
    req = UrlRequest(
        url,
        headers={"Accept": "application/json", "User-Agent": "hermes-pwa-update-check/0.1"},
    )
    with urlopen(req, timeout=timeout) as resp:  # nosec B310 - fixed npm registry endpoint
        data = json.loads(resp.read().decode("utf-8"))
    version = data.get("version")
    if not isinstance(version, str) or not version:
        raise ValueError("npm latest response has no version")
    return version


def _manual_update_instructions() -> list[dict[str, object]]:
    return [
        {
            "id": "web-ui-force-reinstall",
            "label": "Hermes Web UI / Git URL",
            "steps": [
                "Open Hermes Web UI → Plugins",
                "Use Install from GitHub / Git URL",
                "Enter owner/repo or owner/repo/path-to-plugin",
                "Enable Force reinstall",
                "Enable after install",
                "Click Install",
                "Restart Hermes Dashboard/gateway if needed",
            ],
        },
        {
            "id": "npx-force-reinstall",
            "label": "npm / npx",
            "command": "npx -y hermes-pwa@latest install --force",
            "steps": [
                "Run the command on the Hermes host",
                "Restart Hermes Dashboard/gateway if needed",
            ],
        },
    ]


def _build_update_check_response(fetch_latest=None) -> dict[str, object]:
    if fetch_latest is None:
        fetch_latest = _fetch_npm_latest_version
    current = _read_package_version()
    install_method = _detect_install_method()
    checked_at = _utc_now_iso()
    try:
        latest = fetch_latest()
    except Exception:
        return {
            "ok": False,
            "current": current,
            "latest": None,
            "source": _UPDATE_SOURCE,
            "update_available": False,
            "can_apply": False,
            "manual_required": False,
            "install_method": install_method,
            "error": "check-failed",
            "message": "Unable to check npm latest version right now.",
            "checked_at": checked_at,
            "instructions": [],
        }

    update_available = _is_newer_version(latest, current)
    return {
        "ok": True,
        "current": current,
        "latest": latest,
        "source": _UPDATE_SOURCE,
        "update_available": update_available,
        "can_apply": False,
        "manual_required": update_available,
        "install_method": install_method,
        "checked_at": checked_at,
        "instructions": _manual_update_instructions() if update_available else [],
    }


# The dashboard asks on every connect; the registry is asked at most once per
# window. A failed check is retried sooner so an outage does not hide a
# release for six hours.
UPDATE_CHECK_CACHE_SECONDS = 6 * 60 * 60
UPDATE_CHECK_FAILURE_CACHE_SECONDS = 10 * 60
_update_check_cache: tuple[float, dict[str, object]] | None = None
_update_check_lock = threading.Lock()


def _cached_update_check(fetch_latest=None, now: float | None = None) -> dict[str, object]:
    """``_build_update_check_response`` reused for a while; ``cached`` says which it was."""
    global _update_check_cache
    now = time.monotonic() if now is None else now
    with _update_check_lock:
        hit = _update_check_cache
        if hit is not None:
            ttl = UPDATE_CHECK_CACHE_SECONDS if hit[1].get("ok") else UPDATE_CHECK_FAILURE_CACHE_SECONDS
            if now - hit[0] < ttl:
                return {**hit[1], "cached": True}
        body = _build_update_check_response(fetch_latest)
        _update_check_cache = (now, body)
        return {**body, "cached": False}


def _clear_update_check_cache() -> None:
    global _update_check_cache
    with _update_check_lock:
        _update_check_cache = None


def _is_localhost(host: str) -> bool:
    return host in ("localhost", "127.0.0.1", "::1")


def _is_private_ip(host: str) -> bool:
    """Return True if host looks like a private IPv4 address."""
    try:
        parts = host.split(".")
        if len(parts) != 4:
            return False
        octets = [int(p) for p in parts]
        if not all(0 <= o <= 255 for o in octets):
            return False
        # 10.x.x.x, 172.16-31.x.x, 192.168.x.x
        if octets[0] == 10:
            return True
        if octets[0] == 172 and 16 <= octets[1] <= 31:
            return True
        if octets[0] == 192 and octets[1] == 168:
            return True
        return False
    except (ValueError, AttributeError):
        return False


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser().resolve()


def _profile_home(profile: str | None = None) -> Path:
    """Resolve a Hermes profile home for read-only PWA plugin helpers."""
    home = _hermes_home()
    name = (profile or "default").strip() or "default"
    if name in {"default", "main"}:
        return home
    # Profile names are user-facing identifiers, not paths. Reject separators so
    # a query parameter cannot escape ~/.hermes/profiles/.
    if "/" in name or "\\" in name or name in {".", ".."}:
        return home / "profiles" / "__invalid__"
    return home / "profiles" / name


def _timestamp(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _session_row(conn: sqlite3.Connection, session_id: str) -> dict[str, object] | None:
    cursor = conn.execute(
        """
        SELECT s.*,
               COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), s.started_at) AS last_active
        FROM sessions s
        WHERE s.id = ?
        """,
        (session_id,),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def _lineage_root(conn: sqlite3.Connection, session_id: str) -> str | None:
    """Return the Desktop/core compression root for a stored session id.

    Do not blindly walk every ``parent_session_id``. Hermes also uses parent
    links for branches/delegates, and collapsing those into one Telegram row is
    the exact class of bug the PWA must avoid. Match core ``SessionDB``: a
    lineage edge exists only when the parent ended with ``compression`` and the
    child started after that end timestamp.
    """
    current = session_id
    root = session_id
    seen: set[str] = set()
    for _ in range(100):
        if current in seen:
            break
        seen.add(current)
        row = _session_row(conn, current)
        if not row:
            break
        parent = row.get("parent_session_id")
        if not isinstance(parent, str) or not parent:
            root = current
            break
        parent_row = _session_row(conn, parent)
        if not parent_row:
            root = current
            break
        started_at = row.get("started_at")
        parent_ended_at = parent_row.get("ended_at")
        is_compression_edge = (
            parent_row.get("end_reason") == "compression"
            and isinstance(started_at, (int, float))
            and isinstance(parent_ended_at, (int, float))
            and started_at >= parent_ended_at
        )
        if not is_compression_edge:
            root = current
            break
        root = parent
        current = parent
    return root


def _sort_timestamp(row: dict[str, object]) -> float:
    value = row.get("last_active")
    return float(value) if isinstance(value, (int, float)) else 0.0


def _is_backup_archive(path: Path) -> bool:
    name = path.name.lower()
    return any(name.endswith(suffix) for suffix in _BACKUP_ARCHIVE_SUFFIXES)


def _walk_tree_size(path: Path) -> int:
    total = 0
    try:
        iterator = path.rglob("*")
    except OSError:
        return 0
    for child in iterator:
        if not child.is_file():
            continue
        try:
            total += child.stat().st_size
        except OSError:
            continue
    return total


# A backup directory can hold thousands of files; its size is walked at most
# once per minute per (path, mtime) instead of on every request.
TREE_SIZE_CACHE_SECONDS = 60.0
_TREE_SIZE_CACHE_MAX_ENTRIES = 256
_tree_size_cache: dict[tuple[str, float], tuple[float, int]] = {}
_tree_size_lock = threading.Lock()


def _safe_tree_size(path: Path, stat: os.stat_result | None = None) -> int:
    try:
        stat = stat or path.stat()
    except OSError:
        return 0
    if not path.is_dir():
        return stat.st_size
    key = (str(path), stat.st_mtime)
    now = time.monotonic()
    with _tree_size_lock:
        hit = _tree_size_cache.get(key)
        if hit and now - hit[0] < TREE_SIZE_CACHE_SECONDS:
            return hit[1]
    total = _walk_tree_size(path)
    with _tree_size_lock:
        if len(_tree_size_cache) >= _TREE_SIZE_CACHE_MAX_ENTRIES:
            stale = [k for k, v in _tree_size_cache.items() if now - v[0] >= TREE_SIZE_CACHE_SECONDS]
            for k in stale:
                del _tree_size_cache[k]
            if len(_tree_size_cache) >= _TREE_SIZE_CACHE_MAX_ENTRIES:
                _tree_size_cache.clear()
        _tree_size_cache[key] = (now, total)
    return total


def _backup_entry(path: Path, kind: str) -> dict[str, object] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return {
        "id": path.name,
        "name": path.name,
        "kind": kind,
        "created_at": stat.st_mtime,
        "bytes": _safe_tree_size(path, stat),
    }


def _backup_entries(limit: int = 20) -> list[dict[str, object]]:
    """List actual Hermes/PWA backup artifacts without exposing secret contents."""
    home = _hermes_home()
    backup_dir = home / "backups"
    seen: dict[str, dict[str, object]] = {}

    def add(path: Path, kind: str) -> None:
        entry = _backup_entry(path, kind)
        if not entry:
            return
        # Key by resolved path string so a glob duplicate does not show twice.
        try:
            key = str(path.resolve())
        except OSError:
            key = str(path)
        seen[key] = entry

    if backup_dir.is_dir():
        try:
            children = list(backup_dir.iterdir())
        except OSError:
            children = []
        for child in children:
            if child.is_dir():
                add(child, "directory")
            elif child.is_file() and _is_backup_archive(child):
                add(child, "archive")

    # `hermes backup` defaults to ~/hermes-backup-*.zip, not ~/.hermes/backups/.
    try:
        home_dir = Path.home()
        for child in home_dir.glob("hermes-backup-*.zip"):
            if child.is_file():
                add(child, "archive")
    except OSError:
        pass

    def created_at(row: dict[str, object]) -> float:
        value = row.get("created_at")
        return float(value) if isinstance(value, (int, float)) else 0.0

    rows = list(seen.values())
    rows.sort(key=created_at, reverse=True)
    return rows[:limit]


@router.get("/backups", dependencies=[Depends(_require_dashboard_auth)])
def backups() -> JSONResponse:
    rows = _backup_entries()
    return _data_response({"backups": rows, "total": len(rows)})


def _messaging_binding_sessions(profile: str | None = None) -> list[dict[str, object]]:
    """Expose current gateway messaging bindings as openable session rows.

    Scoped to one Hermes profile. Profiles without a messaging gateway/session
    binding return no rows, so worker/internal profiles do not inherit the
    default profile's Telegram chat in the PWA session list.
    """
    home = _profile_home(profile)
    store_path = home / "sessions" / "sessions.json"
    db_path = home / "state.db"
    if not store_path.exists() or not db_path.exists():
        return []
    try:
        data = json.loads(store_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, dict):
        return []

    rows: list[dict[str, object]] = []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return []
    try:
        for key, value in data.items():
            if not isinstance(value, dict):
                continue
            platform = str(value.get("platform") or "").strip().lower()
            session_id = str(value.get("session_id") or "").strip()
            if not platform or platform not in _MESSAGING_SOURCES or not session_id:
                continue
            db_row = _session_row(conn, session_id) or {}
            last_active = _timestamp(value.get("updated_at")) or db_row.get("last_active") or db_row.get("started_at") or 0
            lineage_root = _lineage_root(conn, session_id)
            title = db_row.get("title") if isinstance(db_row.get("title"), str) else None
            current_source = str(db_row.get("source") or "").strip().lower() or platform
            profile_name = (profile or "default").strip() or "default"
            rows.append(
                {
                    "id": session_id,
                    "_lineage_root_id": lineage_root if lineage_root and lineage_root != session_id else None,
                    "title": title or f"{platform.title()} conversation",
                    # Active bindings are user-facing messaging conversations even
                    # when the stored head row was later continued by the TUI/PWA.
                    "source": platform,
                    "origin_source": platform,
                    "current_source": current_source,
                    "profile": profile_name,
                    "message_count": db_row.get("message_count") or 0,
                    "started_at": db_row.get("started_at") or last_active,
                    "last_active": last_active,
                    "updated_at": last_active,
                    "ended_at": db_row.get("ended_at"),
                    "is_active": True,
                    "active": True,
                    "has_active_messaging_binding": True,
                    "active_binding_platform": platform,
                }
            )
    finally:
        conn.close()
    rows.sort(key=_sort_timestamp, reverse=True)
    return rows


@router.get("/sessions/messaging-bindings", dependencies=[Depends(_require_dashboard_auth)])
def messaging_bindings(profile: str = "default") -> JSONResponse:
    rows = _messaging_binding_sessions(profile)
    return _data_response({"sessions": rows, "total": len(rows)})


def _push_availability() -> tuple[bool, str | None]:
    return push_sender_availability()


def _normalize_profile(value: object) -> str:
    text = str(value or "default").strip()
    return text or "default"


def _profile_matches(record: dict[str, object], profile: str) -> bool:
    return _normalize_profile(record.get("profile")) == _normalize_profile(profile)


def _find_push_record(record_id: str) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    records = load_push_subscriptions()
    for record in records:
        if str(record.get("id") or "") == record_id:
            return records, record
    return records, None


def _mark_push_record(records: list[dict[str, object]], record: dict[str, object], **updates: object) -> None:
    """Persist ``updates`` on one subscription.

    Merged into a fresh read under the file lock rather than written from
    ``records``: that snapshot predates the push send and could otherwise
    overwrite a subscription registered meanwhile.
    """
    record.update(updates)
    record_id = str(record.get("id") or "")
    if record_id:
        update_push_subscription_records({record_id: dict(updates)})


def _send_push_record(record: dict[str, object], payload: dict[str, object]) -> None:
    send_web_push_record(record, payload)


@router.get("/actions/pending", dependencies=[Depends(_require_dashboard_auth)])
def pending_actions(profile: str = "default") -> JSONResponse:
    """Approvals the gateway is waiting on, newest first.

    Each item carries ``request_id`` (the gateway's own id for the request,
    when the hook supplied one) so the phone can answer by request rather
    than by session.
    """
    approvals = load_pending_approvals(profile=profile)
    return _data_response({"items": approvals, "total": len(approvals)})


@router.get("/push/status", dependencies=[Depends(_require_dashboard_auth)])
def push_status(profile: str = "default") -> JSONResponse:
    available, reason = _push_availability()
    subscriptions = [
        safe_subscription_record(record)
        for record in load_push_subscriptions()
        if _profile_matches(record, profile)
    ]
    body: dict[str, object] = {
        "available": available,
        "enabled": available,
        "subscriptions": subscriptions,
    }
    if reason:
        body["reason"] = reason
    public_key = os.environ.get("HERMES_PWA_VAPID_PUBLIC_KEY")
    if public_key:
        body["vapid_public_key"] = public_key
    return _data_response(body)


@router.post("/push/subscribe", dependencies=[Depends(_require_dashboard_auth)])
async def push_subscribe(request: Request, profile: str = "default") -> JSONResponse:
    body = await _json_body(request)
    try:
        subscription = body.get("subscription") if isinstance(body, dict) and "subscription" in body else body
        label = body.get("label") if isinstance(body, dict) else None
        user_agent_hint = request.headers.get("user-agent")
        safe = upsert_push_subscription(
            subscription,
            profile=profile,
            label=str(label) if label else None,
            user_agent_hint=user_agent_hint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _data_response({"ok": True, "subscription": safe, "id": safe["id"]})


async def _json_body(request: Request) -> object:
    """The parsed JSON body, refused with 413 past ``MAX_JSON_BODY_BYTES`` and 400 when malformed."""
    declared = request.headers.get("content-length", "").strip()
    if declared.isdigit() and int(declared) > MAX_JSON_BODY_BYTES:
        raise HTTPException(status_code=413, detail="request body too large")
    raw = await request.body()
    if len(raw) > MAX_JSON_BODY_BYTES:
        raise HTTPException(status_code=413, detail="request body too large")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid JSON body") from exc


@router.post("/push/unsubscribe", dependencies=[Depends(_require_dashboard_auth)])
async def push_unsubscribe(request: Request, profile: str = "default") -> JSONResponse:
    body = await _json_body(request)
    target_id = str(body.get("id") or "") if isinstance(body, dict) else ""
    endpoint = str(body.get("endpoint") or "") if isinstance(body, dict) else ""
    path = push_subscriptions_path()
    with state_file_lock(path):
        records = load_push_subscriptions(path)
        changed = False
        for record in records:
            if (target_id and record.get("id") == target_id) or (endpoint and record.get("endpoint") == endpoint):
                if not _profile_matches(record, profile):
                    raise HTTPException(status_code=404, detail="subscription not found")
                record["enabled"] = False
                record["updated_at"] = datetime.now(timezone.utc).timestamp()
                changed = True
        if changed:
            save_push_subscriptions(records, path)
    return _data_response({"ok": True})


@router.post("/push/test", dependencies=[Depends(_require_dashboard_auth)])
async def push_test(request: Request, profile: str = "default") -> JSONResponse:
    available, reason = _push_availability()
    if not available:
        raise HTTPException(status_code=503, detail=reason or "push unavailable")
    body = await _json_body(request)
    record_id = str(body.get("id") or "") if isinstance(body, dict) else ""
    if not record_id:
        raise HTTPException(status_code=400, detail="id is required")
    records, record = _find_push_record(record_id)
    if record is None or not bool(record.get("enabled", True)) or not _profile_matches(record, profile):
        raise HTTPException(status_code=404, detail="subscription not found")
    payload: dict[str, object] = {
        "type": "test",
        "title": "Hermes Mobile test",
        "body": "Notifications are connected.",
        "tag": "hermes-pwa-test",
        "url": "./index.html#/settings",
    }
    try:
        _send_push_record(record, payload)
    except WebPushException as exc:  # type: ignore[misc]
        status = getattr(getattr(exc, "response", None), "status_code", None)
        updates: dict[str, object] = {
            "last_error": sanitize_error_text(exc),
            "updated_at": datetime.now(timezone.utc).timestamp(),
        }
        if status in {404, 410}:
            updates["enabled"] = False
        _mark_push_record(records, record, **updates)
        raise HTTPException(status_code=502, detail="push service rejected subscription") from exc
    except Exception as exc:
        _mark_push_record(
            records,
            record,
            last_error=sanitize_error_text(exc),
            updated_at=datetime.now(timezone.utc).timestamp(),
        )
        raise HTTPException(status_code=502, detail="failed to send push") from exc
    _mark_push_record(
        records,
        record,
        last_success_at=datetime.now(timezone.utc).timestamp(),
        last_error=None,
        updated_at=datetime.now(timezone.utc).timestamp(),
    )
    return _data_response({"ok": True})


@router.get("/update/check", dependencies=[Depends(_require_dashboard_auth)])
def update_check() -> JSONResponse:
    return _data_response(_cached_update_check())


@router.api_route("/file", methods=["GET", "HEAD"], dependencies=[Depends(_require_dashboard_auth)])
def local_file(request: Request, path: str = "") -> Response:
    """Serve one file from the host for the phone client (inline image/PDF or download).

    Access is limited to the allowlisted roots in ``local_files`` and every
    response is sandboxed; see that module for the full policy. The bytes are
    streamed from the descriptor that passed the checks, so the path is never
    reopened. HEAD answers with the same headers and no body.
    """
    try:
        served, handle = open_served_file(path)
    except FileAccessError as exc:
        _file_log.info("local-file refused status=%s reason=%s", exc.status, exc.detail)
        raise HTTPException(status_code=exc.status, detail=exc.detail) from None
    headers = local_file_headers(served)
    headers["Content-Length"] = str(served.size)
    if request.method == "HEAD":
        handle.close()
        return Response(status_code=200, media_type=served.media_type, headers=headers)
    _file_log.info("local-file served path=%s bytes=%s inline=%s", served.path, served.size, served.inline)
    return StreamingResponse(iter_local_file(handle, served.size), media_type=served.media_type, headers=headers)


@router.get("/file/info", dependencies=[Depends(_require_dashboard_auth)])
def local_file_info(path: str = "") -> JSONResponse:
    """Describe a host file (name, size, type) without sending its bytes."""
    try:
        served = resolve_served_file(path)
    except FileAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from None
    return _data_response(describe_local_file(served))


@router.get("/obsidian/activity", dependencies=[Depends(_require_dashboard_auth)])
def obsidian_activity(days: int = 60, limit: int = 300) -> JSONResponse:
    """Notes the agent created or edited in the Obsidian vaults on this Mac.

    Names, folders and times only, from Hermes' own tool-call history; the
    phone turns each row into an ``obsidian://`` link. Never sends note text.
    """
    try:
        payload = obsidian_cached_activity(days=max(1, min(days, 3650)), limit=max(1, min(limit, 2000)))
    except Exception as exc:  # pragma: no cover - defensive: a corrupt DB must not 500 the tab
        _file_log.warning("obsidian activity scan failed: %s", sanitize_error_text(str(exc)))
        payload = {"available": False, "vaults": [], "profiles": [], "notes": [], "total": 0, "error": "scan failed"}
    return _data_response(payload)


@router.get("/agents/history", dependencies=[Depends(_require_dashboard_auth)])
def agents_history(days: int = 30, limit: int = 200) -> JSONResponse:
    """Delegated agent runs across every profile: which bot, what goal, when, how long, its answer."""
    try:
        payload = agent_cached_history(days=max(1, min(days, 3650)), limit=max(1, min(limit, 1000)))
    except Exception as exc:  # pragma: no cover - defensive: a corrupt DB must not 500 the tab
        _file_log.warning("agent history scan failed: %s", sanitize_error_text(str(exc)))
        payload = {"profiles": [], "runs": [], "total": 0, "error": "scan failed"}
    return _data_response(payload)


@router.post("/obsidian/sync", dependencies=[Depends(_require_dashboard_auth)])
async def obsidian_sync_now() -> JSONResponse:
    """Make sure Obsidian is open on the Mac, so Obsidian Sync moves the vault both ways, and
    rescan the notes the bots wrote. Opens the app in the background; never touches a note."""
    result = await run_in_threadpool(obsidian_sync.ensure_open)
    obsidian_clear_cache()
    return _data_response(result)


@router.get("/obsidian/note", dependencies=[Depends(_require_dashboard_auth)])
def obsidian_note(vault: str = "", path: str = "") -> JSONResponse:
    """One note's text for the in-app viewer; only files inside a known vault."""
    try:
        payload = obsidian_read_note(vault, path)
    except NoteAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from None
    return _data_response(payload)


@router.get("/bots/graph", dependencies=[Depends(_require_dashboard_auth)])
def bots_graph() -> JSONResponse:
    """The team map Sean drew in the Bots tab, or null when none was saved."""
    return _data_response({"graph": bot_graph.load()})


@router.put("/bots/graph", dependencies=[Depends(_require_dashboard_auth)])
async def save_bots_graph(request: Request) -> JSONResponse:
    """Save the team map. Bots learn their place on their next turn; nothing is blocked."""
    body = await _json_body(request)
    try:
        record = bot_graph.save(body)
    except bot_graph.GraphError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _data_response({"graph": record})


@router.get("/router", dependencies=[Depends(_require_dashboard_auth)])
def router_status() -> JSONResponse:
    """The router bot's settings, whether Jev has a key, which bots run an older copy of this
    plugin, and the newest decisions."""
    return _data_response({**pwa_router.status(), "decisions": pwa_router.recent(limit=20)})


@router.put("/router", dependencies=[Depends(_require_dashboard_auth)])
async def save_router(request: Request) -> JSONResponse:
    """Turn Jev routing on or off, pick the router bot, or change how sure Jev must be."""
    body = await _json_body(request)
    try:
        pwa_router.save_settings(body)
    except pwa_router.RouterSettingsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _data_response({**pwa_router.status(), "decisions": pwa_router.recent(limit=20)})


@router.get("/router/decisions", dependencies=[Depends(_require_dashboard_auth)])
def router_decisions(session_id: str = "", limit: int = 50) -> JSONResponse:
    """Jev's newest routing decisions, for one chat when ``session_id`` is given."""
    return _data_response({"decisions": pwa_router.recent(session_id=session_id[:256], limit=limit)})


@router.get("/speech/voices", dependencies=[Depends(_require_dashboard_auth)])
def speech_voices() -> JSONResponse:
    """The Mac's voices for reading replies aloud, best first.

    ``available`` is false on a host without macOS ``say``: the phone then
    reads with its own voice.
    """
    unavailable = {"available": False, "voices": [], "default": None}
    if not pwa_speech.available():
        return _data_response(unavailable)
    try:
        voices = pwa_speech.reading_voices(pwa_speech.list_voices())
    except (pwa_speech.SpeechUnavailable, pwa_speech.SpeechError):
        return _data_response(unavailable)
    return _data_response(
        {
            "available": True,
            "voices": [voice.as_dict() for voice in voices],
            "default": voices[0].id if voices else None,
        }
    )


@router.post("/speech", dependencies=[Depends(_require_dashboard_auth)])
async def speech_audio(request: Request) -> JSONResponse:
    """One piece of a reply read aloud by a voice on the Mac, as base64 AAC.

    The text is spoken on this machine; it is not sent anywhere else.
    """
    body = await _json_body(request)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    text = body.get("text")
    voice = body.get("voice")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    if voice is not None and not isinstance(voice, str):
        raise HTTPException(status_code=400, detail="voice must be a string")
    try:
        audio, used = await run_in_threadpool(pwa_speech.synthesize, text, voice or None, body.get("rate", 1.0))
    except pwa_speech.SpeechUnavailable as exc:
        raise HTTPException(status_code=501, detail="read aloud needs Hermes on a Mac") from exc
    except pwa_speech.SpeechBusy as exc:
        raise HTTPException(status_code=503, detail="speech is busy, try again") from exc
    except pwa_speech.SpeechError as exc:
        raise HTTPException(status_code=502, detail="speech failed") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _data_response(
        {"audio": base64.b64encode(audio).decode("ascii"), "mimeType": "audio/mp4", "voice": used}
    )


@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "plugin": "hermes-pwa",
            "version": _read_package_version(),
            "app_path": _APP_SCOPE,
            "dist_ready": (_DIST_ROOT / "index.html").exists(),
        }
    )


@router.get("/install-info", dependencies=[Depends(_require_dashboard_auth)])
def install_info(request: Request) -> JSONResponse:
    app_url = _app_url(request)
    return _data_response(
        {
            "app_url": app_url,
            "manifest_url": _manifest_url(request),
            "service_worker_url": _service_worker_url(request),
            "ios": ["Open in Safari", "Tap Share", "Choose Add to Home Screen"],
        }
    )


@router.get("/diagnostics", dependencies=[Depends(_require_dashboard_auth)])
def diagnostics(request: Request) -> JSONResponse:
    """Return structured readiness data for the Mobile tab diagnostics page."""
    app_url = _app_url(request)
    origin = str(request.base_url).rstrip("/")
    scheme = request.url.scheme
    host = request.url.hostname or ""

    return _data_response(
        {
            "origin": origin,
            "https": scheme == "https",
            "localhost": _is_localhost(host),
            "private_ip": _is_private_ip(host),
            "app_url": app_url,
            "manifest_url": _manifest_url(request),
            "service_worker_url": _service_worker_url(request),
            "app_scope": f"{_public_mobile_base(request)}/",
            "dist_ready": (_DIST_ROOT / "index.html").exists(),
        }
    )


def _app_link_svg(app_url: str) -> str:
    """Return an honest local SVG card showing the app URL.

    This is NOT a scannable QR code — it is a readable link card so the
    URL is never sent to an external image service.
    """
    encoded_url = escape(app_url)
    # Simple word-break for long URLs: split on / to keep readable
    url_parts = encoded_url.split("/")
    # Build tspan lines (max ~45 chars per line to fit 320px)
    lines: list[str] = []
    current = ""
    for part in url_parts:
        candidate = f"{current}/{part}" if current else part
        if len(candidate) > 44:
            if current:
                lines.append(current)
            current = part
        else:
            current = candidate
    if current:
        lines.append(current)
    # Limit to 5 lines to avoid overflow
    lines = lines[:5]
    tspan_blocks = "\n".join(
        f'    <tspan x="180" dy="{18 if i == 0 else 20}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" fill="#14171c">{line}</tspan>'
        for i, line in enumerate(lines)
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360" role="img" aria-label="Hermes Mobile app link card">
  <rect width="360" height="360" rx="16" fill="#ffffff" stroke="#e2e5ea" stroke-width="2"/>
  <rect x="24" y="24" width="312" height="56" rx="12" fill="#3b5bdb"/>
  <text x="180" y="58" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="#ffffff">Hermes Mobile</text>
  <text x="180" y="118" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#5b626d">Open this URL on your phone</text>
  <text x="180" y="142" text-anchor="middle">
{tspan_blocks}
  </text>
  <rect x="140" y="290" width="80" height="4" rx="2" fill="#e2e5ea"/>
  <text x="180" y="314" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#8a909b">App link card (not a QR code)</text>
</svg>"""


@router.get("/app-link.svg", dependencies=[Depends(_require_dashboard_auth)])
def app_link_svg(request: Request) -> Response:
    """Return a local SVG link card for the app URL.

    Honest fallback: this is NOT a scannable QR code. It exists to avoid
    leaking the app URL to third-party QR image services.
    """
    svg = _app_link_svg(_app_url(request))
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@router.get("/app", include_in_schema=False)
def hermes_pwa_app_redirect() -> RedirectResponse:
    return RedirectResponse("./app/", status_code=307)


@router.get("/app/", name="hermes_pwa_app_index")
def hermes_pwa_app_index() -> FileResponse:
    index = _safe_dist_path("index.html")
    if not index.exists():
        raise HTTPException(status_code=503, detail="Hermes PWA build output is missing. Run npm run build.")
    return _file_response(index)


@router.get("/app/{path:path}")
def hermes_pwa_app_asset(path: str) -> FileResponse:
    normalized = quote(path, safe="/._-@")
    if normalized != path or path.startswith("/"):
        raise HTTPException(status_code=404, detail="Not found")

    candidate = _safe_dist_path(path)
    if candidate.exists() and candidate.is_file():
        return _file_response(candidate)

    # SPA/hash-router fallback for non-file paths.
    index = _safe_dist_path("index.html")
    if index.exists():
        return _file_response(index)
    raise HTTPException(status_code=404, detail="Not found")
