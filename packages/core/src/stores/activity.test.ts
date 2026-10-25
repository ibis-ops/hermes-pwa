import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useActivityStore } from './activity';
import type { RpcClient } from '../transport/jsonrpc';

describe('useActivityStore', () => {
  let rpcMock: RpcClient;

  beforeEach(() => {
    useActivityStore.setState({ items: [], loading: false, error: undefined });
    rpcMock = {
      request: vi.fn(),
      onFrame: vi.fn(),
      events: new EventTarget(),
    } as unknown as RpcClient;
  });

  it('respondApproval removes item', async () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'Deploy', sessionId: 'sess-1', createdAt: 1 }],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({});
    await useActivityStore.getState().respondApproval(rpcMock, 'a-1', 'approve');
    expect(useActivityStore.getState().items).toHaveLength(0);
    expect(rpcMock.request).toHaveBeenCalledWith('approval.respond', {
      choice: 'once',
      session_id: 'sess-1',
    });
  });

  it('respondApproval ignores duplicate in-flight responses for the same approval', async () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'Deploy', sessionId: 'sess-1', createdAt: 1 }],
    });
    let resolveRequest: ((value: unknown) => void) | undefined;
    vi.mocked(rpcMock.request).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }) as never,
    );

    const first = useActivityStore.getState().respondApproval(rpcMock, 'a-1', 'approve');
    const second = useActivityStore.getState().respondApproval(rpcMock, 'a-1', 'approve');
    resolveRequest?.({});
    await Promise.all([first, second]);

    expect(rpcMock.request).toHaveBeenCalledTimes(1);
  });

  it('respondApproval refuses to call backend without session_id', async () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'Deploy', createdAt: 1 }],
    });
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('nope'));
    await expect(useActivityStore.getState().respondApproval(rpcMock, 'a-1', 'approve')).rejects.toThrow(
      'Approval response requires session_id.',
    );
    expect(rpcMock.request).not.toHaveBeenCalled();
    expect(useActivityStore.getState().error).toBe('Approval response requires session_id.');
  });

  it('respondApproval keeps backend errors visible', async () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'Deploy', sessionId: 'sess-1', createdAt: 1 }],
    });
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('nope'));
    await expect(useActivityStore.getState().respondApproval(rpcMock, 'a-1', 'approve')).rejects.toThrow('nope');
    expect(useActivityStore.getState().error).toBe('nope');
  });

  it('respondApproval removes stale approval when backend says no pending approval', async () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'Deploy', sessionId: 'sess-1', createdAt: 1 }],
    });
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('4009 no pending approval for session'));

    await expect(useActivityStore.getState().respondApproval(rpcMock, 'a-1', 'approve')).resolves.toBeUndefined();

    expect(useActivityStore.getState().items).toHaveLength(0);
    expect(useActivityStore.getState().error).toBe('Approval expired or was already handled.');
  });

  it('respondApproval does not hide unrelated 4009 busy errors as stale approvals', async () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'Deploy', sessionId: 'sess-1', createdAt: 1 }],
    });
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('4009 session busy'));

    await expect(useActivityStore.getState().respondApproval(rpcMock, 'a-1', 'approve')).rejects.toThrow('4009 session busy');

    expect(useActivityStore.getState().items).toHaveLength(1);
    expect(useActivityStore.getState().error).toBe('4009 session busy');
  });

  it('respondClarify removes item', async () => {
    useActivityStore.setState({
      items: [{ id: 'c-1', kind: 'clarify', status: 'needs_you', title: 'Clarify', createdAt: 1 }],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({});
    await useActivityStore.getState().respondClarify(rpcMock, 'c-1', 'yes');
    expect(useActivityStore.getState().items).toHaveLength(0);
    expect(rpcMock.request).toHaveBeenCalledWith('clarify.respond', { id: 'c-1', answer: 'yes' });
  });

  it('respondClarify handles error', async () => {
    useActivityStore.setState({
      items: [{ id: 'c-1', kind: 'clarify', status: 'needs_you', title: 'Clarify', createdAt: 1 }],
    });
    vi.mocked(rpcMock.request).mockRejectedValue(new Error('fail'));
    await expect(useActivityStore.getState().respondClarify(rpcMock, 'c-1', 'yes')).rejects.toThrow('fail');
    expect(useActivityStore.getState().error).toBe('fail');
  });

  it('dismiss removes item', () => {
    useActivityStore.setState({
      items: [
        { id: 'a-1', kind: 'approval', status: 'needs_you', title: 'T1', createdAt: 1 },
        { id: 'a-2', kind: 'approval', status: 'needs_you', title: 'T2', createdAt: 1 },
      ],
    });
    useActivityStore.getState().dismiss('a-1');
    expect(useActivityStore.getState().items).toHaveLength(1);
    expect(useActivityStore.getState().items[0]?.id).toBe('a-2');
  });

  it('addItem prepends', () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'T1', createdAt: 1 }],
    });
    useActivityStore.getState().addItem({ id: 'a-2', kind: 'approval', status: 'needs_you', title: 'T2', createdAt: 1 });
    expect(useActivityStore.getState().items[0]?.id).toBe('a-2');
  });

  it('dedupes realtime and hydrated approvals that describe the same pending command', async () => {
    const restMock = {
      pendingActions: vi.fn().mockResolvedValue([
        {
          id: 'approval:rest-id',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          sessionId: '20260622_120000_backend',
          summary: 'rm -rf /tmp/example\nDangerous command approval required',
          createdAt: 2,
        },
      ]),
    };

    useActivityStore.getState().addItem({
      id: 'approval:realtime-id',
      kind: 'approval',
      status: 'needs_you',
      title: 'Approval required',
      sessionId: '14df21e2',
      sourceSessionId: '14df21e2',
      summary: 'rm -rf /tmp/example\nDangerous command approval required',
      createdAt: 1,
    });

    await useActivityStore.getState().load(restMock as never, 'default');

    const items = useActivityStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('approval:rest-id');
    expect(items[0]?.sessionId).toBe('20260622_120000_backend');
  });

  it('removes local stale approvals when pending refresh says none remain', async () => {
    const restMock = {
      pendingActions: vi.fn().mockResolvedValue([]),
    };

    useActivityStore.setState({
      items: [
        {
          id: 'approval:stale',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          sessionId: 'sess-1',
          summary: 'rm -rf /tmp/example\nDangerous command approval required',
          createdAt: 1,
        },
        {
          id: 'status-1',
          kind: 'run',
          status: 'running',
          title: 'Background task',
          createdAt: 1,
        },
      ],
    });

    await useActivityStore.getState().load(restMock as never, 'default');

    const items = useActivityStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('status-1');
  });

  it('addItem replaces equivalent approval even when ids differ', () => {
    useActivityStore.setState({
      items: [
        {
          id: 'approval:old',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          sessionId: 'telegram:5326786243',
          summary: 'rm -rf /tmp/example\nDangerous command approval required',
          createdAt: 1,
        },
      ],
    });

    useActivityStore.getState().addItem({
      id: 'approval:new',
      kind: 'approval',
      status: 'needs_you',
      title: 'Approval required',
      sessionId: 'telegram:5326786243',
      summary: 'rm -rf /tmp/example\nDangerous command approval required',
      createdAt: 2,
    });

    const items = useActivityStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('approval:new');
  });

  it('updateItem patches fields', () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'T1', createdAt: 1 }],
    });
    useActivityStore.getState().updateItem('a-1', { status: 'completed' });
    expect(useActivityStore.getState().items[0]?.status).toBe('completed');
  });

  it('clear resets', () => {
    useActivityStore.setState({
      items: [{ id: 'a-1', kind: 'approval', status: 'needs_you', title: 'T1', createdAt: 1 }],
      error: 'oops',
    });
    useActivityStore.getState().clear();
    expect(useActivityStore.getState().items).toEqual([]);
    expect(useActivityStore.getState().error).toBeUndefined();
  });
});

describe('server→client approval and clarify requests', () => {
  function makeRpc() {
    const handlers = new Map<string, (request: unknown) => void>();
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const rpc = {
      request: vi.fn().mockResolvedValue({}),
      onFrame: vi.fn(),
      events: {
        addEventListener: (type: string, handler: (event: unknown) => void) => {
          const set = listeners.get(type) ?? new Set();
          set.add(handler);
          listeners.set(type, set);
        },
        removeEventListener: (type: string, handler: (event: unknown) => void) => listeners.get(type)?.delete(handler),
        dispatchEvent: (event: { type: string; sessionId?: string; payload?: unknown }) => listeners.get(event.type)?.forEach((h) => h(event)),
      },
      onServerRequest: vi.fn((method: string, handler: (request: unknown) => void) => {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      }),
      respond: vi.fn(),
      respondError: vi.fn(),
      replayServerRequests: vi.fn(),
      lastSeq: () => 0,
      replayEvent: vi.fn(),
      replayEpoch: () => undefined,
      disconnect: vi.fn(),
    };
    return { rpc: rpc as unknown as RpcClient, handlers, dispatch: rpc.events.dispatchEvent };
  }

  beforeEach(() => {
    useActivityStore.setState({ items: [], loading: false, error: undefined });
  });

  it('turns an approval request into a card and answers it on the same request', async () => {
    const { rpc, handlers } = makeRpc();
    const detach = useActivityStore.getState().attachServerRequests(rpc);
    handlers.get('approval')!({
      id: 'srq-1',
      method: 'approval',
      params: { session_id: 'live-1', request_id: 'q-1', command: 'rm -rf ~/Desktop/General/x', description: 'recursive delete', choices: ['once', 'deny'], smart_denied: true },
      sessionId: 'live-1',
      replayed: false,
    });
    const [item] = useActivityStore.getState().items;
    expect(item).toMatchObject({ id: 'q-1', kind: 'approval', sessionId: 'live-1', command: 'rm -rf ~/Desktop/General/x', serverRequestId: 'srq-1', choices: ['once', 'deny'], smartDenied: true });
    expect(rpc.request).toHaveBeenCalledWith('approval.received', { request_id: 'q-1', session_id: 'live-1' });

    await useActivityStore.getState().respondApproval(rpc, 'q-1', 'reject', undefined, 'deny');
    expect(rpc.respond).toHaveBeenCalledWith('srq-1', { choice: 'deny' });
    expect(rpc.request).not.toHaveBeenCalledWith('approval.respond', expect.anything());
    expect(useActivityStore.getState().items).toHaveLength(0);
    detach();
  });

  it('drops the card when the gateway withdraws the request', () => {
    const { rpc, handlers, dispatch } = makeRpc();
    useActivityStore.getState().attachServerRequests(rpc);
    handlers.get('approval')!({ id: 'srq-2', method: 'approval', params: { session_id: 'live-1', command: 'x' }, sessionId: 'live-1', replayed: true });
    expect(useActivityStore.getState().items).toHaveLength(1);
    dispatch({ type: 'request.cancel', sessionId: 'live-1', payload: { id: 'srq-2', method: 'approval', reason: 'resolved' } });
    expect(useActivityStore.getState().items).toHaveLength(0);
  });

  it('answers a batch clarify with one answer per question', async () => {
    const { rpc, handlers } = makeRpc();
    useActivityStore.getState().attachServerRequests(rpc);
    handlers.get('clarify')!({
      id: 'srq-3',
      method: 'clarify',
      params: { session_id: 'live-1', questions: [{ qid: 'q1', question: 'Which vault?', choices: ['General', 'Work'], multi_select: false }, { qid: 'q2', question: 'Tags?', choices: [], multi_select: true }] },
      sessionId: 'live-1',
      replayed: false,
    });
    const [item] = useActivityStore.getState().items;
    expect(item).toMatchObject({ id: 'srq-3', kind: 'clarify', title: '2 questions', question: 'Which vault?' });
    await useActivityStore.getState().respondClarify(rpc, 'srq-3', { q1: 'General', q2: null });
    expect(rpc.respond).toHaveBeenCalledWith('srq-3', { answers: { q1: 'General', q2: null } });
    expect(useActivityStore.getState().items).toHaveLength(0);
  });
});
