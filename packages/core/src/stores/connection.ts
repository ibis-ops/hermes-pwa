import { create } from 'zustand';
import type { RestClient } from '../transport/rest';
import { JsonRpcError, type RpcClient, type RpcEventHandler } from '../transport/jsonrpc';
import type { WsConnection } from '../transport/ws';
import type { AuthProvider, HermesUser } from '../domain/auth';
import type { GatewayStatus } from '../domain/status';
import { explainConnectionError } from '../diagnostics';
import { useChatStore } from './chat';

export type ConnectionState =
  | 'init'
  | 'login'
  | 'ticketing'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'incompatible-transport'
  | 'unsupported';

export interface ConnectionStore {
  state: ConnectionState;
  status: GatewayStatus | undefined;
  authProviders: AuthProvider[];
  user: HermesUser | undefined;
  error: string | undefined;

  bindTransport(rest: RestClient, ws: WsConnection, rpc: RpcClient): void;
  init(): Promise<void>;
  login(provider: string, username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  disconnect(): void;
  setOnline(): void;
  setOffline(): void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const GATEWAY_READY_TIMEOUT_MS = 12_000;
const CONNECTED_HEALTH_TIMEOUT_MS = 5_000;
const MIN_SUPPORTED_HERMES_VERSION = '0.17.0';
const LOCAL_AUTH_USER_KEY = 'hermes-pwa.authUser.v1';
const LOCAL_PRIVATE_CACHE_KEYS = new Set([
  LOCAL_AUTH_USER_KEY,
  'hermes-mobile-screen',
  'hermes-kanban-board',
  'hermes-pwa.board',
  'hermes-pwa.board.v1',
]);
const LOCAL_PRIVATE_CACHE_PREFIXES = [
  'hermes-pwa.activeSession.',
  'hermes-pwa.pinnedSessions',
];

function isLocalPrivateCacheKey(key: string): boolean {
  return LOCAL_PRIVATE_CACHE_KEYS.has(key) || LOCAL_PRIVATE_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function purgeLocalPrivateCache(): void {
  useChatStore.getState().clear();
  if (typeof window === 'undefined') return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key && isLocalPrivateCacheKey(key)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Best-effort local privacy cleanup. Backend logout state is handled separately.
  }
}

function userCacheKey(user: HermesUser): string {
  return [user.provider || 'unknown', user.userId || user.email || user.displayName || 'unknown'].join(':');
}

function reconcileAuthenticatedUser(user: HermesUser): void {
  if (typeof window === 'undefined') return;
  const next = userCacheKey(user);
  try {
    const previous = window.localStorage.getItem(LOCAL_AUTH_USER_KEY);
    if (previous && previous !== next) {
      purgeLocalPrivateCache();
    }
    window.localStorage.setItem(LOCAL_AUTH_USER_KEY, next);
  } catch {
    // Best-effort privacy guard; do not block sign-in if storage is unavailable.
  }
}

function computeBackoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return Math.min(30000, base) + Math.random() * 300;
}

function parseSemver(version: string | undefined): [number, number, number] | undefined {
  const match = version?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isSupportedHermesVersion(version: string | undefined): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return true;
  const min = parseSemver(MIN_SUPPORTED_HERMES_VERSION);
  if (!min) return true;
  const major = parsed[0] ?? 0;
  const minor = parsed[1] ?? 0;
  const patch = parsed[2] ?? 0;
  const minMajor = min[0] ?? 0;
  const minMinor = min[1] ?? 0;
  const minPatch = min[2] ?? 0;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

function providersFromStatus(status: GatewayStatus): AuthProvider[] {
  return status.authProviders.map((name) => ({
    name,
    displayName: name === 'basic' ? 'Basic' : name,
    supportsPassword: name === 'basic' || name === 'password',
  }));
}

async function loadAuthProviders(rest: RestClient, status: GatewayStatus): Promise<AuthProvider[]> {
  if (!status.authRequired) return providersFromStatus(status);
  try {
    const providers = await rest.providers();
    if (providers.length > 0) return providers;
  } catch {
    // Older gateways may expose only /api/status auth_providers.
  }
  return providersFromStatus(status);
}

function providerSupportsPassword(provider: string, providers: AuthProvider[], status?: GatewayStatus): boolean {
  const detailed = providers.find((p) => p.name === provider);
  if (detailed) return detailed.supportsPassword;
  if (status?.authProviders.length) return status.authProviders.includes(provider) && provider === 'basic';
  return provider === 'basic';
}

type WsCloseEvent = Pick<CloseEvent, 'code' | 'reason' | 'wasClean'>;

function isUnsupportedWsTicketTransport(event: WsCloseEvent): boolean {
  if (event.code !== 1002 || event.wasClean) return false;
  return /(?:^|[^a-z0-9-])(?:hermes\.ws-ticket|ws-ticket|subprotocol)(?:[^a-z0-9-]|$)/i.test(event.reason || '');
}

function wsTicketTransportError(): string {
  return 'This Hermes server does not support the current WebSocket ticket transport. Update Hermes and reload the PWA.';
}

export const useConnectionStore = create<ConnectionStore>((set, get) => {
  let restRef: RestClient | null = null;
  let wsRef: WsConnection | null = null;
  let rpcRef: RpcClient | null = null;
  let wsAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let connectedHealthInFlight = false;
  let readyHandler: RpcEventHandler | null = null;

  function assertRefs(): { rest: RestClient; ws: WsConnection; rpc: RpcClient } {
    if (!restRef || !wsRef || !rpcRef) {
      throw new Error('Transport not bound. Call bindTransport() first.');
    }
    return { rest: restRef, ws: wsRef, rpc: rpcRef };
  }

  function clearReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearReadyWatchdog(): void {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  function removeReadyListener(): void {
    if (readyHandler && rpcRef) {
      rpcRef.events.removeEventListener('gateway.ready', readyHandler);
    }
    readyHandler = null;
  }

  function resetConnectionState(): void {
    clearReconnect();
    clearReadyWatchdog();
    wsAttempt = 0;
    removeReadyListener();
  }

  function forceReconnect(reason: string): void {
    clearReadyWatchdog();
    removeReadyListener();
    if (rpcRef) rpcRef.disconnect();
    if (wsRef) wsRef.close();
    if (get().state !== 'offline' && get().state !== 'incompatible-transport' && get().state !== 'unsupported') {
      set({ state: 'reconnecting', error: reason });
      scheduleReconnect();
    }
  }

  function startReadyWatchdog(): void {
    clearReadyWatchdog();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (get().state === 'connected') return;
      forceReconnect('Gateway did not finish the WebSocket handshake. Reconnecting…');
    }, GATEWAY_READY_TIMEOUT_MS);
  }

  async function checkConnectedRpcHealth(): Promise<void> {
    if (connectedHealthInFlight) return;
    if (get().state !== 'connected' || !rpcRef) return;
    connectedHealthInFlight = true;
    try {
      await rpcRef.request('session.usage', {}, { timeoutMs: CONNECTED_HEALTH_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof JsonRpcError) return;
      if (get().state === 'connected') {
        forceReconnect('Connection did not respond after waking. Reconnecting…');
      }
    } finally {
      connectedHealthInFlight = false;
    }
  }

  async function connectWs(): Promise<void> {
    set({ state: 'ticketing', error: undefined });
    clearReconnect();

    const { rest, ws, rpc } = assertRefs();

    try {
      const ticket = await rest.wsTicket();

      ws.connect(
        ticket.ticket,
        () => {
          wsAttempt = 0;
          startReadyWatchdog();
        },
        (line) => {
          rpc.onFrame(line);
        },
        (event) => {
          clearReadyWatchdog();
          rpc.disconnect();
          removeReadyListener();
          // A dropped socket does not stop the turn on the Mac: the chat keeps
          // its working state and resyncLiveSession settles it on reconnect.
          if (isUnsupportedWsTicketTransport(event)) {
            clearReconnect();
            set({ state: 'incompatible-transport', error: wsTicketTransportError() });
            return;
          }
          if (get().state === 'connected') {
            set({ state: 'reconnecting' });
          }
          scheduleReconnect();
        },
      );

      // Listen for gateway.ready event to confirm connection.
      removeReadyListener();
      readyHandler = () => {
        clearReadyWatchdog();
        wsAttempt = 0;
        set({ state: 'connected', error: undefined });
        removeReadyListener();
      };
      rpc.events.addEventListener('gateway.ready', readyHandler);
    } catch (err) {
      const diagnostics = explainConnectionError(err);
      if (diagnostics.advice === 'sign-in-again') {
        resetConnectionState();
        purgeLocalPrivateCache();
        set({ state: 'login', user: undefined, error: diagnostics.message });
        return;
      }
      set({ state: 'reconnecting', error: diagnostics.message });
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (get().state === 'offline') return;
    if (reconnectTimer) return;

    if (wsAttempt >= MAX_RECONNECT_ATTEMPTS) {
      set({
        state: 'offline',
        error: 'Could not reconnect after several attempts. Check your network and tap Retry.',
      });
      return;
    }

    const delay = computeBackoffMs(wsAttempt);
    wsAttempt++;

    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (get().state === 'offline') return;
      set({ state: 'ticketing' });
      connectWs().catch((err) => {
        const { message } = explainConnectionError(err);
        set({ state: 'reconnecting', error: message });
        scheduleReconnect();
      });
    }, delay);
  }

  return {
    state: 'init',
    error: undefined,
    status: undefined,
    authProviders: [],
    user: undefined,

    bindTransport(rest, ws, rpc) {
      restRef = rest;
      wsRef = ws;
      rpcRef = rpc;
    },

    async init() {
      resetConnectionState();
      set({ state: 'init', error: undefined });
      try {
        const { rest } = assertRefs();
        const status = await rest.status();
        const authProviders = await loadAuthProviders(rest, status);
        set({ status, authProviders });

        if (!isSupportedHermesVersion(status.version)) {
          set({
            state: 'unsupported',
            error: `Hermes Mobile requires Hermes ${MIN_SUPPORTED_HERMES_VERSION} or newer. Current server: ${status.version}.`,
          });
          return;
        }

        if (status.authRequired) {
          try {
            const user = await rest.me();
            reconcileAuthenticatedUser(user);
            set({ user });
            await connectWs();
          } catch (err) {
            const diagnostics = explainConnectionError(err);
            if (diagnostics.advice === 'sign-in-again') {
              // No valid session: the cached transcript (commands, tool output)
              // must not outlive it on a shared or lost phone.
              purgeLocalPrivateCache();
              set({ state: 'login', user: undefined, error: undefined });
            } else {
              set({ state: 'offline', error: diagnostics.message });
            }
          }
        } else {
          await connectWs();
        }
      } catch (err) {
        const { message } = explainConnectionError(err);
        set({ state: 'offline', error: message });
      }
    },

    async login(provider, username, password) {
      resetConnectionState();
      const { status, authProviders } = get();
      if (!providerSupportsPassword(provider, authProviders, status)) {
        set({ state: 'login', error: 'This Hermes server does not support password sign-in in the mobile PWA.' });
        return;
      }
      set({ state: 'init', error: undefined });
      try {
        const { rest } = assertRefs();
        let result;
        try {
          result = await rest.passwordLogin({ provider, username, password, next: '/' });
        } catch (err) {
          // The dashboard answers a wrong username or password with 401/403.
          // That is a login problem, not an expired session or a dead link,
          // so keep the form up and say so.
          if (explainConnectionError(err).advice === 'sign-in-again') {
            set({ state: 'login', error: 'Wrong username or password.' });
            return;
          }
          throw err;
        }
        if (!result.ok) {
          set({ state: 'login', error: 'Wrong username or password.' });
          return;
        }
        const user = await rest.me();
        reconcileAuthenticatedUser(user);
        set({ user });
        await connectWs();
      } catch (err) {
        const { message } = explainConnectionError(err);
        set({ state: 'offline', error: message });
      }
    },

    async logout() {
      resetConnectionState();
      purgeLocalPrivateCache();
      try {
        const { rest, ws } = assertRefs();
        ws.close();
        await rest.logout();
      } catch {
        // Ignore logout errors; we always transition to login.
      } finally {
        purgeLocalPrivateCache();
      }
      set({ state: 'login', user: undefined, error: undefined });
    },

    disconnect() {
      resetConnectionState();
      if (wsRef) {
        wsRef.close();
      }
      set({ state: 'offline', error: 'Disconnected.' });
    },

    setOnline() {
      const current = get().state;
      if (current === 'offline' || current === 'reconnecting') {
        resetConnectionState();
        void get().init();
        return;
      }
      if (current === 'connected') {
        void checkConnectedRpcHealth();
      }
    },

    setOffline() {
      clearReconnect();
      set({
        state: 'offline',
        error: 'Network offline. Check your connection and try again.',
      });
    },
  };
});
