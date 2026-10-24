import { useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '@hermes-pwa/core';

/**
 * The connection drops and comes back in well under a second every time the
 * app returns from the background on iOS. Status UI driven straight from the
 * raw state blinks through "Reconnecting" each time, so this reports a drop
 * only once it has lasted `graceMs` (measured from the moment the connection
 * was lost, however many retry states pass in between); a return to connected
 * shows at once.
 */
export function useSettledConnectionState(state: ConnectionState, graceMs = 1500): ConnectionState {
  const [settled, setSettled] = useState(state);
  const lostAtRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (state === 'connected') {
      lostAtRef.current = undefined;
      setSettled('connected');
      return undefined;
    }
    if (lostAtRef.current === undefined) lostAtRef.current = Date.now();
    const elapsed = Date.now() - lostAtRef.current;
    if (elapsed >= graceMs) {
      setSettled(state);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(state), graceMs - elapsed);
    return () => window.clearTimeout(timer);
  }, [state, graceMs]);

  return settled;
}
