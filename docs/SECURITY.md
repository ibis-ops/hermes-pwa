# Security & Privacy

Hermes Mobile is a **thin client** for your Hermes Agent instance. It stores no credentials and implements no secondary auth system.

## No secrets in the client

- API keys, model config, and agent logic stay on your Hermes server.
- The PWA does not use `localStorage`, `sessionStorage`, or `IndexedDB` for credentials.
- The PWA may keep non-secret local UI/session cache while signed in: active chat transcript cache, pinned session ids, the selected Kanban board, and the last selected screen.
- Logout clears the local PWA transcript/session cache and related UI cache keys even if the backend logout request fails.
- The service-worker cache persists only the app shell (HTML, JS, CSS, icons) and explicitly refuses to cache `/api/*` data routes.

## Same-origin session auth

- Hermes Mobile reuses the existing Dashboard session cookie.
- All API calls use `credentials: 'include'` so the browser sends the same cookie it uses for the Dashboard.
- No custom tokens, JWTs, or API keys are exchanged or stored by the PWA.
- If the session expires, the user is redirected to the Dashboard login page and returns to the PWA automatically after signing in.

## Transport security

- The PWA should be served over HTTPS in production through Tailscale Serve (see [NETWORK_TAILSCALE.md](./NETWORK_TAILSCALE.md)).
- WebSocket JSON-RPC uses the same origin and cookie as REST calls.
- The service worker explicitly refuses to cache `/api/*` data routes; only the app shell is cached locally.

## High-impact actions

- Approvals that can publish, delete, or act on the user’s behalf are marked `highImpact`.
- The UI requires an explicit confirmation (swipe or deliberate two-step tap) for high-impact approvals.
- No action is auto-approved; the safe choice is always the default.

## Telemetry

- Hermes Mobile does not include analytics, telemetry, or third-party trackers.
- No usage data, crash reports, or device identifiers are sent anywhere.
- Diagnostics in the Mobile tab are computed locally and exposed only through your own Hermes instance.

## Server-side plugin

- The plugin backend (`dashboard/plugin_api.py`) serves the PWA app shell and exposes same-origin endpoints for local diagnostics, backups metadata, pending approvals, messaging-session bindings, push subscription management, update checks, host files the agent produced, Obsidian vault activity and note text, and delegated-agent history.
- Sensitive plugin API routes are protected by the Dashboard auth layer and also perform an explicit defense-in-depth dashboard auth check before returning local data or mutating push state. The `/health` route is intentionally public for external monitors and returns bounded readiness only.
- State-changing routes refuse cross-site requests (`Sec-Fetch-Site`, `Origin` and a JSON content type are checked) and refuse JSON bodies over 64 KB before parsing them.
- Every JSON data route answers with `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`, so the data cannot be framed, embedded by another origin, sniffed or cached.
- It does not proxy app URLs to external QR or image services.
- It confines plugin-owned persistent state to the Hermes home/plugin storage paths; it reads selected Hermes local state needed for the Mobile control plane (for example sessions, backups metadata, pending approvals, and push subscription records). Backup directory sizes are cached per path and modification time for a minute, and the activity and history scans keep a handful of cached results keyed by a fixed set of day windows (7, 30, 60, 365, 3650 days).
- Plugin state files (`push_subscriptions.json`, `pending_approvals.json`, `push_delivery_state.json`) are owner-only, written atomically, and every read-modify-write holds an `flock` on a `.lock` file next to them, so the gateway process (hooks), the dashboard process (API) and the push worker thread cannot overwrite each other's changes.

### Update check

- `GET /update/check` asks `registry.npmjs.org` for the latest published `hermes-pwa` version. This is the only outbound request the plugin makes on its own; the result is cached in memory for six hours (ten minutes after a failed check), so the dashboard's connect does not contact the registry every time. Nothing about the host is sent beyond a generic `User-Agent`.

### Host files

- `GET /file` and `GET /file/info` serve files only from an allowlist of roots (the Hermes attachment and cache folders, Desktop and Downloads by default; `HERMES_PWA_FILE_ROOTS` replaces the list). Paths are resolved through symlinks before the root check, hidden files and app or photo-library bundles are refused, and a configured root is skipped when it is the home directory, a filesystem root, `~/Library`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.docker`, `~/.kube`, the Hermes home itself or its `profiles` tree.
- The file is opened without following a final symlink, matched against the inode that passed the checks, and streamed from that descriptor; the path is never reopened. Responses are sandboxed (`Content-Security-Policy` with `sandbox` and `frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`, `nosniff`, no caching), and only images, PDF, audio, video and plain text are sent inline; everything else is a download.

### Obsidian notes

- `GET /obsidian/activity` lists notes the agent created or edited by reading Hermes' own tool-call history; it never reads note text.
- `GET /obsidian/note` returns the text of one note for the in-app viewer. The path must stay inside a known vault after `realpath`, dot folders such as `.obsidian` and `.trash` are refused, only note files (`.md`, `.canvas`, `.base`) up to 2 MB are read, and the text is read from the descriptor that was checked.

### Push notifications

- A push for an approval carries a fixed body ("Security approval required. Open Hermes Mobile to review it."): the lock screen shows it to anyone, so neither the command nor its description travels in the notification. The card itself is fetched over the authenticated API (`GET /actions/pending`), which also exposes the gateway's `request_id` so the phone answers the exact request. Redacted one-line summaries used in lists drop `key=value`, `Bearer <token>` and bare token-like strings.
- Pushes are sent from a background worker thread, so the gateway's approval hook returns as soon as the pending record and the dedupe claim are written; a slow push service never delays the approval prompt or a gateway restart.
- Subscription endpoints must be HTTPS URLs on a browser push service, sends time out, and subscriptions are capped per profile.

## Reporting issues

If you discover a security issue in Hermes Mobile, please follow the private reporting process in the repository root [`SECURITY.md`](../SECURITY.md).
