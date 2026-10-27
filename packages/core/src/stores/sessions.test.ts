import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionsStore } from './sessions';
import { useChatStore } from './chat';
import type { RpcClient } from '../transport/jsonrpc';
import type { RestClient } from '../transport/rest';

describe('useSessionsStore', () => {
  let rpcMock: RpcClient;
  let restMock: RestClient;

  beforeEach(() => {
    window.localStorage.clear();
    useSessionsStore.setState({ sessions: [], loading: false, error: undefined, pinnedIds: [] });
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined, queuedPrompts: [], cacheProfile: undefined });

    rpcMock = {
      request: vi.fn(),
      onFrame: vi.fn(),
      events: new EventTarget(),
    } as unknown as RpcClient;

    restMock = {
      profileSessions: vi.fn(),
    } as unknown as RestClient;
  });

  it('load fetches and maps local sessions from backend envelope', async () => {
    vi.mocked(restMock.profileSessions).mockResolvedValue([
      { id: 's-1', title: 'First', updatedAt: 1000, messageCount: undefined, profile: undefined },
      {
        id: 's-2',
        title: 'Second',
        updatedAt: 2000,
        messageCount: undefined,
        profile: 'default',
        source: 'tui',
        originSource: 'cli',
        currentSource: 'tui',
        cwd: '/repo/app',
        archived: false,
        isActive: true,
        lineageRootId: 'root-2',
      },
    ]);

    await useSessionsStore.getState().load(restMock);
    const state = useSessionsStore.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[0]?.title).toBe('Second');
    expect(state.sessions[1]?.title).toBe('First');
    expect(state.sessions[0]?.profile).toBe('default');
    expect(state.sessions[0]?.source).toBe('tui');
    expect(state.sessions[0]?.originSource).toBe('cli');
    expect(state.sessions[0]?.currentSource).toBe('tui');
    expect(state.sessions[0]?.cwd).toBe('/repo/app');
    expect(state.sessions[0]?.isActive).toBe(true);
    expect(state.sessions[0]?.lineageRootId).toBe('root-2');
    expect(state.loading).toBe(false);
  });

  it('load merges projected rows by lineage root and keeps the fresher openable local head id', async () => {
    vi.mocked(restMock.profileSessions).mockResolvedValue([
      {
        id: 'old-branch',
        title: 'Local branch 18',
        updatedAt: 100,
        lastActive: 100,
        messageCount: 80,
        profile: undefined,
        source: 'cli',
        originSource: 'cli',
        currentSource: 'cli',
        lineageRootId: 'root-chat',
      },
      {
        id: 'current-head',
        title: 'Local branch 22',
        updatedAt: 300,
        lastActive: 300,
        messageCount: 336,
        profile: undefined,
        source: 'tui',
        originSource: 'cli',
        currentSource: 'tui',
        lineageRootId: 'root-chat',
      },
    ]);

    await useSessionsStore.getState().load(restMock);

    expect(useSessionsStore.getState().sessions).toHaveLength(1);
    expect(useSessionsStore.getState().sessions[0]?.id).toBe('current-head');
    expect(useSessionsStore.getState().sessions[0]?.lineageRootId).toBe('root-chat');
    expect(useSessionsStore.getState().sessions[0]?.originSource).toBe('cli');
    expect(useSessionsStore.getState().sessions[0]?.currentSource).toBe('tui');
  });

  it('load handles empty response', async () => {
    vi.mocked(restMock.profileSessions).mockResolvedValue(undefined as unknown as import('../domain/session').Session[]);
    await useSessionsStore.getState().load(restMock);
    expect(useSessionsStore.getState().sessions).toEqual([]);
  });

  it('create calls session.create with profile', async () => {
    vi.mocked(rpcMock.request).mockResolvedValueOnce({ session_id: 'new-id' });

    const id = await useSessionsStore.getState().create(rpcMock, { profile: 'default' });
    expect(id).toBe('new-id');
    expect(rpcMock.request).toHaveBeenCalledWith('session.create', { profile: 'default' });
  });

  it('create sets error on failure', async () => {
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('fail'));
    await expect(useSessionsStore.getState().create(rpcMock)).rejects.toThrow('fail');
    expect(useSessionsStore.getState().error).toContain('fail');
  });

  it('resume calls session.resume and returns payload', async () => {
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'live-1', messages: [{ id: 'm-1', role: 'user', text: 'hi' }] });
    const result = await useSessionsStore.getState().resume(rpcMock, 'stored-1');
    expect(rpcMock.request).toHaveBeenCalledWith('session.resume', { session_id: 'stored-1' }, { timeoutMs: 300_000 });
    expect(result).toEqual({ session_id: 'live-1', messages: [{ id: 'm-1', role: 'user', text: 'hi' }] });
    expect(useSessionsStore.getState().loading).toBe(false);
  });

  it('resume passes profile when provided', async () => {
    vi.mocked(rpcMock.request).mockResolvedValue({ session_id: 'live-1' });
    await useSessionsStore.getState().resume(rpcMock, 'stored-1', 'dev');
    expect(rpcMock.request).toHaveBeenCalledWith('session.resume', { session_id: 'stored-1', profile: 'dev' }, { timeoutMs: 300_000 });
  });

  it('resume handles empty response', async () => {
    vi.mocked(rpcMock.request).mockResolvedValue(null);
    await useSessionsStore.getState().resume(rpcMock, 's-1');
    expect(useSessionsStore.getState().loading).toBe(false);
  });

  it('resume sets error on failure', async () => {
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('down'));
    await useSessionsStore.getState().resume(rpcMock, 's-1');
    expect(useSessionsStore.getState().error).toContain('down');
  });

  it('archives a session and updates local state', async () => {
    restMock = {
      profileSessions: vi.fn(),
      sessionUpdate: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as RestClient;
    useSessionsStore.setState({
      sessions: [{ id: 's-1', title: 'Keep later', updatedAt: 1, messageCount: 0, profile: 'dev', archived: false }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });

    await useSessionsStore.getState().archive(restMock, useSessionsStore.getState().sessions[0]!, true);

    expect(restMock.sessionUpdate).toHaveBeenCalledWith('s-1', { archived: true, profile: 'dev' });
    expect(useSessionsStore.getState().sessions[0]?.archived).toBe(true);
  });

  it('deletes a session and removes stale pins', async () => {
    restMock = {
      profileSessions: vi.fn(),
      sessionDelete: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as RestClient;
    const session = { id: 's-1', lineageRootId: 'root-1', title: 'Delete me', updatedAt: 1, messageCount: 0, profile: 'dev' };
    useSessionsStore.setState({ sessions: [session], loading: false, error: undefined, pinnedIds: ['root-1'] });

    await useSessionsStore.getState().delete(restMock, session);

    expect(restMock.sessionDelete).toHaveBeenCalledWith('s-1', 'dev');
    expect(useSessionsStore.getState().sessions).toEqual([]);
    expect(useSessionsStore.getState().pinnedIds).toEqual([]);
  });

  it('deleting the session the chat is open on clears the chat and its cache', async () => {
    restMock = {
      profileSessions: vi.fn(),
      sessionDelete: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as RestClient;
    const session = { id: 'stored-1', title: 'Open in chat', updatedAt: 1, messageCount: 2, profile: 'dev' };
    useSessionsStore.setState({ sessions: [session], loading: false, error: undefined, pinnedIds: [] });
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      messages: [{ id: 'm-1', role: 'user', text: 'gone soon', createdAt: undefined }],
      streaming: false,
      cacheProfile: 'dev',
    });
    window.localStorage.setItem('hermes-pwa.activeSession.v4:dev', JSON.stringify({ profile: 'dev', storedSessionId: 'stored-1', messages: [] }));

    await useSessionsStore.getState().delete(restMock, session);

    expect(useChatStore.getState().sessionId).toBeUndefined();
    expect(useChatStore.getState().storedSessionId).toBeUndefined();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:dev')).toBeNull();
  });

  it('deleting the chat session by its lineage root clears the chat too', async () => {
    restMock = {
      profileSessions: vi.fn(),
      sessionDelete: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as RestClient;
    const session = { id: 'head-2', lineageRootId: 'root-1', title: 'Branch', updatedAt: 1, messageCount: 2, profile: 'dev' };
    useSessionsStore.setState({ sessions: [session], loading: false, error: undefined, pinnedIds: [] });
    useChatStore.setState({ sessionId: 'live-1', storedSessionId: 'root-1', messages: [], streaming: false, cacheProfile: 'dev' });

    await useSessionsStore.getState().delete(restMock, session);

    expect(useChatStore.getState().storedSessionId).toBeUndefined();
  });

  it('deleting another session leaves the open chat alone', async () => {
    restMock = {
      profileSessions: vi.fn(),
      sessionDelete: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as RestClient;
    const other = { id: 'stored-other', title: 'Other', updatedAt: 1, messageCount: 2, profile: 'dev' };
    useSessionsStore.setState({ sessions: [other], loading: false, error: undefined, pinnedIds: [] });
    const messages = [{ id: 'm-1', role: 'user' as const, text: 'stay', createdAt: undefined }];
    useChatStore.setState({ sessionId: 'live-1', storedSessionId: 'stored-1', messages, streaming: false, cacheProfile: 'dev' });

    await useSessionsStore.getState().delete(restMock, other);

    expect(useChatStore.getState().storedSessionId).toBe('stored-1');
    expect(useChatStore.getState().messages).toBe(messages);
  });

  it('a failed delete does not touch the open chat', async () => {
    restMock = {
      profileSessions: vi.fn(),
      sessionDelete: vi.fn().mockRejectedValue(new Error('locked')),
    } as unknown as RestClient;
    const session = { id: 'stored-1', title: 'Open in chat', updatedAt: 1, messageCount: 2, profile: 'dev' };
    useSessionsStore.setState({ sessions: [session], loading: false, error: undefined, pinnedIds: [] });
    useChatStore.setState({ sessionId: 'live-1', storedSessionId: 'stored-1', messages: [], streaming: false, cacheProfile: 'dev' });

    await expect(useSessionsStore.getState().delete(restMock, session)).rejects.toThrow('locked');

    expect(useChatStore.getState().storedSessionId).toBe('stored-1');
  });

  it('toggles and persists local pins by lineage root id', () => {
    const session = { id: 'tip-1', lineageRootId: 'root-1', title: 'Pinned', updatedAt: 1, messageCount: 1, profile: undefined };
    useSessionsStore.getState().togglePin(session);
    expect(useSessionsStore.getState().pinnedIds).toEqual(['root-1']);
    expect(window.localStorage.getItem('hermes-pwa.pinnedSessions.v1')).toBe('["root-1"]');

    useSessionsStore.getState().togglePin(session);
    expect(useSessionsStore.getState().pinnedIds).toEqual([]);
  });
});
