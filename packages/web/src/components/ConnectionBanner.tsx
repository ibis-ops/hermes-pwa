import { useEffect, useState } from 'react';
import type { ConnectionState } from '@hermes-pwa/core';

interface ConnectionBannerProps {
  state: ConnectionState;
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
}

/**
 * Coming back from another app drops and re-opens the WebSocket in well under
 * a second. A banner for that would just blink, so a reconnect only shows once
 * it has lasted this long. Offline shows at once.
 */
const RECONNECT_GRACE_MS = 1500;

export function ConnectionBanner({ state, error, onRetry }: ConnectionBannerProps) {
  const isOffline = state === 'offline';
  const isReconnecting = state === 'reconnecting' || state === 'ticketing';
  const [reconnectVisible, setReconnectVisible] = useState(false);

  useEffect(() => {
    if (!isReconnecting) {
      setReconnectVisible(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setReconnectVisible(true), RECONNECT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [isReconnecting]);

  if (state === 'connected') return null;
  if (!isOffline && !(isReconnecting && reconnectVisible)) return null;

  const title = isOffline ? 'Offline' : 'Reconnecting…';
  const message = error ?? (isOffline ? 'Check your connection and try again.' : 'Live updates disconnected.');
  const modifier = isOffline ? 'hm-warning-banner--error' : 'hm-warning-banner--warn';

  return (
    <div className={`hm-warning-banner ${modifier}`} role="status" aria-live="polite">
      <strong>{title}</strong>
      {' — '}
      {message}
      {onRetry && (
        <>
          {' '}
          <button
            type="button"
            className="hm-ghost"
            onClick={onRetry}
            style={{ marginLeft: 8, fontSize: 'inherit', minHeight: 'auto', padding: '2px 10px' }}
          >
            Retry now
          </button>
        </>
      )}
    </div>
  );
}
