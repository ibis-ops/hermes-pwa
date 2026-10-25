import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRpcClient, type RpcEvent } from './jsonrpc';

interface RecordedGatewayFixture {
  source: string;
  frames: unknown[];
}

function loadRecordedGatewayFixture(name: string): RecordedGatewayFixture {
  const path = join(process.cwd(), 'packages/core/src/transport/fixtures', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as RecordedGatewayFixture;
}

describe('makeRpcClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends JSON-RPC request with newline terminator', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    void rpc.request('session.create', { profile: 'default' });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(send.mock.calls[0][0].trim());
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('session.create');
    expect(sent.params).toEqual({ profile: 'default' });
    expect(sent.id).toBe('1');
  });

  it('correlates response by id', async () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const promise = rpc.request<string>('session.list', {});
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: '1', result: 'ok' }));
    const result = await promise;
    expect(result).toBe('ok');
  });

  it('ignores responses with unknown ids', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: '99', result: 'ok' }));
    // Should not throw
  });

  it('dispatches event frames via RpcEvents', async () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const handler = vi.fn();
    rpc.events.addEventListener('message.delta', handler);
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 'abc123', payload: { text: 'hello' } } }));
    expect(handler).toHaveBeenCalled();
    const event = handler.mock.calls[0][0] as import('./jsonrpc').RpcEvent;
    expect(event.sessionId).toBe('abc123');
    expect(event.payload).toEqual({ text: 'hello' });
  });

  it('maps representative gateway event frames onto the mobile JSON-RPC contract', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const handlers = new Map<string, ReturnType<typeof vi.fn>>();
    const fixtures = [
      { type: 'gateway.ready', payload: { skin: 'dark' } },
      { type: 'message.delta', session_id: 'live-1', payload: { text: 'Hel' } },
      { type: 'message.complete', session_id: 'live-1', payload: { text: 'Hello' } },
      { type: 'tool.progress', session_id: 'live-1', payload: { message: 'working' } },
      { type: 'reasoning.delta', session_id: 'live-1', payload: { text: 'thinking' } },
      { type: 'approval.request', session_id: 'live-1', payload: { id: 'ap-1', summary: 'Approve?' } },
      { type: 'clarify.request', session_id: 'live-1', payload: { id: 'cl-1', question: 'Which one?' } },
    ];

    for (const fixture of fixtures) {
      const handler = vi.fn();
      handlers.set(fixture.type, handler);
      rpc.events.addEventListener(fixture.type, handler);
    }

    for (const fixture of fixtures) {
      rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: fixture }));
    }

    for (const fixture of fixtures) {
      const handler = handlers.get(fixture.type);
      if (!handler) throw new Error(`missing handler for ${fixture.type}`);
      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]?.[0] as import('./jsonrpc').RpcEvent | undefined;
      expect(event).toMatchObject({
        type: fixture.type,
        payload: fixture.payload,
      });
    }
    const readyEvent = handlers.get('gateway.ready')?.mock.calls[0]?.[0] as import('./jsonrpc').RpcEvent | undefined;
    const deltaEvent = handlers.get('message.delta')?.mock.calls[0]?.[0] as import('./jsonrpc').RpcEvent | undefined;
    expect(readyEvent?.sessionId).toBeUndefined();
    expect(deltaEvent?.sessionId).toBe('live-1');
  });

  it('maps recorded live gateway fixture frames onto the mobile JSON-RPC contract', async () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const fixture = loadRecordedGatewayFixture('gateway-session-create');
    const readyHandler = vi.fn();
    rpc.events.addEventListener('gateway.ready', readyHandler);

    const sessionCreate = rpc.request<Record<string, unknown>>('session.create', { profile: 'default' });
    for (const frame of fixture.frames) {
      rpc.onFrame(JSON.stringify(frame));
    }

    const result = await sessionCreate;
    expect(fixture.source).toContain('recorded from live Hermes');
    expect(readyHandler).toHaveBeenCalledTimes(1);
    expect(readyHandler.mock.calls[0]?.[0]).toMatchObject({
      type: 'gateway.ready',
      payload: { skin: { name: 'default' } },
    });
    expect(result).toMatchObject({
      session_id: 'live-session-id',
      stored_session_id: 'stored-session-id',
      message_count: 0,
      messages: [],
      info: {
        desktop_contract: 2,
        profile_name: 'default',
      },
    });
  });

  it('omits sessionId when event frame has no session_id', async () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const handler = vi.fn();
    rpc.events.addEventListener('gateway.ready', handler);
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { skin: 'dark' } } }));
    const event = handler.mock.calls[0][0] as import('./jsonrpc').RpcEvent;
    expect(event.sessionId).toBeUndefined();
    expect(event.payload).toEqual({ skin: 'dark' });
  });

  it('handles multiple sequential requests with unique ids', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    void rpc.request('a', {});
    void rpc.request('b', {});
    const first = JSON.parse(send.mock.calls[0][0].trim());
    const second = JSON.parse(send.mock.calls[1][0].trim());
    expect(first.id).toBe('1');
    expect(second.id).toBe('2');
  });

  it('ignores empty lines', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    // Should not throw
    rpc.onFrame('  ');
    rpc.onFrame('');
  });

  it('rejects with JsonRpcError when response contains error', async () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const promise = rpc.request('bad', {});
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: 4001, message: 'session not found' } }));
    await expect(promise).rejects.toThrow('4001 session not found');
  });

  it('rejects all pending requests on disconnect', async () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const first = rpc.request('session.usage', { session_id: 's1' });
    const second = rpc.request('prompt.submit', { session_id: 's1', prompt: 'hello' });

    rpc.disconnect();

    await expect(first).rejects.toThrow('Disconnected');
    await expect(second).rejects.toThrow('Disconnected');
  });

  it('rejects and removes a pending request when the response timeout elapses', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const rpc = makeRpcClient(send, { timeoutMs: 25 });

    const first = rpc.request('slow', {});
    const rejection = expect(first).rejects.toThrow('JSON-RPC request timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: '1', result: 'late' }));
    const second = rpc.request<string>('next', {});
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: '2', result: 'ok' }));
    await expect(second).resolves.toBe('ok');
  });

  it('ignores malformed frames without blocking later valid frames', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const handler = vi.fn();
    rpc.events.addEventListener('message.delta', handler);

    expect(() => rpc.onFrame('{bad json')).not.toThrow();
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', payload: { text: 'ok' } } }));

    expect(handler).toHaveBeenCalledWith({ type: 'message.delta', payload: { text: 'ok' } });
  });

  it('accepts hot-path known gateway events without noisy warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const toolProgressHandler = vi.fn();
    const reasoningDeltaHandler = vi.fn();
    rpc.events.addEventListener('tool.progress', toolProgressHandler);
    rpc.events.addEventListener('reasoning.delta', reasoningDeltaHandler);

    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.progress', payload: { message: 'working' } } }));
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'reasoning.delta', payload: { text: 'thinking' } } }));

    expect(warn).not.toHaveBeenCalled();
    expect(toolProgressHandler).toHaveBeenCalledWith({ type: 'tool.progress', payload: { message: 'working' } });
    expect(reasoningDeltaHandler).toHaveBeenCalledWith({ type: 'reasoning.delta', payload: { text: 'thinking' } });
  });

  it('warns when the gateway sends an unknown event type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const handler = vi.fn();
    rpc.events.addEventListener('future.event', handler);

    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'future.event', payload: { ok: true } } }));

    expect(warn).toHaveBeenCalledWith('[Hermes PWA] Unknown gateway event type: future.event');
    expect(handler).toHaveBeenCalledWith({ type: 'future.event', payload: { ok: true } });
  });
});

describe('event sequence tracking', () => {
  it('records the highest seq per session, replays event objects, and resets on a new replay epoch', () => {
    const rpc = makeRpcClient(() => undefined);
    const seen: RpcEvent[] = [];
    rpc.events.addEventListener('message.delta', (event) => seen.push(event));

    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'a' } } }));
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1', payload: { text: 'x' }, seq: 4 } }));
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1', payload: { text: 'y' }, seq: 3 } }));
    expect(rpc.lastSeq('s1')).toBe(4);
    expect(rpc.lastSeq('other')).toBe(0);
    expect(rpc.replayEpoch()).toBe('a');

    rpc.replayEvent({ type: 'message.delta', session_id: 's1', payload: { text: 'z' }, seq: 9 });
    expect(seen.map((e) => (e.payload as { text: string }).text)).toEqual(['x', 'y', 'z']);
    expect(seen[2]?.seq).toBe(9);
    expect(rpc.lastSeq('s1')).toBe(9);

    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'b' } } }));
    expect(rpc.lastSeq('s1')).toBe(0);
  });
});

describe('server→client requests', () => {
  it('hands an approval request to its handler and the answer goes back under the same id', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const seen: unknown[] = [];
    rpc.onServerRequest('approval', (request) => seen.push(request));
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: 'srq-abc123', method: 'approval', params: { session_id: 's-1', request_id: 'q-9', command: 'rm -rf /tmp/x', description: 'recursive delete', choices: ['once', 'deny'] } }));
    expect(seen).toEqual([
      { id: 'srq-abc123', method: 'approval', params: { session_id: 's-1', request_id: 'q-9', command: 'rm -rf /tmp/x', description: 'recursive delete', choices: ['once', 'deny'] }, sessionId: 's-1', replayed: false },
    ]);
    expect(send).not.toHaveBeenCalled();

    rpc.respond('srq-abc123', { choice: 'deny' });
    expect(JSON.parse(send.mock.calls[0][0].trim())).toEqual({ jsonrpc: '2.0', id: 'srq-abc123', result: { choice: 'deny' } });
  });

  it('refuses a request nobody handles with METHOD_NOT_FOUND so the agent does not wait', () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: 'srq-tour', method: 'tour', params: { session_id: 's-1' } }));
    const frame = JSON.parse(send.mock.calls[0][0].trim());
    expect(frame.id).toBe('srq-tour');
    expect(frame.error.code).toBe(-32601);
  });

  it('replays open requests from a reconnect snapshot as replayed requests', () => {
    const rpc = makeRpcClient(vi.fn());
    const seen: unknown[] = [];
    rpc.onServerRequest('clarify', (request) => seen.push(request));
    rpc.replayServerRequests([
      { id: 'srq-c1', method: 'clarify', params: { session_id: 's-1', questions: [{ qid: 'q1', question: 'Which?', choices: ['a', 'b'], multi_select: false }] } },
      { not: 'a request' },
    ]);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { replayed: boolean }).replayed).toBe(true);
  });

  it('still settles ordinary responses and events', async () => {
    const send = vi.fn();
    const rpc = makeRpcClient(send);
    const cancelled: RpcEvent[] = [];
    rpc.events.addEventListener('request.cancel', (event) => cancelled.push(event));
    const pending = rpc.request('ping');
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
    rpc.onFrame(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'request.cancel', session_id: 's-1', payload: { id: 'srq-abc', method: 'approval', reason: 'resolved' } } }));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.payload).toEqual({ id: 'srq-abc', method: 'approval', reason: 'resolved' });
  });
});
