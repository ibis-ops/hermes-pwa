import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConnectionStore } from './connection';
import { useChatStore } from './chat';
import type { RestClient } from '../transport/rest';
import type { WsConnection } from '../transport/ws';
import type { RpcClient } from '../transport/jsonrpc';
import { JsonRpcError, makeRpcEvents } from '../transport/jsonrpc';
import { HermesHttpError } from '../transport/http';

describe('useConnectionStore', () => {
  let restMock: RestClient;
  let wsMock: WsConnection;
  let rpcMock: RpcClient;

  beforeEach(() => {
    // Reset store state between tests
    useConnectionStore.setState({ state: 'init', error: undefined, status: undefined, authProviders: [], user: undefined });
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined, cacheProfile: undefined });
    window.localStorage.clear();
    vi.useRealTimers();

    restMock = {
      status: vi.fn(),
      providers: vi.fn(),
      passwordLogin: vi.fn(),
      me: vi.fn(),
      wsTicket: vi.fn(),
      logout: vi.fn(),
    } as unknown as RestClient;

    wsMock = {
      connect: vi.fn(),
      close: vi.fn(),
    } as unknown as WsConnection;

    rpcMock = {
      request: vi.fn(),
      onFrame: vi.fn(),
      events: makeRpcEvents(),
      disconnect: vi.fn(),
    } as unknown as RpcClient;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('init starts websocket ticketing when no auth is required', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('ticketing');
    expect(restMock.status).toHaveBeenCalled();
    expect(wsMock.connect).toHaveBeenCalled();
  });

  it('init transitions to login when auth required and me throws', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: true, authProviders: ['basic'] });
    vi.mocked(restMock.me).mockRejectedValue(new HermesHttpError(401, 'Unauthorized', 'no_cookie'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('login');
  });

  it('init reports offline when the user probe fails for non-auth reasons', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: true, authProviders: ['basic'] });
    vi.mocked(restMock.me).mockRejectedValue(new HermesHttpError(500, 'Internal Server Error', 'server exploded'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('offline');
    expect(useConnectionStore.getState().error).toBe('server exploded');
    expect(wsMock.connect).not.toHaveBeenCalled();
  });

  it('init records parsed auth providers for login compatibility', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: true, authProviders: ['oauth'] });
    vi.mocked(restMock.providers).mockResolvedValue([
      { name: 'oauth', displayName: 'OAuth', supportsPassword: false },
      { name: 'basic', displayName: 'Password', supportsPassword: true },
    ]);
    vi.mocked(restMock.me).mockRejectedValue(new HermesHttpError(401, 'Unauthorized', 'no_cookie'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(restMock.providers).toHaveBeenCalled();
    expect(useConnectionStore.getState().authProviders).toEqual([
      { name: 'oauth', displayName: 'OAuth', supportsPassword: false },
      { name: 'basic', displayName: 'Password', supportsPassword: true },
    ]);
    expect(useConnectionStore.getState().state).toBe('login');
  });

  it('falls back to status auth providers when provider details are unavailable', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: true, authProviders: ['basic'] });
    vi.mocked(restMock.providers).mockRejectedValue(new Error('not found'));
    vi.mocked(restMock.me).mockRejectedValue(new HermesHttpError(401, 'Unauthorized', 'no_cookie'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().authProviders).toEqual([
      { name: 'basic', displayName: 'Basic', supportsPassword: true },
    ]);
    expect(useConnectionStore.getState().state).toBe('login');
  });

  it('enters unsupported state for unsupported Hermes gateway versions', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [], version: '0.16.9' });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('unsupported');
    expect(useConnectionStore.getState().error).toContain('requires Hermes');
    expect(wsMock.connect).not.toHaveBeenCalled();
  });

  it('init transitions to connected when auth required but already logged in', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: true, authProviders: ['basic'] });
    vi.mocked(restMock.me).mockResolvedValue({
      userId: 'u-1',
      displayName: 'Alice',
      provider: 'basic',
      expiresAt: 0,
    });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('ticketing');
    expect(useConnectionStore.getState().user?.displayName).toBe('Alice');
    expect(wsMock.connect).toHaveBeenCalled();
  });

  it('forces reconnect if the websocket opens but gateway.ready never arrives', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();
    const onOpen = vi.mocked(wsMock.connect).mock.calls[0]?.[1];

    onOpen?.();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(useConnectionStore.getState().state).toBe('reconnecting');
    expect(rpcMock.disconnect).toHaveBeenCalled();
    expect(wsMock.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(2);
  });

  it('cancels the gateway.ready watchdog when ready arrives', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();
    const onOpen = vi.mocked(wsMock.connect).mock.calls[0]?.[1];

    onOpen?.();
    rpcMock.events.dispatchEvent({ type: 'gateway.ready' });
    await vi.advanceTimersByTimeAsync(12_000);

    expect(useConnectionStore.getState().state).toBe('connected');
    expect(restMock.wsTicket).toHaveBeenCalledTimes(1);
    // Every connection tells the gateway this client answers its approval and clarify questions.
    expect(rpcMock.request).toHaveBeenCalledWith('client.capabilities', { server_requests: true });
  });

  it('reports unsupported websocket ticket transport without reconnect backoff', async () => {
    vi.useFakeTimers();
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();
    const onClose = vi.mocked(wsMock.connect).mock.calls[0]?.[3];

    onClose?.({ code: 1002, reason: 'unsupported subprotocol', wasClean: false } as CloseEvent);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(useConnectionStore.getState().state).toBe('incompatible-transport');
    expect(useConnectionStore.getState().error).toContain('WebSocket ticket transport');
    expect(restMock.wsTicket).toHaveBeenCalledTimes(1);
  });

  it('does not classify clean protocol closes as incompatible websocket ticket transport', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();
    useConnectionStore.setState({ state: 'connected' });
    const onClose = vi.mocked(wsMock.connect).mock.calls[0]?.[3];

    onClose?.({ code: 1002, reason: 'proxy switching protocol timeout', wasClean: true } as CloseEvent);

    expect(useConnectionStore.getState().state).toBe('reconnecting');
    expect(useConnectionStore.getState().error ?? '').not.toContain('WebSocket ticket transport');
    await vi.advanceTimersByTimeAsync(500);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(2);
  });

  it('keeps a streaming chat working when the websocket closes mid-turn (the Mac is still running it)', async () => {
    vi.useFakeTimers();
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();
    useConnectionStore.setState({ state: 'connected' });
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
      streaming: true,
      error: undefined,
      cacheProfile: 'default',
    });
    const onClose = vi.mocked(wsMock.connect).mock.calls[0]?.[3];

    onClose?.({ code: 1006, reason: 'network reset', wasClean: false } as CloseEvent);

    expect(useConnectionStore.getState().state).toBe('reconnecting');
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('init purges private cache when the authenticated dashboard user changed silently', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: true, authProviders: ['basic'] });
    vi.mocked(restMock.me).mockResolvedValue({
      userId: 'u-2',
      displayName: 'Bob',
      provider: 'basic',
      expiresAt: 0,
    });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });
    window.localStorage.setItem('hermes-pwa.authUser.v1', 'basic:u-1');
    window.localStorage.setItem('hermes-pwa.activeSession.v4:default', 'alice transcript');
    useChatStore.setState({
      sessionId: 'alice-live',
      storedSessionId: 'alice-stored',
      messages: [{ id: 'a-1', role: 'user', text: 'alice private', createdAt: undefined }],
      streaming: false,
      error: undefined,
      cacheProfile: 'default',
    });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toBeNull();
    expect(window.localStorage.getItem('hermes-pwa.authUser.v1')).toBe('basic:u-2');
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useConnectionStore.getState().user?.displayName).toBe('Bob');
  });

  it('init transitions to offline on network error', async () => {
    vi.mocked(restMock.status).mockRejectedValue(new Error('Network down'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('offline');
    expect(useConnectionStore.getState().error).toMatch(/Dashboard/);
  });

  it('login transitions to connected on success', async () => {
    vi.mocked(restMock.passwordLogin).mockResolvedValue({ ok: true, next: '/' });
    vi.mocked(restMock.me).mockResolvedValue({
      userId: 'u-1',
      displayName: 'Alice',
      provider: 'basic',
      expiresAt: 0,
    });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.login('basic', 'alice', 'secret');

    expect(restMock.passwordLogin).toHaveBeenCalledWith({ provider: 'basic', username: 'alice', password: 'secret', next: '/' });
    expect(useConnectionStore.getState().state).toBe('ticketing');
  });

  it('login purges private cache when a different dashboard user signs in', async () => {
    vi.mocked(restMock.passwordLogin).mockResolvedValue({ ok: true, next: '/' });
    vi.mocked(restMock.me).mockResolvedValue({
      userId: 'u-2',
      displayName: 'Bob',
      provider: 'basic',
      expiresAt: 0,
    });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });
    window.localStorage.setItem('hermes-pwa.authUser.v1', 'basic:u-1');
    window.localStorage.setItem('hermes-pwa.activeSession.v4:default', 'alice transcript');
    window.localStorage.setItem('unrelated-setting', 'keep');
    useChatStore.setState({
      sessionId: 'alice-live',
      storedSessionId: 'alice-stored',
      messages: [{ id: 'a-1', role: 'assistant', text: 'alice private', createdAt: undefined }],
      streaming: true,
      error: undefined,
      cacheProfile: 'default',
    });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.login('basic', 'bob', 'secret');

    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toBeNull();
    expect(window.localStorage.getItem('hermes-pwa.authUser.v1')).toBe('basic:u-2');
    expect(window.localStorage.getItem('unrelated-setting')).toBe('keep');
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('login stays on login when passwordLogin returns ok:false', async () => {
    vi.mocked(restMock.passwordLogin).mockResolvedValue({ ok: false, next: '/' });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.login('basic', 'alice', 'wrong');

    expect(useConnectionStore.getState().state).toBe('login');
    expect(useConnectionStore.getState().error).toBe('Wrong username or password.');
  });

  it('login stays on login when the dashboard rejects the credentials with 401', async () => {
    const rejected = Object.assign(new Error('Unauthorized'), { status: 401 });
    vi.mocked(restMock.passwordLogin).mockRejectedValue(rejected);

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.login('basic', 'alice', 'wrong');

    expect(useConnectionStore.getState().state).toBe('login');
    expect(useConnectionStore.getState().error).toBe('Wrong username or password.');
    expect(restMock.me).not.toHaveBeenCalled();
  });

  it('login transitions to offline on network error', async () => {
    vi.mocked(restMock.passwordLogin).mockRejectedValue(new Error('Timeout'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.login('basic', 'alice', 'secret');

    expect(useConnectionStore.getState().state).toBe('offline');
  });

  it('disconnect closes ws and sets offline', () => {
    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    store.disconnect();

    expect(wsMock.close).toHaveBeenCalled();
    expect(useConnectionStore.getState().state).toBe('offline');
  });

  it('logout calls backend logout, closes ws and returns to login', async () => {
    vi.mocked(restMock.logout).mockResolvedValue(undefined);

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'connected', user: { userId: 'u-1', displayName: 'Alice', provider: 'basic', expiresAt: 0 } });

    await store.logout();

    expect(wsMock.close).toHaveBeenCalled();
    expect(restMock.logout).toHaveBeenCalled();
    expect(useConnectionStore.getState().state).toBe('login');
    expect(useConnectionStore.getState().user).toBeUndefined();
  });

  it('logout clears local private PWA caches and chat state', async () => {
    vi.mocked(restMock.logout).mockResolvedValue(undefined);
    window.localStorage.setItem('hermes-pwa.activeSession.v1', 'legacy');
    window.localStorage.setItem('hermes-pwa.activeSession.v3', 'current');
    window.localStorage.setItem('hermes-pwa.activeSession.v4:default', 'profiled-default');
    window.localStorage.setItem('hermes-pwa.activeSession.v4:dev', 'profiled-dev');
    window.localStorage.setItem('hermes-pwa.pinnedSessions.v1', '["s-1"]');
    window.localStorage.setItem('hermes-kanban-board', 'ops');
    window.localStorage.setItem('hermes-mobile-screen', 'chat');
    window.localStorage.setItem('unrelated-setting', 'keep');
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      messages: [{ id: 'm-1', role: 'user', text: 'private transcript', createdAt: undefined }],
      streaming: true,
      error: 'old',
      cacheProfile: 'dev',
    });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'connected', user: { userId: 'u-1', displayName: 'Alice', provider: 'basic', expiresAt: 0 } });

    await store.logout();

    expect([...Array(window.localStorage.length)].map((_, i) => window.localStorage.key(i))).not.toEqual(
      expect.arrayContaining([
        'hermes-pwa.activeSession.v1',
        'hermes-pwa.activeSession.v3',
        'hermes-pwa.activeSession.v4:default',
        'hermes-pwa.activeSession.v4:dev',
        'hermes-pwa.pinnedSessions.v1',
        'hermes-kanban-board',
        'hermes-mobile-screen',
      ]),
    );
    expect(window.localStorage.getItem('unrelated-setting')).toBe('keep');
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streaming).toBe(false);
    expect(useConnectionStore.getState().state).toBe('login');
  });

  it('logout clears local private caches even when backend logout fails', async () => {
    vi.mocked(restMock.logout).mockRejectedValue(new Error('logout failed'));
    window.localStorage.setItem('hermes-pwa.activeSession.v4:default', 'private');
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      messages: [{ id: 'm-1', role: 'assistant', text: 'private', createdAt: undefined }],
      streaming: true,
      error: undefined,
      cacheProfile: 'default',
    });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);

    await store.logout();

    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useConnectionStore.getState().state).toBe('login');
  });

  it('setOnline triggers init when offline', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'offline', error: 'Network down' });

    store.setOnline();

    await vi.waitFor(() => expect(useConnectionStore.getState().state).toBe('ticketing'));
  });

  it('setOnline does not retry from incompatible websocket transport state', () => {
    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'incompatible-transport', error: 'WebSocket ticket transport unsupported' });

    store.setOnline();

    expect(restMock.status).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().state).toBe('incompatible-transport');
  });

  it('setOnline probes a connected websocket and leaves it alone when RPC responds', async () => {
    vi.mocked(rpcMock.request).mockRejectedValue(new JsonRpcError({ code: 4001, message: 'session required' }));
    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'connected', error: undefined });

    store.setOnline();

    await vi.waitFor(() => expect(rpcMock.request).toHaveBeenCalledWith('session.usage', {}, { timeoutMs: 5000 }));
    expect(wsMock.close).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().state).toBe('connected');
  });

  it('setOnline forces reconnect when a connected websocket no longer answers RPC', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('JSON-RPC request timed out'));
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-2', ttlSeconds: 30 });
    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'connected', error: undefined });

    store.setOnline();
    await vi.waitFor(() => expect(useConnectionStore.getState().state).toBe('reconnecting'));

    expect(rpcMock.disconnect).toHaveBeenCalled();
    expect(wsMock.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(1);
  });

  it('setOffline forces offline state', () => {
    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'connected' });

    store.setOffline();

    expect(useConnectionStore.getState().state).toBe('offline');
    expect(useConnectionStore.getState().error).toMatch(/offline/i);
  });

  it('ws close handler schedules reconnect when connected', async () => {
    vi.useFakeTimers();
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    // Simulate connected, then ws close
    useConnectionStore.setState({ state: 'connected' });
    const call = vi.mocked(wsMock.connect).mock.calls[0];
    if (!call) {
      throw new Error('wsMock.connect was not called');
    }
    const onClose = call[3];
    if (!onClose) {
      throw new Error('onClose was not registered');
    }
    onClose({} as CloseEvent);

    expect(useConnectionStore.getState().state).toBe('reconnecting');
    vi.useRealTimers();
  });

  it('ws close handler rejects pending JSON-RPC requests before reconnecting', async () => {
    vi.useFakeTimers();
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    useConnectionStore.setState({ state: 'connected' });
    const call = vi.mocked(wsMock.connect).mock.calls[0];
    if (!call) {
      throw new Error('wsMock.connect was not called');
    }
    const onClose = call[3];
    if (!onClose) {
      throw new Error('onClose was not registered');
    }

    onClose({} as CloseEvent);

    expect(rpcMock.disconnect).toHaveBeenCalledTimes(1);
    expect(useConnectionStore.getState().state).toBe('reconnecting');
    vi.useRealTimers();
  });

  it('ticket failure does not immediately go offline', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockRejectedValue(new Error('Ticket timeout'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('reconnecting');
  });

  it('ticket auth failure returns to login instead of reconnecting forever', async () => {
    vi.useFakeTimers();
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: true, authProviders: ['basic'] });
    vi.mocked(restMock.me).mockResolvedValue({ userId: 'u-1', displayName: 'Alice', provider: 'basic', expiresAt: 0 });
    vi.mocked(restMock.wsTicket).mockRejectedValue(new HermesHttpError(401, 'Unauthorized', 'expired'));
    window.localStorage.setItem('hermes-pwa.activeSession.v4:default', 'private');

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(useConnectionStore.getState().state).toBe('login');
    expect(useConnectionStore.getState().user).toBeUndefined();
    expect(useConnectionStore.getState().error).toMatch(/sign in again/i);
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(1);
  });

  it('duplicate close callbacks keep a single first-attempt reconnect timer', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    useConnectionStore.setState({ state: 'connected' });
    const call = vi.mocked(wsMock.connect).mock.calls[0];
    if (!call) throw new Error('wsMock.connect was not called');
    const onClose = call[3];

    onClose({} as CloseEvent);
    onClose({} as CloseEvent);
    await vi.advanceTimersByTimeAsync(500);

    expect(restMock.wsTicket).toHaveBeenCalledTimes(2);
    expect(wsMock.connect).toHaveBeenCalledTimes(2);
  });

  it('uses exponential reconnect backoff with jitter', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockRejectedValue(new Error('Ticket timeout'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    expect(restMock.wsTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(649);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1149);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(restMock.wsTicket).toHaveBeenCalledTimes(3);
  });

  it('caps reconnect delay and gives up after max attempts', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockRejectedValue(new Error('Ticket timeout'));

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    const retryDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000];
    for (const delay of retryDelays) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(restMock.wsTicket).toHaveBeenCalledTimes(11);
    expect(useConnectionStore.getState().state).toBe('offline');
    expect(useConnectionStore.getState().error).toMatch(/Could not reconnect/);
  });

  it('gives up on a server that accepts the socket and drops it before gateway.ready', async () => {
    // The attempt counter used to reset on every open, so a server (or
    // proxy) that completes the handshake and then closes at once kept the
    // client reconnecting forever instead of reaching offline.
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    const retryDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      const call = vi.mocked(wsMock.connect).mock.calls[attempt];
      if (!call) throw new Error(`connect attempt ${attempt} was not made`);
      call[1]();
      call[3]({ code: 1006, reason: '', wasClean: false } as CloseEvent);
      const delay = retryDelays[attempt];
      if (delay !== undefined) await vi.advanceTimersByTimeAsync(delay);
    }

    expect(wsMock.connect).toHaveBeenCalledTimes(11);
    expect(useConnectionStore.getState().state).toBe('offline');
    expect(useConnectionStore.getState().error).toMatch(/Could not reconnect/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wsMock.connect).toHaveBeenCalledTimes(11);
  });

  it('a gateway.ready resets the attempt counter so a later drop starts the backoff over', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    // Three handshakes that die before ready, then one that completes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const call = vi.mocked(wsMock.connect).mock.calls[attempt]!;
      call[1]();
      call[3]({ code: 1006, reason: '', wasClean: false } as CloseEvent);
      await vi.advanceTimersByTimeAsync(500 * 2 ** attempt);
    }
    const ready = vi.mocked(wsMock.connect).mock.calls[3]!;
    ready[1]();
    rpcMock.events.dispatchEvent({ type: 'gateway.ready' });
    expect(useConnectionStore.getState().state).toBe('connected');

    ready[3]({ code: 1006, reason: '', wasClean: false } as CloseEvent);
    expect(useConnectionStore.getState().state).toBe('reconnecting');
    // First retry after a fresh drop uses the shortest delay again.
    await vi.advanceTimersByTimeAsync(499);
    expect(wsMock.connect).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(wsMock.connect).toHaveBeenCalledTimes(5);
  });

  it('checkConnectedHealth probes a connected socket and reconnects when it no longer answers', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('JSON-RPC request timed out'));
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-2', ttlSeconds: 30 });
    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'connected', error: undefined });

    await store.checkConnectedHealth();

    expect(rpcMock.request).toHaveBeenCalledWith('session.usage', {}, { timeoutMs: 5000 });
    expect(useConnectionStore.getState().state).toBe('reconnecting');
    expect(wsMock.close).toHaveBeenCalled();
  });

  it('checkConnectedHealth does nothing unless connected', async () => {
    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    useConnectionStore.setState({ state: 'reconnecting', error: undefined });

    await store.checkConnectedHealth();

    expect(rpcMock.request).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().state).toBe('reconnecting');
  });

  it('close before gateway.ready does not allow a stale ready event to reconnect state', async () => {
    vi.mocked(restMock.status).mockResolvedValue({ authRequired: false, authProviders: [] });
    vi.mocked(restMock.wsTicket).mockResolvedValue({ ticket: 't-1', ttlSeconds: 30 });

    const store = useConnectionStore.getState();
    store.bindTransport(restMock, wsMock, rpcMock);
    await store.init();

    store.disconnect();
    rpcMock.events.dispatchEvent({ type: 'gateway.ready' });

    expect(useConnectionStore.getState().state).toBe('offline');
  });
});
