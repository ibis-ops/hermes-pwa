/**
 * Connection diagnostics and user-facing error explanations.
 *
 * This module stays framework-agnostic: it maps raw transport errors to
 * actionable copy that the UI can render without knowing DOM APIs.
 */

export type ConnectionAdvice =
  | 'check-network'
  | 'sign-in-again'
  | 'retrying'
  | 'unknown';

export interface ConnectionDiagnostics {
  message: string;
  advice: ConnectionAdvice;
}

function isHttpError(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status?: unknown }).status === 'number' &&
    (err as { status: number }).status === status
  );
}

function isUnauthorizedLike(err: unknown): boolean {
  if (isHttpError(err, 401)) return true;
  if (isHttpError(err, 403)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /unauthorized|not authenticated|session expired|invalid session/i.test(msg);
}

function isNetworkLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    /fetch|network|failed to connect|net::ERR|ENOTFOUND|ECONNREFUSED/i.test(msg) ||
    msg === 'Hermes API is unreachable.'
  );
}

/**
 * Map a raw connection/WebSocket error into user-facing diagnostics.
 */
export function explainConnectionError(err: unknown): ConnectionDiagnostics {
  if (isUnauthorizedLike(err)) {
    return {
      message: 'Your session expired. Please sign in again.',
      advice: 'sign-in-again',
    };
  }

  if (isNetworkLike(err)) {
    return {
      message:
        "Can't reach your Dashboard. Check your network, Tailscale, or HTTPS setup and try again.",
      advice: 'check-network',
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (/<!doctype|<html|<body/i.test(msg)) {
    return {
      message: "Can't reach Hermes. Check Tailscale and that the Mac is awake, then try again.",
      advice: 'check-network',
    };
  }
  if (/ticket|websocket|ws/i.test(msg)) {
    return {
      message: 'Live updates disconnected. Retrying…',
      advice: 'retrying',
    };
  }

  return {
    message: msg || 'Connection lost. Retrying…',
    advice: 'retrying',
  };
}

/**
 * Short label for the current connection state.
 */
export function connectionStateLabel(state: string): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'ticketing':
      return 'Connecting…';
    case 'init':
      return 'Starting…';
    case 'login':
      return 'Sign in required';
    case 'offline':
      return 'Offline';
    case 'incompatible-transport':
      return 'WebSocket transport unsupported';
    default:
      return state;
  }
}
