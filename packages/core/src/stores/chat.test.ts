import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LIVE_STREAM_QUIET_MS, LIVE_STREAM_STALE_MS, __setLiveEventAge, useChatStore } from './chat';
import { useSessionsStore } from './sessions';
import { HermesHttpError } from '../transport/http';
import { JsonRpcError, type RpcClient } from '../transport/jsonrpc';
import type { RestClient } from '../transport/rest';

describe('useChatStore', () => {
  let rpcMock: RpcClient;
  let restMock: RestClient;

  beforeEach(() => {
    window.localStorage.clear();
    __setLiveEventAge(undefined);
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined });
    useSessionsStore.setState({ sessions: [], loading: false, error: undefined, pinnedIds: [] });

    rpcMock = {
      request: vi.fn(),
      onFrame: vi.fn(),
      events: new EventTarget(),
    } as unknown as RpcClient;

    restMock = {
      profileSessions: vi.fn().mockResolvedValue([]),
      sessionMessages: vi.fn(),
    } as unknown as RestClient;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('setSessionId clears messages', () => {
    useChatStore.getState().setSessionId('s-1');
    expect(useChatStore.getState().sessionId).toBe('s-1');
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('submit creates session and adds user+assistant messages', async () => {
    vi.mocked(rpcMock.request)
      .mockResolvedValueOnce({ session_id: 's-1', stored_session_id: 'stored-1' })
      .mockResolvedValueOnce({ status: 'streaming' });
    const store = useChatStore.getState();
    await store.submit(rpcMock, 'hello');

    expect(useChatStore.getState().sessionId).toBe('s-1');
    expect(useChatStore.getState().storedSessionId).toBe('stored-1');
    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(useChatStore.getState().messages[0]?.role).toBe('user');
    expect(useChatStore.getState().messages[0]?.text).toBe('hello');
    expect(useChatStore.getState().messages[1]?.role).toBe('assistant');
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('submit passes profile to session.create', async () => {
    vi.mocked(rpcMock.request)
      .mockResolvedValueOnce({ session_id: 's-1' })
      .mockResolvedValueOnce({ status: 'streaming' });
    await useChatStore.getState().submit(rpcMock, 'hello', 'dev');
    expect(rpcMock.request).toHaveBeenNthCalledWith(1, 'session.create', { profile: 'dev' });
  });

  it('submit uses existing sessionId', async () => {
    useChatStore.setState({ sessionId: 's-2' });
    vi.mocked(rpcMock.request).mockResolvedValue({});
    const store = useChatStore.getState();
    await store.submit(rpcMock, 'world');

    expect(useChatStore.getState().sessionId).toBe('s-2');
    expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-2', text: 'world' }, { timeoutMs: 90_000 });
  });

  it('submit ignores duplicate non-slash sends while one submit is in flight', async () => {
    useChatStore.setState({ sessionId: 's-2' });
    let resolveSubmit: ((value: unknown) => void) | undefined;
    vi.mocked(rpcMock.request).mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }) as never,
    );

    const first = useChatStore.getState().submit(rpcMock, 'world');
    const second = useChatStore.getState().submit(rpcMock, 'world');
    resolveSubmit?.({});
    const results = await Promise.all([first, second]);

    expect(results).toEqual(['submitted', 'busy']);
    expect(rpcMock.request).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('submit in-flight guard is scoped by profile and session', async () => {
    useChatStore.setState({ sessionId: 'profile-a-live', storedSessionId: 'profile-a-stored', messages: [] });
    let resolveFirst: ((value: unknown) => void) | undefined;
    vi.mocked(rpcMock.request)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }) as never,
      )
      .mockResolvedValueOnce({ status: 'streaming' });

    const first = useChatStore.getState().submit(rpcMock, 'from a', 'profile-a');
    useChatStore.setState({ sessionId: 'profile-b-live', storedSessionId: 'profile-b-stored', messages: [] });
    const second = await useChatStore.getState().submit(rpcMock, 'from b', 'profile-b');
    resolveFirst?.({ status: 'streaming' });
    const firstResult = await first;

    expect(firstResult).toBe('submitted');
    expect(second).toBe('submitted');
    expect(rpcMock.request).toHaveBeenNthCalledWith(1, 'prompt.submit', { session_id: 'profile-a-live', text: 'from a' }, { timeoutMs: 90_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(2, 'prompt.submit', { session_id: 'profile-b-live', text: 'from b' }, { timeoutMs: 90_000 });
  });

  it('submit hides raw server bodies from user-facing chat errors', async () => {
    useChatStore.setState({ sessionId: 's-2' });
    vi.mocked(rpcMock.request).mockRejectedValue(
      new HermesHttpError(500, 'Internal Server Error', 'Traceback: SECRET server internals'),
    );

    await useChatStore.getState().submit(rpcMock, 'boom');

    expect(useChatStore.getState().error).toBe('Hermes server returned an error. Check the server logs, then try again.');
    expect(useChatStore.getState().error).not.toContain('Traceback');
    expect(useChatStore.getState().error).not.toContain('SECRET');
  });

  it('submit hides raw JSON-RPC server strings from user-facing chat errors', async () => {
    useChatStore.setState({ sessionId: 's-2' });
    vi.mocked(rpcMock.request).mockRejectedValue(
      new JsonRpcError({ code: 5000, message: 'Traceback: SECRET server internals' }),
    );

    await useChatStore.getState().submit(rpcMock, 'boom');

    expect(useChatStore.getState().error).toBe('Submit failed.');
    expect(useChatStore.getState().error).not.toContain('Traceback');
    expect(useChatStore.getState().error).not.toContain('SECRET');
  });

  it('history and restore paths hide raw JSON-RPC server strings in banners', async () => {
    const raw = new JsonRpcError({ code: 5000, message: 'Traceback: SECRET history internals' });
    vi.mocked(restMock.sessionMessages).mockRejectedValue(raw);
    vi.mocked(rpcMock.request).mockRejectedValue(raw);

    await expect(useChatStore.getState().loadHistory(restMock, 'stored-raw')).rejects.toThrow(JsonRpcError);
    expect(useChatStore.getState().error).toBe('Failed to load history.');
    expect(useChatStore.getState().error).not.toContain('Traceback');

    await expect(useChatStore.getState().resumeSessionIntoChat(restMock, rpcMock, 'stored-raw')).rejects.toThrow(JsonRpcError);
    expect(useChatStore.getState().error).toBe('Failed to open session.');
    expect(useChatStore.getState().error).not.toContain('SECRET');

    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:default',
      JSON.stringify({ storedSessionId: 'stored-raw', messages: [{ id: 'u-1', role: 'user', text: 'cached' }], streaming: false, profile: 'default' }),
    );
    await useChatStore.getState().restore(restMock, rpcMock, 'default');
    expect(useChatStore.getState().error).toBe('Failed to restore session.');
    expect(useChatStore.getState().error).not.toContain('SECRET');
  });

  it('preserves backend transcript order when message timestamps move backward', async () => {
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-order',
      messages: [
        { id: 'm-1', role: 'user', content: 'old root user', timestamp: 1_782_550_574 },
        { id: 'm-2', role: 'assistant', content: 'old root assistant', timestamp: 1_782_550_586 },
        // Real Hermes compression/history rows can contain a newly inserted user
        // message followed by restored assistant/tool rows with older timestamps.
        // The backend REST history endpoint returns insertion/id order; PWA must
        // not re-sort by timestamp or the assistant rows jump above their user.
        { id: 'm-3', role: 'user', content: 'current user after compression', timestamp: 1_782_639_282 },
        { id: 'm-4', role: 'assistant', content: 'assistant row with older timestamp', timestamp: 1_782_615_318 },
      ],
    });

    await useChatStore.getState().loadHistory(restMock, 'stored-order');

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual([
      'old root user',
      'old root assistant',
      'current user after compression',
      'assistant row with older timestamp',
    ]);
  });

  it('routes slash commands through slash.exec instead of prompt.submit', async () => {
    useChatStore.setState({ sessionId: 's-2', messages: [] });
    vi.mocked(rpcMock.request).mockResolvedValueOnce({ output: 'Profile: default' });

    await useChatStore.getState().submit(rpcMock, '/profile');

    expect(rpcMock.request).toHaveBeenCalledWith('slash.exec', { session_id: 's-2', command: 'profile' }, { timeoutMs: 300_000 });
    expect(rpcMock.request).not.toHaveBeenCalledWith('prompt.submit', expect.anything());
    expect(useChatStore.getState().streaming).toBe(false);
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'system',
      text: expect.stringContaining('Profile: default'),
    });
  });

  it('falls back to command.dispatch for structured slash commands', async () => {
    useChatStore.setState({ sessionId: 's-2', messages: [] });
    vi.mocked(rpcMock.request)
      .mockRejectedValueOnce(new Error('4018 use command.dispatch'))
      .mockResolvedValueOnce({ type: 'exec', output: 'queued' });

    await useChatStore.getState().submit(rpcMock, '/queue hello');

    expect(rpcMock.request).toHaveBeenNthCalledWith(1, 'slash.exec', { session_id: 's-2', command: 'queue hello' }, { timeoutMs: 300_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(2, 'command.dispatch', {
      session_id: 's-2',
      name: 'queue',
      arg: 'hello',
    }, { timeoutMs: 300_000 });
    expect(rpcMock.request).not.toHaveBeenCalledWith('prompt.submit', { session_id: 's-2', text: '/queue hello' });
    expect(useChatStore.getState().messages.at(-1)?.text).toContain('queued');
  });

  it('stops alias-dispatch cycles instead of recursing indefinitely', async () => {
    useChatStore.setState({ sessionId: 's-2', messages: [] });
    vi.mocked(rpcMock.request)
      .mockRejectedValueOnce(new Error('4018 use command.dispatch'))
      .mockResolvedValueOnce({ type: 'alias', target: '/loop' });

    const result = await useChatStore.getState().submit(rpcMock, '/loop');

    expect(result).toBe('failed');
    expect(rpcMock.request).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().messages.at(-1)?.text).toContain('alias dispatch cycle detected');
  });

  it('executes /new locally without creating a backend prompt', async () => {
    useChatStore.setState({
      sessionId: 's-2',
      storedSessionId: 'stored-2',
      streaming: true,
      messages: [{ id: 'm-1', role: 'assistant', text: 'old', createdAt: undefined }],
    });

    await useChatStore.getState().submit(rpcMock, '/new');

    expect(rpcMock.request).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('renders /help from the filtered command catalog without slash.exec ANSI output', async () => {
    vi.mocked(rpcMock.request).mockResolvedValueOnce({
      categories: [
        { name: 'Info', pairs: [['/help', '\u001b[1mShow available commands\u001b[0m'], ['/whoami', 'Show access']] },
      ],
    });

    await useChatStore.getState().submit(rpcMock, '/help');

    expect(rpcMock.request).toHaveBeenCalledTimes(1);
    expect(rpcMock.request).toHaveBeenCalledWith('commands.catalog', {});
    expect(rpcMock.request).not.toHaveBeenCalledWith('slash.exec', expect.anything());
    const message = useChatStore.getState().messages.at(-1);
    expect(message?.text).toContain('Available commands');
    expect(message?.text).toContain('`/help` — Show available commands');
    expect(message?.text).not.toContain('/whoami');
    expect(message?.text).not.toContain('\u001b');
  });

  it('does not send unsupported /whoami to slash.exec', async () => {
    await useChatStore.getState().submit(rpcMock, '/whoami');

    expect(rpcMock.request).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages.at(-1)?.text).toContain('not available in PWA chat');
  });

  it('strips ANSI escapes from slash output before rendering', async () => {
    useChatStore.setState({ sessionId: 's-2', messages: [] });
    vi.mocked(rpcMock.request).mockResolvedValueOnce({ output: '\u001b[1;31mUnknown command\u001b[0m' });

    await useChatStore.getState().submit(rpcMock, '/profile');

    const message = useChatStore.getState().messages.at(-1)?.text ?? '';
    expect(message).toContain('Unknown command');
    expect(message).not.toContain('\u001b');
  });

  it('command.dispatch send payload is submitted as a prompt', async () => {
    useChatStore.setState({ sessionId: 's-2', messages: [] });
    vi.mocked(rpcMock.request)
      .mockRejectedValueOnce(new Error('4018 use command.dispatch'))
      .mockResolvedValueOnce({ type: 'send', message: 'resolved prompt' })
      .mockResolvedValueOnce({ status: 'streaming' });

    await useChatStore.getState().submit(rpcMock, '/queue resolved prompt');

    expect(rpcMock.request).toHaveBeenNthCalledWith(1, 'slash.exec', { session_id: 's-2', command: 'queue resolved prompt' }, { timeoutMs: 300_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(2, 'command.dispatch', {
      session_id: 's-2',
      name: 'queue',
      arg: 'resolved prompt',
    }, { timeoutMs: 300_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(3, 'prompt.submit', { session_id: 's-2', text: 'resolved prompt' }, { timeoutMs: 90_000 });
  });

  it('submit resumes durable session and retries when cached live session is gone', async () => {
    useChatStore.setState({
      sessionId: 'dead-live',
      storedSessionId: 'stored-1',
      messages: [{ id: 'm-old', role: 'assistant', text: 'old', createdAt: undefined }],
    });
    useSessionsStore.setState({
      sessions: [{ id: 'stored-1', title: 'Local stored', updatedAt: 1, messageCount: 1, profile: 'dev' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(rpcMock.request)
      .mockRejectedValueOnce(new Error('4001 session not found'))
      .mockResolvedValueOnce({ session_id: 'live-2', session_key: 'stored-1', messages: [] })
      .mockResolvedValueOnce({ status: 'streaming' });

    await useChatStore.getState().submit(rpcMock, 'retry me', 'dev');

    expect(rpcMock.request).toHaveBeenNthCalledWith(1, 'prompt.submit', {
      session_id: 'dead-live',
      text: 'retry me',
    }, { timeoutMs: 90_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(2, 'session.resume', {
      session_id: 'stored-1',
      profile: 'dev',
    }, { timeoutMs: 300_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(3, 'prompt.submit', {
      session_id: 'live-2',
      text: 'retry me',
    }, { timeoutMs: 90_000 });
    expect(useChatStore.getState().sessionId).toBe('live-2');
    expect(useChatStore.getState().storedSessionId).toBe('stored-1');
    expect(useChatStore.getState().error).toBeUndefined();
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['old', 'retry me', '']);
  });

  it('submit creates a fresh session and retries when cached live session has no durable fallback', async () => {
    useChatStore.setState({ sessionId: 'dead-live', storedSessionId: undefined, messages: [] });
    vi.mocked(rpcMock.request)
      .mockRejectedValueOnce(new Error('4001 session not found'))
      .mockResolvedValueOnce({ session_id: 'live-new', stored_session_id: 'stored-new' })
      .mockResolvedValueOnce({ status: 'streaming' });

    await useChatStore.getState().submit(rpcMock, 'new please', 'dev');

    expect(rpcMock.request).toHaveBeenNthCalledWith(1, 'prompt.submit', {
      session_id: 'dead-live',
      text: 'new please',
    }, { timeoutMs: 90_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(2, 'session.create', { profile: 'dev' });
    expect(rpcMock.request).toHaveBeenNthCalledWith(3, 'prompt.submit', {
      session_id: 'live-new',
      text: 'new please',
    }, { timeoutMs: 90_000 });
    expect(useChatStore.getState().sessionId).toBe('live-new');
    expect(useChatStore.getState().storedSessionId).toBe('stored-new');
  });

  it('submit treats raw JSON-RPC 4001 objects as session-not-found and retries', async () => {
    useChatStore.setState({ sessionId: 'dead-live', storedSessionId: undefined, messages: [] });
    vi.mocked(rpcMock.request)
      .mockRejectedValueOnce({ code: 4001, message: 'session not found' })
      .mockResolvedValueOnce({ session_id: 'live-new', stored_session_id: 'stored-new' })
      .mockResolvedValueOnce({ status: 'streaming' });

    await useChatStore.getState().submit(rpcMock, 'raw retry', 'dev');

    expect(rpcMock.request).toHaveBeenNthCalledWith(2, 'session.create', { profile: 'dev' });
    expect(rpcMock.request).toHaveBeenNthCalledWith(3, 'prompt.submit', {
      session_id: 'live-new',
      text: 'raw retry',
    }, { timeoutMs: 90_000 });
    expect(useChatStore.getState().error).toBeUndefined();
  });

  it('cold-start hydrates profile-scoped active cache synchronously before restore runs', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:default',
      JSON.stringify({
        profile: 'default',
        sessionId: 'live-1',
        storedSessionId: 'stored-1',
        streaming: true,
        messages: [{ id: 'cached-1', role: 'assistant', text: 'cached transcript', createdAt: 1 }],
      }),
    );

    vi.resetModules();
    const { useChatStore: freshChatStore } = await import('./chat');

    expect(freshChatStore.getState().sessionId).toBe('live-1');
    expect(freshChatStore.getState().storedSessionId).toBe('stored-1');
    expect(freshChatStore.getState().messages.map((m) => m.text)).toEqual(['cached transcript']);
    expect(freshChatStore.getState().streaming).toBe(false);
    expect(freshChatStore.getState().cacheProfile).toBe('default');
  });

  it('restore without cached session leaves chat empty instead of auto-resuming most_recent', async () => {
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'recent-stored' });

    await useChatStore.getState().restore(restMock, rpcMock, 'default');

    expect(rpcMock.request).not.toHaveBeenCalledWith('session.most_recent', {});
    expect(rpcMock.request).not.toHaveBeenCalledWith('session.resume', expect.anything());
    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('restore ignores legacy active-session cache so old smoke sessions do not reopen', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v1',
      JSON.stringify({
        sessionId: 'old-live',
        storedSessionId: 'old-stored',
        messages: [{ id: 'old-a', role: 'assistant', text: 'old smoke transcript', createdAt: 1 }],
        streaming: false,
      }),
    );
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v2',
      JSON.stringify({
        sessionId: 'old-live-2',
        storedSessionId: 'old-stored-2',
        messages: [{ id: 'old-a-2', role: 'assistant', text: 'old smoke transcript v2', createdAt: 1 }],
        streaming: false,
      }),
    );

    await useChatStore.getState().restore(restMock, rpcMock, 'default');

    expect(restMock.sessionMessages).not.toHaveBeenCalled();
    expect(rpcMock.request).not.toHaveBeenCalledWith('session.resume', expect.anything());
    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v1')).toBeNull();
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v2')).toBeNull();
  });

  it('appendDelta patches last assistant message', () => {
    useChatStore.setState({
      messages: [
        { id: '1', role: 'user', text: 'hi', createdAt: undefined },
        { id: '2', role: 'assistant', text: 'Hel', createdAt: undefined },
      ],
    });
    useChatStore.getState().appendDelta('lo');
    expect(useChatStore.getState().messages[1]?.text).toBe('Hello');
  });

  it('throttles active-session persistence during many streaming deltas', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(window.localStorage.__proto__, 'setItem');
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      cacheProfile: 'default',
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });

    for (let i = 0; i < 20; i += 1) {
      useChatStore.getState().appendDelta(String(i));
    }

    expect(useChatStore.getState().messages[0]?.text).toContain('19');
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('finishAssistant flushes throttled persisted final message', () => {
    vi.useFakeTimers();
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      cacheProfile: 'default',
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });

    useChatStore.getState().appendDelta('partial');
    useChatStore.getState().finishAssistant('final answer');

    const raw = window.localStorage.getItem('hermes-pwa.activeSession.v4:default');
    expect(raw).toContain('final answer');
    expect(raw).not.toContain('partial');
  });

  it('visibility hidden flushes pending streaming persistence', () => {
    vi.useFakeTimers();
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      cacheProfile: 'default',
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });

    useChatStore.getState().appendDelta('saved before background');
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toBeNull();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toContain('saved before background');
  });

  it('pagehide flushes pending streaming persistence', () => {
    vi.useFakeTimers();
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      cacheProfile: 'default',
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });

    useChatStore.getState().appendDelta('saved on pagehide');
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toBeNull();

    window.dispatchEvent(new Event('pagehide'));

    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toContain('saved on pagehide');
  });

  it('finishAssistant sets streaming false', () => {
    useChatStore.setState({ streaming: true });
    useChatStore.getState().finishAssistant();
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('finishAssistant clears thinking when it duplicates the final answer', () => {
    const duplicate =
      'The logical next step is to **finish the PWA approval/todo test**, because we started it and left two pending.\n\nHere is what I would do:\n\n1. Mark the second item in_progress.';
    useChatStore.setState({
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: duplicate.slice(0, 60), thinking: duplicate, createdAt: undefined }],
    });

    useChatStore.getState().finishAssistant(duplicate.replace(/\*\*/g, ''));

    expect(useChatStore.getState().messages[0]?.thinking).toBeUndefined();
    expect(useChatStore.getState().messages[0]?.text).toContain('The logical next step');
  });

  it('finishAssistant clears short thinking when it exactly duplicates the final answer', () => {
    const duplicate = 'Online. Updated the todo.';
    useChatStore.setState({
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', thinking: duplicate, createdAt: undefined }],
    });

    useChatStore.getState().finishAssistant(duplicate);

    expect(useChatStore.getState().messages[0]?.thinking).toBeUndefined();
    expect(useChatStore.getState().messages[0]?.text).toBe(duplicate);
  });

  it('finishAssistant clears reasoning that contains the final answer with a preamble', () => {
    const answer = 'The actual cause is not bubble rendering but a stalled backend compression before the reply.';
    const reasoning = `I checked the logs and compared event flow.\n\nFinal answer:\n${answer}`;
    useChatStore.setState({
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', thinking: reasoning, createdAt: undefined }],
    });

    useChatStore.getState().finishAssistant(answer);

    expect(useChatStore.getState().messages[0]?.thinking).toBeUndefined();
    expect(useChatStore.getState().messages[0]?.text).toBe(answer);
  });

  it('preserves non-duplicate provider reasoning on finishAssistant', () => {
    const reasoning = 'I need to compare the event stream, inspect the donor implementation, and decide where status belongs before changing code.';
    const answer = 'I checked the event stream. The fix is to keep status outside the Thinking panel.';
    useChatStore.setState({
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: answer, thinking: reasoning, createdAt: undefined }],
    });

    useChatStore.getState().finishAssistant(answer);

    expect(useChatStore.getState().messages[0]?.thinking).toBe(reasoning);
  });

  it('appendToolCall adds tool to last assistant message', () => {
    useChatStore.setState({
      messages: [{ id: '1', role: 'assistant', text: '', createdAt: undefined }],
    });
    useChatStore.getState().appendToolCall({ id: 't-1', name: 'search' });
    const last = useChatStore.getState().messages[0];
    expect(last?.toolCalls).toHaveLength(1);
    expect(last?.toolCalls?.[0]?.name).toBe('search');
  });

  it('keeps one assistant message through interleaved delta, tool, output, and finish events', () => {
    useChatStore.setState({
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });

    useChatStore.getState().appendDelta('Checking ');
    useChatStore.getState().appendToolCall({ id: 'tool-1', name: 'terminal', input: { command: 'date' } });
    useChatStore.getState().appendDelta('the clock');
    useChatStore.getState().updateToolCall('tool-1', { output: 'Thu Jun 25 19:24:00 UTC 2026' });
    useChatStore.getState().finishAssistant('The clock was checked.');

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'assistant', text: 'The clock was checked.' });
    expect(messages[0]?.toolCalls).toEqual([
      { id: 'tool-1', name: 'terminal', input: { command: 'date' }, output: 'Thu Jun 25 19:24:00 UTC 2026' },
    ]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('dedupes optimistic user and assistant echo while preserving pending local tool calls', async () => {
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      messages: [
        { id: 'u-local', role: 'user', text: 'Run date', createdAt: undefined },
        {
          id: 'a-local',
          role: 'assistant',
          text: 'I will run date.',
          createdAt: undefined,
          toolCalls: [{ id: 'tool-local', name: 'terminal', input: { command: 'date' } }],
        },
      ],
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [
        { id: 'u-db', role: 'user', text: 'Run date' },
        { id: 'a-db', role: 'assistant', text: 'I will run date.' },
      ],
    });

    await useChatStore.getState().loadHistory(restMock, 'live-1');

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:Run date', 'assistant:I will run date.']);
    expect(messages[1]?.toolCalls).toEqual([{ id: 'tool-local', name: 'terminal', input: { command: 'date' } }]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('interrupt calls session.interrupt', async () => {
    useChatStore.setState({ sessionId: 's-1', streaming: true });
    vi.mocked(rpcMock.request).mockResolvedValue({});
    await useChatStore.getState().interrupt(rpcMock);
    expect(rpcMock.request).toHaveBeenCalledWith('session.interrupt', { session_id: 's-1' });
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('interrupt ignores duplicate clicks while one interrupt is in flight', async () => {
    useChatStore.setState({ sessionId: 's-1', streaming: true });
    let resolveInterrupt: ((value: unknown) => void) | undefined;
    vi.mocked(rpcMock.request).mockReturnValue(
      new Promise((resolve) => {
        resolveInterrupt = resolve;
      }) as never,
    );

    const first = useChatStore.getState().interrupt(rpcMock);
    const second = useChatStore.getState().interrupt(rpcMock);
    resolveInterrupt?.({});
    await Promise.all([first, second]);

    expect(rpcMock.request).toHaveBeenCalledTimes(1);
  });

  it('loadHistory accepts backend history envelope', async () => {
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      count: 2,
      messages: [
        { id: 'm-1', role: 'user', text: 'hi' },
        { id: 'm-2', role: 'assistant', text: 'hello' },
      ],
    });
    await useChatStore.getState().loadHistory(restMock, 'live-1');
    expect(restMock.sessionMessages).toHaveBeenCalledWith('live-1');
    expect(useChatStore.getState().sessionId).toBe('live-1');
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['hi', 'hello']);
  });

  it('loadHistory preserves cached in-flight assistant missing from lagging REST history', async () => {
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      messages: [
        { id: 'old-a', role: 'assistant', text: 'old reply', createdAt: undefined },
        { id: 'u-local', role: 'user', text: 'Status?', createdAt: undefined },
        { id: 'a-local', role: 'assistant', text: 'working...', createdAt: undefined },
      ],
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [
        { id: 'db-old-a', role: 'assistant', text: 'old reply' },
        { id: 'db-u', role: 'user', text: 'Status?' },
      ],
    });

    await useChatStore.getState().loadHistory(restMock, 'live-1');

    expect(useChatStore.getState().messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'assistant:old reply',
      'user:Status?',
      'assistant:working...',
    ]);
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('loadHistory dedupes optimistic user but keeps following assistant placeholder', async () => {
    useChatStore.setState({
      sessionId: 'live-1',
      streaming: true,
      messages: [
        { id: 'u-local', role: 'user', text: 'Hello', createdAt: undefined },
        { id: 'a-local', role: 'assistant', text: '', createdAt: undefined },
      ],
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [{ id: 'db-u', role: 'user', text: 'Hello' }],
    });

    await useChatStore.getState().loadHistory(restMock, 'live-1');

    expect(useChatStore.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['Hello', '']);
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('beginAssistant creates assistant placeholder after stale history ending with user', () => {
    useChatStore.setState({
      sessionId: 'live-1',
      streaming: false,
      messages: [{ id: 'u-1', role: 'user', text: 'Status?', createdAt: undefined }],
    });

    useChatStore.getState().beginAssistant();

    expect(useChatStore.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('restore rebinds durable session before trusting a cached live id', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:dev',
      JSON.stringify({
        profile: 'dev',
        sessionId: 'dead-live',
        storedSessionId: 'stored-1',
        messages: [{ id: 'cached-1', role: 'assistant', text: 'cached', createdAt: 1 }],
      }),
    );
    vi.mocked(restMock.sessionMessages).mockResolvedValue({ messages: [{ id: 'm-1', role: 'assistant', text: 'restored history' }] });
    useSessionsStore.setState({
      sessions: [{ id: 'stored-1', title: 'Local stored', updatedAt: 1, messageCount: 1, profile: 'dev' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(rpcMock.request)
      .mockRejectedValueOnce(new Error('4001 session not found'))
      .mockResolvedValueOnce({ session_id: 'live-1', session_key: 'stored-1', messages: [] });

    await useChatStore.getState().restore(restMock, rpcMock, 'dev');

    expect(restMock.sessionMessages).toHaveBeenCalledTimes(1);
    expect(restMock.sessionMessages).toHaveBeenCalledWith('stored-1', 'dev');
    expect(rpcMock.request).toHaveBeenCalledWith('session.resume', { session_id: 'stored-1', profile: 'dev' }, { timeoutMs: 300_000 });
    expect(useChatStore.getState().sessionId).toBe('live-1');
    expect(useChatStore.getState().storedSessionId).toBe('stored-1');
    expect(useChatStore.getState().messages[0]?.text).toBe('restored history');
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('restore reuses a live cached runtime but refreshes known local durable history', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:dev',
      JSON.stringify({
        profile: 'dev',
        sessionId: 'live-ok',
        storedSessionId: 'stored-ok',
        messages: [{ id: 'cached-1', role: 'assistant', text: 'cached', createdAt: 1 }],
      }),
    );
    useSessionsStore.setState({
      sessions: [{ id: 'stored-ok', title: 'Local session', updatedAt: 2, messageCount: 2, profile: 'dev' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'live-ok', running: false });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-ok',
      messages: [
        { id: 'cached-1', role: 'assistant', text: 'cached', created_at: 1 },
        { id: 'local-latest', role: 'user', text: 'new local message', created_at: 2 },
      ],
    });

    await useChatStore.getState().restore(restMock, rpcMock, 'dev');

    expect(rpcMock.request).toHaveBeenCalledWith('session.activate', { session_id: 'live-ok', omit_messages: true }, { timeoutMs: 15_000 });
    expect(rpcMock.request).not.toHaveBeenCalledWith('session.resume', expect.anything());
    expect(restMock.sessionMessages).toHaveBeenCalledWith('stored-ok', 'dev');
    expect(useChatStore.getState().sessionId).toBe('live-ok');
    expect(useChatStore.getState().storedSessionId).toBe('stored-ok');
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['cached', 'new local message']);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('restore loads the cache scoped to the active profile', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:default',
      JSON.stringify({
        profile: 'default',
        sessionId: 'default-live',
        storedSessionId: 'default-stored',
        messages: [{ id: 'default-cached', role: 'assistant', text: 'default cached', createdAt: 1 }],
      }),
    );
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:dev',
      JSON.stringify({
        profile: 'dev',
        sessionId: 'dev-live',
        storedSessionId: 'dev-stored',
        messages: [{ id: 'dev-cached', role: 'assistant', text: 'dev cached', createdAt: 1 }],
      }),
    );
    useSessionsStore.setState({
      sessions: [{ id: 'dev-stored', title: 'Dev session', updatedAt: 2, messageCount: 1, profile: 'dev' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(rpcMock.request).mockRejectedValueOnce(new Error('4001 session not found')).mockResolvedValueOnce({
      session_id: 'dev-live-new',
      session_key: 'dev-stored',
      messages: [],
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [{ id: 'dev-restored', role: 'assistant', text: 'dev restored' }],
    });

    await useChatStore.getState().restore(restMock, rpcMock, 'dev');

    expect(restMock.sessionMessages).toHaveBeenCalledWith('dev-stored', 'dev');
    expect(rpcMock.request).toHaveBeenCalledWith('session.resume', { session_id: 'dev-stored', profile: 'dev' }, { timeoutMs: 300_000 });
    expect(useChatStore.getState().sessionId).toBe('dev-live-new');
    expect(useChatStore.getState().storedSessionId).toBe('dev-stored');
    // REST is the source of truth for finished turns; a stale cached reply is not re-appended.
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['dev restored']);
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toContain('default cached');
  });

  it('restore rejects an explicit foreign-profile legacy cache entry', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v3',
      JSON.stringify({
        profile: 'default',
        sessionId: 'default-live',
        storedSessionId: 'default-stored',
        messages: [{ id: 'default-cached', role: 'assistant', text: 'default cached', createdAt: 1 }],
      }),
    );

    await useChatStore.getState().restore(restMock, rpcMock, 'dev');

    expect(restMock.sessionMessages).not.toHaveBeenCalled();
    expect(rpcMock.request).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v3')).toBeNull();
  });

  it('startNewSession clears only the active profile cache', () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:default',
      JSON.stringify({ profile: 'default', sessionId: 'default-live', storedSessionId: 'default-stored', messages: [] }),
    );
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:dev',
      JSON.stringify({ profile: 'dev', sessionId: 'dev-live', storedSessionId: 'dev-stored', messages: [] }),
    );
    useChatStore.setState({ sessionId: 'dev-live', storedSessionId: 'dev-stored', cacheProfile: 'dev' });

    useChatStore.getState().startNewSession('dev');

    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:dev')).toBeNull();
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toContain('default-live');
    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
  });

  it('refreshHistory pulls new durable messages without rebinding a live runtime', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 'stored-ok', title: 'Local session', updatedAt: 2, messageCount: 2, profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    useChatStore.setState({
      sessionId: 'live-ok',
      storedSessionId: 'stored-ok',
      messages: [{ id: 'cached-1', role: 'assistant', text: 'cached', createdAt: 1 }],
      streaming: false,
      error: undefined,
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-ok',
      messages: [
        { id: 'cached-1', role: 'assistant', text: 'cached', created_at: 1 },
        { id: 'local-latest', role: 'user', text: 'latest local text', created_at: 2 },
      ],
    });

    await useChatStore.getState().refreshHistory(restMock, 'default');

    expect(restMock.sessionMessages).toHaveBeenCalledWith('stored-ok', 'default');
    expect(rpcMock.request).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessionId).toBe('live-ok');
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['cached', 'latest local text']);
  });

  it('refreshHistory preserves a local pending tool row when REST has the same assistant message without tool calls', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 'stored-approval', title: 'Approval session', updatedAt: 2, messageCount: 1, profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    useChatStore.setState({
      sessionId: 'live-approval',
      storedSessionId: 'stored-approval',
      messages: [
        {
          id: 'local-assistant',
          role: 'assistant',
          text: '',
          createdAt: 1,
          toolCalls: [{ id: 'tool-approval', name: 'terminal', input: { command: 'rm -rf /tmp/example' } }],
        },
      ],
      streaming: false,
      error: undefined,
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-approval',
      messages: [{ id: 'rest-assistant', role: 'assistant', text: '', created_at: 1 }],
    });

    await useChatStore.getState().refreshHistory(restMock, 'default');

    const message = useChatStore.getState().messages[0];
    expect(message?.toolCalls).toHaveLength(1);
    expect(message?.toolCalls?.[0]?.name).toBe('terminal');
    expect(message?.toolCalls?.[0]?.input).toEqual({ command: 'rm -rf /tmp/example' });
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('refreshHistory does not duplicate turns when Hermes rewrote the prompt and split the reply', async () => {
    // Observed live: Hermes expands @file: refs in the stored user text, stores a
    // tool-using reply as two assistant rows and drops reasoning. Text-based
    // matching left every local message behind as a duplicate tail.
    useSessionsStore.setState({
      sessions: [{ id: 'stored-dup', title: 'Dup', updatedAt: 5, messageCount: 4, profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    useChatStore.setState({
      sessionId: 'live-dup',
      storedSessionId: 'stored-dup',
      messages: [
        { id: 'u1', role: 'user', text: 'Print two paths', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: '/tmp/a.png\n/tmp/b.csv', thinking: 'thinking about paths', createdAt: 2 },
        { id: 'u2', role: 'user', text: 'What colors?\n\n@file:attachments/gradient.png', createdAt: 3 },
        {
          id: 'a2',
          role: 'assistant',
          text: 'A gradient of blue and pink.',
          thinking: 'I should look at the image.',
          createdAt: 4,
          toolCalls: [{ id: 'toolu_1', name: 'vision_analyze', input: { image_url: '/tmp/gradient.png' }, output: 'Image loaded' }],
        },
      ],
      streaming: false,
      error: undefined,
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-dup',
      messages: [
        { id: '205', role: 'user', text: 'Print two paths', created_at: 1 },
        { id: '206', role: 'assistant', text: '/tmp/a.png\n/tmp/b.csv', created_at: 2 },
        { id: '207', role: 'user', text: 'What colors? [attachment: /Users/x/.hermes/attachments/gradient.png]', created_at: 3 },
        { id: '208', role: 'assistant', text: '', created_at: 4, tool_calls: [{ id: 'toolu_1', name: 'vision_analyze', arguments: { image_url: '/tmp/gradient.png' } }] },
        { id: '209', role: 'tool', tool_call_id: 'toolu_1', content: 'Image loaded', created_at: 4.5 },
        { id: '210', role: 'assistant', text: 'A gradient of blue and pink.', created_at: 5 },
      ],
    });

    await useChatStore.getState().refreshHistory(restMock, 'default');

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:Print two paths',
      'assistant:/tmp/a.png\n/tmp/b.csv',
      'user:What colors? [attachment: /Users/x/.hermes/attachments/gradient.png]',
      'assistant:A gradient of blue and pink.',
    ]);
    // The split reply is one bubble with the tool call attached and completed.
    expect(messages[3]?.toolCalls).toEqual([
      expect.objectContaining({ id: 'toolu_1', name: 'vision_analyze', output: 'Image loaded' }),
    ]);
  });

  it('refreshHistory keeps the live reply when REST only has the tool-call row so far', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 'stored-lag', title: 'Lag', updatedAt: 5, messageCount: 2, profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    useChatStore.setState({
      sessionId: 'live-lag',
      storedSessionId: 'stored-lag',
      messages: [
        { id: 'u1', role: 'user', text: 'Look at it', createdAt: 1 },
        {
          id: 'a1',
          role: 'assistant',
          text: 'It is blue.',
          createdAt: 2,
          toolCalls: [{ id: 'toolu_1', name: 'vision_analyze', output: 'ok' }],
        },
      ],
      streaming: false,
      error: undefined,
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-lag',
      messages: [
        { id: '1', role: 'user', text: 'Look at it', created_at: 1 },
        { id: '2', role: 'assistant', text: '', created_at: 2, tool_calls: [{ id: 'toolu_1', name: 'vision_analyze', arguments: {} }] },
      ],
    });

    await useChatStore.getState().refreshHistory(restMock, 'default');

    expect(useChatStore.getState().messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:Look at it',
      'assistant:It is blue.',
    ]);
  });

  it('refreshHistory drops a stale local tool-only assistant once REST has the completed answer', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 'stored-selfdiag', title: 'Self diagnostic', updatedAt: 2, messageCount: 2, profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    useChatStore.setState({
      sessionId: 'live-selfdiag',
      storedSessionId: 'stored-selfdiag',
      messages: [
        { id: 'u-local', role: 'user', text: 'PWA session check', createdAt: 1 },
        {
          id: 'a-local-tool-only',
          role: 'assistant',
          text: '',
          createdAt: 2,
          toolCalls: [{ id: 'todo-local', name: 'todo', output: '{"todos":[]}' }],
        },
      ],
      streaming: true,
      error: undefined,
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-selfdiag',
      messages: [
        { id: 'u-rest', role: 'user', text: 'PWA session check', created_at: 1 },
        { id: 'a-rest-final', role: 'assistant', text: 'Self-check complete. All good.', created_at: 2 },
      ],
    });
    // The stream went quiet long ago (the WebSocket died): the snapshot may reconcile.
    __setLiveEventAge(LIVE_STREAM_QUIET_MS + 1);

    await useChatStore.getState().refreshHistory(restMock, 'default');

    expect(useChatStore.getState().messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:PWA session check',
      'assistant:Self-check complete. All good.',
    ]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('restore does not open most recent durable session when no active cache exists', async () => {
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'stored-recent' });

    await useChatStore.getState().restore(restMock, rpcMock);

    expect(rpcMock.request).not.toHaveBeenCalledWith('session.most_recent', {});
    expect(rpcMock.request).not.toHaveBeenCalledWith('session.resume', expect.anything());
    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('restore never resurrects a stale streaming flag from cache (composer stays usable)', async () => {
    // Regression for "dead chat after dashboard restart": a page that reloaded
    // mid-stream persists streaming:true. On the next load there is no live
    // backend turn to clear it (message.complete/session.info will never fire
    // for a turn that no longer exists), so a resurrected streaming flag locks
    // the Composer into busy/queue mode and silently swallows every message.
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:dev',
      JSON.stringify({
        profile: 'dev',
        sessionId: 'live-1',
        storedSessionId: 'stored-1',
        streaming: true,
        messages: [
          { id: 'u-1', role: 'user', text: 'hi', createdAt: 1 },
          { id: 'a-1', role: 'assistant', text: '', createdAt: 2 },
        ],
      }),
    );
    // Lagging REST history is missing the in-flight assistant placeholder — the
    // exact shape that previously tripped keepStreaming into staying true.
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [{ id: 'db-u', role: 'user', text: 'hi' }],
    });

    await useChatStore.getState().restore(restMock, rpcMock, 'dev');

    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('resumeSessionIntoChat opens durable history, binds runtime, and stays idle', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 'stored-99', title: 'Local stored', updatedAt: 1, messageCount: 1, profile: 'dev' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [{ id: 'm-rest', role: 'assistant', text: 'from rest' }],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'live-99', session_key: 'stored-99', messages: [] });

    await useChatStore.getState().resumeSessionIntoChat(restMock, rpcMock, 'stored-99', 'dev');

    expect(restMock.sessionMessages).toHaveBeenCalledWith('stored-99', 'dev');
    expect(rpcMock.request).toHaveBeenCalledWith('session.resume', { session_id: 'stored-99', profile: 'dev' }, { timeoutMs: 300_000 });
    expect(useChatStore.getState().sessionId).toBe('live-99');
    expect(useChatStore.getState().storedSessionId).toBe('stored-99');
    expect(useChatStore.getState().messages[0]?.text).toBe('from rest');
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('keeps the turns Hermes folded away and drops the compaction handoff row', async () => {
    useSessionsStore.setState({
      sessions: [{ id: 'stored-77', title: 'Long chat', updatedAt: 1, messageCount: 4, profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [
        { id: 1, role: 'user', content: 'first question', compacted: 1, timestamp: 1 },
        { id: 2, role: 'assistant', content: 'first answer', compacted: 1, timestamp: 2 },
        { id: 3, role: 'assistant', content: '[PRIOR CONTEXT — for reference only; not a new message]\n[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.', compacted: 0, timestamp: 3 },
        { id: 4, role: 'user', content: 'latest question', compacted: 0, timestamp: 4 },
        { id: 5, role: 'assistant', content: 'latest answer', compacted: 0, timestamp: 5 },
      ],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'live-77', session_key: 'stored-77', messages: [] });

    await useChatStore.getState().resumeSessionIntoChat(restMock, rpcMock, 'stored-77', 'default');

    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['first question', 'first answer', 'latest question', 'latest answer']);
  });

  it('resumeSessionIntoChat canonicalizes a cached/root alias to the current openable local head id', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 'current-head',
          lineageRootId: 'root-chat',
          title: 'Local branch',
          updatedAt: 300,
          lastActive: 300,
          messageCount: 336,
          profile: 'default',
          source: 'tui',
        },
      ],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [{ id: 'm-head', role: 'assistant', text: 'fresh head' }],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'live-head', session_key: 'current-head', messages: [] });

    await useChatStore.getState().resumeSessionIntoChat(restMock, rpcMock, 'root-chat', 'default');

    expect(restMock.sessionMessages).toHaveBeenCalledWith('current-head', 'default');
    expect(rpcMock.request).toHaveBeenCalledWith('session.resume', { session_id: 'current-head', profile: 'default' }, { timeoutMs: 300_000 });
    expect(useChatStore.getState().storedSessionId).toBe('current-head');
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['fresh head']);
  });

  it('restore does not regress a known local lineage transcript when stale history opens', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 'current-head',
          lineageRootId: 'root-chat',
          title: 'Local branch',
          updatedAt: 300,
          lastActive: 300,
          messageCount: 336,
          profile: 'default',
          source: 'tui',
        },
      ],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:default',
      JSON.stringify({
        profile: 'default',
        sessionId: undefined,
        storedSessionId: 'root-chat',
        streaming: false,
        messages: [{ id: 'local-tail', role: 'user', text: 'latest local message' }],
      }),
    );
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [{ id: 'stale', role: 'assistant', text: 'old branch snapshot' }],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'live-head', session_key: 'current-head', messages: [] });

    await useChatStore.getState().restore(restMock, rpcMock, 'default');

    expect(restMock.sessionMessages).toHaveBeenCalledWith('current-head', 'default');
    expect(useChatStore.getState().storedSessionId).toBe('current-head');
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual([
      'old branch snapshot',
      'latest local message',
    ]);
  });

  it('submit from an opened durable session resumes it before prompt.submit', async () => {
    useChatStore.setState({
      sessionId: undefined,
      storedSessionId: 'stored-99',
      messages: [{ id: 'm-rest', role: 'assistant', text: 'from rest', createdAt: undefined }],
      streaming: false,
      error: undefined,
    });
    useSessionsStore.setState({
      sessions: [{ id: 'stored-99', title: 'Local stored', updatedAt: 1, messageCount: 1, profile: 'dev' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(rpcMock.request)
      .mockResolvedValueOnce({ session_id: 'live-99', session_key: 'stored-99', messages: [] })
      .mockResolvedValueOnce({ status: 'streaming' });

    await useChatStore.getState().submit(rpcMock, 'continue here', 'dev');

    expect(rpcMock.request).toHaveBeenNthCalledWith(1, 'session.resume', { session_id: 'stored-99', profile: 'dev' }, { timeoutMs: 300_000 });
    expect(rpcMock.request).toHaveBeenNthCalledWith(2, 'prompt.submit', { session_id: 'live-99', text: 'continue here' }, { timeoutMs: 90_000 });
    expect(useChatStore.getState().sessionId).toBe('live-99');
    expect(useChatStore.getState().storedSessionId).toBe('stored-99');
    expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(['from rest', 'continue here', '']);
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('startNewSession clears active cache without loading or deleting sessions', () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v3',
      JSON.stringify({ sessionId: 'live-1', storedSessionId: 'stored-1', messages: [{ id: 'm-1', role: 'user', text: 'x' }] }),
    );
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      messages: [{ id: 'm-1', role: 'user', text: 'x', createdAt: undefined }],
      streaming: true,
      error: 'old',
    });

    useChatStore.getState().startNewSession();

    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streaming).toBe(false);
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v3')).toBeNull();
  });

  it('loadHistory merges role=tool messages into matching assistant tool calls', async () => {
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [
        { id: 'm-1', role: 'user', text: 'hi' },
        {
          id: 'm-2',
          role: 'assistant',
          text: 'assistant final',
          tool_calls: [{ id: 't-1', name: 'search' }],
        },
        { id: 'm-3', role: 'tool', tool_call_id: 't-1', content: { results: ['a', 'b'] } },
      ],
    });

    await useChatStore.getState().loadHistory(restMock, 'live-1');

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.text).toBe('assistant final');
    expect(messages[1]?.toolCalls).toHaveLength(1);
    expect(messages[1]?.toolCalls?.[0]?.name).toBe('search');
    expect(messages[1]?.toolCalls?.[0]?.output).toBe('{"results":["a","b"]}');
  });

  it('loadHistory normalizes OpenAI-style tool_calls from stored history', async () => {
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          text: 'assistant final',
          tool_calls: [
            {
              id: 'call-1',
              function: { name: 'web_search', arguments: '{"query":"hermes"}' },
            },
          ],
        },
      ],
    });

    await useChatStore.getState().loadHistory(restMock, 'live-1');

    const message = useChatStore.getState().messages[0];
    const tool = message?.toolCalls?.[0];
    expect(message?.text).toBe('assistant final');
    expect(tool?.id).toBe('call-1');
    expect(tool?.name).toBe('web_search');
    expect(tool?.input).toEqual({ query: 'hermes' });
  });

  it('loadHistory preserves user text and assistant details from durable reload API shapes', async () => {
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [
        {
          id: 'u-array',
          role: 'user',
          content: [{ text: 'first user line' }, { content: 'second user line' }],
          timestamp: '2026-06-19T20:45:00Z',
        },
        {
          id: 'a-json-tools',
          role: 'assistant',
          content: { text: 'assistant final' },
          reasoning_content: 'assistant reasoning',
          tool_calls: JSON.stringify([
            { id: 'call-1', function: { name: 'terminal', arguments: '{"command":"date"}' } },
          ]),
          timestamp: 1781901900,
        },
      ],
    });

    await useChatStore.getState().loadHistory(restMock, 'live-1');

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.text).toBe('first user line\nsecond user line');
    expect(messages[0]?.createdAt).toBeGreaterThan(0);
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.text).toBe('assistant final');
    expect(messages[1]?.thinking).toBe('assistant reasoning');
    expect(messages[1]?.toolCalls?.[0]?.name).toBe('terminal');
    expect(messages[1]?.toolCalls?.[0]?.input).toEqual({ command: 'date' });
  });

  it('loadHistory handles non-array response', async () => {
    vi.mocked(restMock.sessionMessages).mockResolvedValue(null);
    await useChatStore.getState().loadHistory(restMock, 's-1');
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('submit handles error', async () => {
    useChatStore.setState({ sessionId: 's-1' });
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('fail'));
    await useChatStore.getState().submit(rpcMock, 'hello');
    expect(useChatStore.getState().streaming).toBe(false);
    expect(useChatStore.getState().error).toBe('fail');
  });

  it('interrupt handles error', async () => {
    useChatStore.setState({ sessionId: 's-1' });
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('nope'));
    await useChatStore.getState().interrupt(rpcMock);
    expect(useChatStore.getState().error).toBe('nope');
  });

  it('appendDelta ignores non-assistant last message', () => {
    useChatStore.setState({ messages: [{ id: '1', role: 'user', text: 'hi', createdAt: undefined }] });
    useChatStore.getState().appendDelta('x');
    expect(useChatStore.getState().messages[0]?.text).toBe('hi');
  });

  it('appendToolCall ignores non-assistant last message', () => {
    useChatStore.setState({ messages: [{ id: '1', role: 'user', text: 'hi', createdAt: undefined }] });
    useChatStore.getState().appendToolCall({ id: 't-1', name: 'search' });
    expect(useChatStore.getState().messages[0]?.toolCalls).toBeUndefined();
  });

  it('clear resets everything', () => {
    useChatStore.setState({ sessionId: 's-1', messages: [{ id: '1', role: 'user', text: 'x', createdAt: undefined }], streaming: true });
    useChatStore.getState().clear();
    const state = useChatStore.getState();
    expect(state.sessionId).toBeUndefined();
    expect(state.messages).toEqual([]);
    expect(state.streaming).toBe(false);
  });
  describe('live stream vs REST refresh', () => {
    function liveTurn() {
      useSessionsStore.setState({
        sessions: [{ id: 'stored-live', title: 'Live', updatedAt: 2, messageCount: 2, profile: 'default' }],
        loading: false,
        error: undefined,
        pinnedIds: [],
      });
      useChatStore.setState({
        sessionId: 'live-1',
        storedSessionId: 'stored-live',
        messages: [
          { id: 'u-1', role: 'user', text: 'run the check', createdAt: 1 },
          { id: 'a-1', role: 'assistant', text: '', createdAt: 2, thinking: 'Looking at the repo', toolCalls: [{ id: 't-1', name: 'terminal' }] },
        ],
        streaming: true,
        error: undefined,
      });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    }

    it('leaves a turn alone while its events are still arriving', async () => {
      liveTurn();
      useChatStore.getState().appendThinking(' more');
      vi.mocked(restMock.sessionMessages).mockResolvedValue({
        session_id: 'stored-live',
        messages: [{ id: 'u-rest', role: 'user', text: 'run the check', created_at: 1 }],
      });
      const before = useChatStore.getState().messages;

      await useChatStore.getState().refreshHistory(restMock, 'default');

      expect(restMock.sessionMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toBe(before);
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('keeps streaming through a quiet tool call when REST has no finished answer yet', async () => {
      liveTurn();
      __setLiveEventAge(LIVE_STREAM_QUIET_MS + 1);
      vi.mocked(restMock.sessionMessages).mockResolvedValue({
        session_id: 'stored-live',
        messages: [{ id: 'u-rest', role: 'user', text: 'run the check', created_at: 1 }],
      });

      await useChatStore.getState().refreshHistory(restMock, 'default');

      expect(useChatStore.getState().streaming).toBe(true);
      const last = useChatStore.getState().messages.at(-1);
      expect(last?.role).toBe('assistant');
      expect(last?.thinking).toBe('Looking at the repo');
    });

    it('gives up on a turn that has been silent for a very long time', async () => {
      liveTurn();
      __setLiveEventAge(LIVE_STREAM_STALE_MS + 1);
      vi.mocked(restMock.sessionMessages).mockResolvedValue({
        session_id: 'stored-live',
        messages: [{ id: 'u-rest', role: 'user', text: 'run the check', created_at: 1 }],
      });

      await useChatStore.getState().refreshHistory(restMock, 'default');

      expect(useChatStore.getState().streaming).toBe(false);
    });

    it('hands back the same message objects when a refresh changes nothing', async () => {
      useSessionsStore.setState({
        sessions: [{ id: 'stored-idle', title: 'Idle', updatedAt: 2, messageCount: 2, profile: 'default' }],
        loading: false,
        error: undefined,
        pinnedIds: [],
      });
      const messages = [
        { id: '1', role: 'user' as const, text: 'hi', createdAt: 1 },
        { id: '2', role: 'assistant' as const, text: 'hello', createdAt: 2, completedAt: 2 },
      ];
      useChatStore.setState({ sessionId: 'live-idle', storedSessionId: 'stored-idle', messages, streaming: false, error: undefined });
      vi.mocked(restMock.sessionMessages).mockResolvedValue({
        session_id: 'stored-idle',
        messages: [
          { id: '1', role: 'user', text: 'hi', created_at: 1 },
          { id: '2', role: 'assistant', text: 'hello', created_at: 2 },
        ],
      });

      await useChatStore.getState().refreshHistory(restMock, 'default');

      expect(useChatStore.getState().messages).toBe(messages);
    });
  });

  describe('reply segments and skill turns', () => {
    it('separates interim commentary from the final answer and keeps both', () => {
      useChatStore.setState({
        sessionId: 's',
        messages: [
          { id: 'u', role: 'user', text: 'go', createdAt: 1 },
          { id: 'a', role: 'assistant', text: '', createdAt: 1 },
        ],
        streaming: true,
      });
      useChatStore.getState().appendDelta('Checking the file first.');
      useChatStore.getState().sealSegment();
      useChatStore.getState().sealSegment();
      useChatStore.getState().appendDelta('Done: the file is fine.');
      useChatStore.getState().finishAssistant('Done: the file is fine.');

      expect(useChatStore.getState().messages.at(-1)?.text).toBe('Checking the file first.\n\nDone: the file is fine.');
    });

    it('prefers the final text when the stream never delivered it', () => {
      useChatStore.setState({
        sessionId: 's',
        messages: [
          { id: 'u', role: 'user', text: 'go', createdAt: 1 },
          { id: 'a', role: 'assistant', text: 'partial', createdAt: 1 },
        ],
        streaming: true,
      });
      useChatStore.getState().finishAssistant('The complete answer.');
      expect(useChatStore.getState().messages.at(-1)?.text).toBe('The complete answer.');
    });

    it('shows a stored /skill turn as typed and hides rows Hermes marks hidden', async () => {
      useSessionsStore.setState({
        sessions: [{ id: 'stored-skill', title: 'Skill', updatedAt: 2, messageCount: 2, profile: 'default' }],
        loading: false,
        error: undefined,
        pinnedIds: [],
      });
      useChatStore.setState({ sessionId: 'live-skill', storedSessionId: 'stored-skill', messages: [], streaming: false, error: undefined });
      const scaffold = [
        '[IMPORTANT: The user has invoked the "obsidian" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
        '',
        '# Obsidian',
        'Lots of skill text here.',
        '',
        'The user has provided the following instruction alongside the skill invocation: find my notes on ApoB',
        '',
        '[Runtime note: something]',
      ].join('\n');
      vi.mocked(restMock.sessionMessages).mockResolvedValue({
        session_id: 'stored-skill',
        messages: [
          { id: '1', role: 'user', content: scaffold, timestamp: 1 },
          { id: '2', role: 'user', content: '[System: recovery nudge]', display_kind: 'hidden', timestamp: 1.5 },
          { id: '3', role: 'assistant', content: 'Here are your notes.', timestamp: 2 },
        ],
      });

      await useChatStore.getState().refreshHistory(restMock, 'default');

      const messages = useChatStore.getState().messages;
      expect(messages.map((m) => m.text)).toEqual(['/obsidian find my notes on ApoB', 'Here are your notes.']);
      expect(messages[0]?.displayKind).toBe('skill_invocation');
    });
  });
  describe('resyncLiveSession (socket came back)', () => {
    function reconnectFixture() {
      useSessionsStore.setState({
        sessions: [{ id: 'stored-r', title: 'Long task', updatedAt: 2, messageCount: 2, profile: 'default' }],
        loading: false,
        error: undefined,
        pinnedIds: [],
      });
      useChatStore.setState({
        sessionId: 'live-r',
        storedSessionId: 'stored-r',
        messages: [
          { id: 'u-1', role: 'user', text: 'do the long thing', createdAt: 1 },
          { id: 'a-1', role: 'assistant', text: 'Starting.', createdAt: 2 },
        ],
        streaming: true,
        error: undefined,
      });
    }

    it('re-attaches, replays the missed events, and keeps the turn working while the gateway says running', async () => {
      reconnectFixture();
      const replayed: unknown[] = [];
      const rpc = {
        request: vi.fn(async (method: string) => {
          if (method === 'session.activate') return { session_id: 'live-r', running: true };
          if (method === 'session.events.since') {
            return { events: [{ type: 'message.delta', session_id: 'live-r', payload: { text: ' Still going.' }, seq: 8 }], truncated: false, latest_seq: 8 };
          }
          return {};
        }),
        onFrame: vi.fn(),
        events: new EventTarget(),
        disconnect: vi.fn(),
        lastSeq: () => 7,
        replayEvent: (raw: unknown) => replayed.push(raw),
        replayEpoch: () => 'e1',
      } as unknown as RpcClient;

      const outcome = await useChatStore.getState().resyncLiveSession(restMock, rpc, 'default');

      expect(outcome).toBe('attached');
      expect(rpc.request).toHaveBeenCalledWith('session.activate', { session_id: 'live-r', omit_messages: true }, { timeoutMs: 15_000 });
      expect(rpc.request).toHaveBeenCalledWith('session.events.since', { session_id: 'live-r', last_seen: 7 }, { timeoutMs: 15_000 });
      expect(replayed).toHaveLength(1);
      expect(restMock.sessionMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it('falls back to the stored transcript when the replay ring moved on, and goes idle when the turn finished', async () => {
      reconnectFixture();
      vi.mocked(restMock.sessionMessages).mockResolvedValue({
        session_id: 'stored-r',
        messages: [
          { id: 'u-1', role: 'user', text: 'do the long thing', created_at: 1 },
          { id: 'a-1', role: 'assistant', text: 'Starting. All done, here is the result.', created_at: 2 },
        ],
      });
      const rpc = {
        request: vi.fn(async (method: string) => {
          if (method === 'session.activate') return { session_id: 'live-r', running: false };
          if (method === 'session.events.since') return { events: [], truncated: true };
          return {};
        }),
        onFrame: vi.fn(),
        events: new EventTarget(),
        disconnect: vi.fn(),
        lastSeq: () => 3,
        replayEvent: vi.fn(),
        replayEpoch: () => 'e1',
      } as unknown as RpcClient;

      const outcome = await useChatStore.getState().resyncLiveSession(restMock, rpc, 'default');

      expect(outcome).toBe('attached');
      expect(restMock.sessionMessages).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().messages.at(-1)?.text).toBe('Starting. All done, here is the result.');
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it('reports a reaped runtime so the caller can reopen the stored session', async () => {
      reconnectFixture();
      const rpc = {
        request: vi.fn(async (method: string) => {
          if (method === 'session.activate') throw new Error('4001 session not found');
          return {};
        }),
        onFrame: vi.fn(),
        events: new EventTarget(),
        disconnect: vi.fn(),
        lastSeq: () => 0,
        replayEvent: vi.fn(),
        replayEpoch: () => 'e1',
      } as unknown as RpcClient;

      const outcome = await useChatStore.getState().resyncLiveSession(restMock, rpc, 'default');

      expect(outcome).toBe('lost');
      expect(useChatStore.getState().sessionId).toBeUndefined();
      expect(useChatStore.getState().storedSessionId).toBe('stored-r');
      expect(useChatStore.getState().streaming).toBe(false);
    });
  });
  it('addSteeredMessage shows the steered text and continues the reply in a fresh row', () => {
    useChatStore.setState({
      sessionId: 's',
      messages: [
        { id: 'u', role: 'user', text: 'long task', createdAt: 1 },
        { id: 'a', role: 'assistant', text: 'Working on it.', createdAt: 1 },
      ],
      streaming: true,
    });
    useChatStore.getState().addSteeredMessage('  also check the logs ');
    useChatStore.getState().appendDelta('Checking the logs too.');

    const messages = useChatStore.getState().messages;
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:long task',
      'assistant:Working on it.',
      'user:also check the logs',
      'assistant:Checking the logs too.',
    ]);
    expect(messages[2]?.displayKind).toBe('steer');
    expect(useChatStore.getState().streaming).toBe(true);
  });
});
