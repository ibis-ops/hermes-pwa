import { useEffect, useRef } from 'react';
import {
  useConnectionStore,
  makeHttp,
  makeRestClient,
  makeWsConnection,
  makeRpcClient,
} from '@hermes-pwa/core';
import { Login } from '../screens/Login';
import { AppShell } from './AppShell';
import { AppPreview } from './AppPreview';
import { useNativeViewportLock } from './useNativeViewportLock';
import { hasCachedTranscript } from '../lib/screenStorage';
import './App.css';
import '../styles/prototype.css';
import '../styles/apple.css';

const isPreview = import.meta.env.DEV &&
  new URLSearchParams(window.location.search).has('preview');

const http = makeHttp();
const rest = makeRestClient(http);
const ws = makeWsConnection('');
const rpc = makeRpcClient((msg: string) => {
  ws.send(msg);
});

export function App() {
  useNativeViewportLock();
  const connection = useConnectionStore();
  // Once the shell has been on screen, a WebSocket reconnect (every return
  // from another app on iOS) must not replace it with the connecting screen:
  // that remount lost the scroll position and the text being typed, and
  // flashed "Connecting" for a moment. The shell shows its own banner instead.
  const shellShownRef = useRef(false);
  if (connection.state === 'connected') shellShownRef.current = true;
  // A launch shows the shell at once with whatever is cached (the last
  // transcript, the last screen) while the socket comes up; the banner in the
  // shell says "Connecting". Only an answer that sign-in is needed, or an
  // unsupported server, replaces it.
  const hasCachedShell = useRef(hasCachedTranscript()).current;

  useEffect(() => {
    if (isPreview) return;
    connection.bindTransport(rest, ws, rpc);
    void connection.init();

    const onOnline = () => connection.setOnline();
    const onOffline = () => connection.setOffline();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isPreview) return <AppPreview />;

  if (connection.state === 'login') {
    return <Login store={connection} error={connection.error} />;
  }

  if ((connection.state === 'init' || connection.state === 'ticketing') && !shellShownRef.current && !hasCachedShell) {
    return (
      <div className="hm-app-shell">
        <div className="hm-empty-state hm-empty-state--launch">
          <img className="hm-empty-state__logo" src="./icons/icon-192.png" alt="" aria-hidden="true" />
          <p className="hm-muted">Connecting…</p>
        </div>
      </div>
    );
  }

  // A transient offline moment (a tunnel, an elevator) keeps the shell, its
  // draft and its queue; the banner offers Retry. The dead-end screen is for
  // a launch that could not reach Hermes at all.
  const keepShellWhileOffline = connection.state === 'offline' && (shellShownRef.current || hasCachedShell);

  if (!keepShellWhileOffline && (connection.state === 'offline' || connection.state === 'unsupported' || connection.state === 'incompatible-transport')) {
    const canRetry = connection.state === 'offline';
    const fallback = connection.state === 'unsupported'
      ? 'Unsupported Hermes server'
      : connection.state === 'incompatible-transport'
        ? 'WebSocket transport unsupported'
        : 'Offline';
    return (
      <div className="hm-app-shell">
        <div className="hm-empty-state">
          <h1>Hermes Mobile</h1>
          <p className="hm-muted">{connection.error ?? fallback}</p>
          {canRetry ? (
            <button
              className="hm-primary"
              onClick={() => {
                connection.bindTransport(rest, ws, rpc);
                void connection.init();
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <AppShell
      connectionState={connection.state}
      rpc={rpc}
      rest={rest}
      onRetry={() => {
        connection.bindTransport(rest, ws, rpc);
        void connection.init();
      }}
    />
  );
}
