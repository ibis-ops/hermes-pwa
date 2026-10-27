import { useEffect, useRef } from 'react';
import {
  attachChatEvents,
  useChatStore,
  useConfigStore,
  useConnectionStore,
  useSessionsStore,
  type RpcClient,
  type RestClient,
} from '@hermes-pwa/core';

/** Live events drive the transcript; this is only the safety net for a lost event. */
const CHAT_HISTORY_REFRESH_INTERVAL_MS = 30_000;

/**
 * Keeps the chat store in step with the gateway for as long as the shell is
 * up, whichever screen is open: the live event stream, the first restore once
 * connected, a re-attach after every reconnect (iOS drops the socket on every
 * return from the background), the switch to another bot, and a slow history
 * refresh as the safety net for a lost event. Mounted once by the app shell,
 * so leaving the chat for the approvals screen no longer drops a running turn.
 */
export function useChatSync(
  rpc: RpcClient,
  rest: RestClient,
  activeName: string | undefined,
  currentName: string | undefined,
): void {
  const connectionState = useConnectionStore((s) => s.state);
  // The gateway runs every profile and binds a session to the one named at
  // session.create, so the selected bot (activeName) is the one to talk to;
  // currentName is only the profile the gateway process was launched with.
  const activeNameRef = useRef(activeName);
  activeNameRef.current = activeName;
  const currentNameRef = useRef(currentName);
  currentNameRef.current = currentName;
  const restoredRef = useRef(false);
  const initialRestoreDoneRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const previousConnectionRef = useRef(connectionState);
  const previousProfileRef = useRef(activeName);
  const unmountedRef = useRef(false);
  // The REST refresh, reachable from the restore that precedes it.
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // The event stream, bound to the store for the life of the shell.
  useEffect(
    () => attachChatEvents(rpc, rest, { getProfile: () => activeNameRef.current ?? currentNameRef.current }),
    [rpc, rest],
  );

  // Every return from the background on iOS drops and re-opens the socket.
  // Re-attach to the live session so a turn that kept running on the Mac
  // picks up where the stream left off instead of going quiet.
  useEffect(() => {
    const previous = previousConnectionRef.current;
    previousConnectionRef.current = connectionState;
    if (connectionState !== 'connected' || previous === 'connected' || !restoredRef.current) return;
    const profile = activeNameRef.current;
    void useChatStore
      .getState()
      .resyncLiveSession(rest, rpc, profile)
      .then((outcome) => {
        // The parked runtime was reaped while the phone was away: reopen the
        // stored session so the chat keeps working.
        if (outcome === 'lost') return useChatStore.getState().restore(rest, rpc, profile);
        return undefined;
      })
      .catch(() => undefined);
  }, [connectionState, rest, rpc]);

  // The first restore, once connected: the session list first (restore
  // resolves the current compressed head through it), then the cached chat
  // reconciled against the backend, so a stale live session id never reaches
  // the next prompt.submit.
  useEffect(() => {
    if (connectionState !== 'connected' || restoredRef.current) return;
    restoredRef.current = true;
    void useConfigStore.getState().load(rest);
    void (async () => {
      try {
        await useSessionsStore.getState().load(rest);
        if (unmountedRef.current) return;
        await useChatStore.getState().restore(rest, rpc, activeNameRef.current);
      } catch {
        // The store keeps its own error state; the refresh below retries.
      } finally {
        initialRestoreDoneRef.current = true;
        // A cached turn that ended while the app was closed is settled by the
        // transcript on the gateway, which restore leaves alone mid-stream.
        if (!unmountedRef.current) refreshRef.current();
      }
    })();
  }, [connectionState, rpc, rest]);

  // Another bot picked: its own cached chat comes up (or an empty one), and
  // a turn the previous bot is still running keeps going in the store's cache.
  useEffect(() => {
    if (previousProfileRef.current === activeName) return;
    previousProfileRef.current = activeName;
    if (!restoredRef.current) return;
    void (async () => {
      try {
        await useSessionsStore.getState().load(rest);
        if (unmountedRef.current) return;
        await useChatStore.getState().restore(rest, rpc, activeName);
      } catch {
        // As above.
      }
    })();
  }, [activeName, rest, rpc]);

  // The slow safety net: the transcript from REST every half minute while the
  // app is in front, and on every return to it.
  useEffect(() => {
    if (connectionState !== 'connected') return undefined;
    const refresh = () => {
      if (!initialRestoreDoneRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      void (async () => {
        try {
          // The session list first: sessions rotate to a newer stored head
          // after compression or a gateway resume, and refreshHistory resolves
          // stale aliases through it. While a reply streams the list can wait;
          // refreshHistory itself knows when a stream went quiet.
          if (!useChatStore.getState().streaming) await useSessionsStore.getState().load(rest);
          await useChatStore.getState().refreshHistory(rest, activeNameRef.current);
        } catch {
          // Next tick retries.
        } finally {
          refreshInFlightRef.current = false;
        }
      })();
    };
    refreshRef.current = refresh;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    refresh();
    const interval = window.setInterval(refresh, CHAT_HISTORY_REFRESH_INTERVAL_MS);
    return () => {
      refreshRef.current = () => undefined;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [connectionState, rest]);
}
