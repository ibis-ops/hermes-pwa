import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  attachChatEvents,
  cleanLiveStatus,
  eventBelongsToActiveChat,
  extractMessageText,
  extractToolInput,
  isNonChatStatus,
  parseMaybeObject,
} from './chat-events';
import { boundRestClient, boundRpcClient, useChatStore } from './chat';
import { useSessionsStore } from './sessions';
import { makeRpcEvents, type RpcClient } from '../transport/jsonrpc';
import type { RestClient } from '../transport/rest';

function makeRpc(): RpcClient {
  return {
    request: vi.fn(async () => ({ status: 'streaming' })),
    onFrame: vi.fn(),
    events: makeRpcEvents(),
    disconnect: vi.fn(),
    lastSeq: () => 0,
    replayEvent: vi.fn(),
    replayEpoch: () => undefined,
    onServerRequest: vi.fn(() => () => undefined),
    respond: vi.fn(() => true),
    respondError: vi.fn(() => true),
    replayServerRequests: vi.fn(),
  } as unknown as RpcClient;
}

function makeRest(): RestClient {
  return {
    profileSessions: vi.fn(async () => []),
    sessionMessages: vi.fn(async () => ({ messages: [] })),
  } as unknown as RestClient;
}

function streamingChat(): void {
  useChatStore.setState({
    sessionId: 's-1',
    storedSessionId: 'stored-1',
    streaming: true,
    cacheProfile: 'default',
    messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    error: undefined,
  });
}

describe('attachChatEvents', () => {
  let rpc: RpcClient;
  let rest: RestClient;
  let detach: () => void;

  beforeEach(() => {
    window.localStorage.clear();
    useChatStore.setState({
      sessionId: undefined,
      storedSessionId: undefined,
      messages: [],
      streaming: false,
      error: undefined,
      liveStatus: '',
      queuedPrompts: [],
      lastFailedText: undefined,
      cacheProfile: undefined,
    });
    useSessionsStore.setState({ sessions: [], loading: false, error: undefined, pinnedIds: [] });
    rpc = makeRpc();
    rest = makeRest();
    detach = attachChatEvents(rpc, rest, { getProfile: () => 'default' });
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('binds the transport to the store and unbinds it on detach', () => {
    expect(boundRpcClient()).toBe(rpc);
    expect(boundRestClient()).toBe(rest);
    detach();
    expect(boundRpcClient()).toBeUndefined();
    expect(boundRestClient()).toBeUndefined();
    // Detaching twice is harmless and does not clobber a newer attach.
    const newer = makeRpc();
    const detachNewer = attachChatEvents(newer, rest, { getProfile: () => 'default' });
    detach();
    expect(boundRpcClient()).toBe(newer);
    detachNewer();
  });

  it('appends deltas to the reply and recovers a reply row when history ended on the user', () => {
    useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'u-1', role: 'user', text: 'Status?', createdAt: undefined }],
    });

    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'On' } });
    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'line' } });

    expect(useChatStore.getState().messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:Status?', 'assistant:Online']);
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('seals a segment on a null delta so the final answer starts a new paragraph', () => {
    streamingChat();

    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'Checking the file first.' } });
    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: null } });
    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'Done.' } });

    expect(useChatStore.getState().messages[0]?.text).toBe('Checking the file first.\n\nDone.');
  });

  it('shows interim commentary once: not again when the stream already carried it', () => {
    streamingChat();

    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'Looking.' } });
    rpc.events.dispatchEvent({ type: 'message.interim', sessionId: 's-1', payload: { text: 'Looking.', already_streamed: true } });
    rpc.events.dispatchEvent({ type: 'message.interim', sessionId: 's-1', payload: { text: 'Then this.' } });

    expect(useChatStore.getState().messages[0]?.text).toBe('Looking.\n\nThen this.\n\n');
  });

  it('folds tool.generating into the real tool.start instead of leaving a second running row', () => {
    streamingChat();

    rpc.events.dispatchEvent({ type: 'tool.generating', sessionId: 's-1', payload: { name: 'vision_analyze' } });
    rpc.events.dispatchEvent({ type: 'tool.generating', sessionId: 's-1', payload: { name: 'vision_analyze' } });
    expect(useChatStore.getState().messages[0]?.toolCalls).toHaveLength(1);
    expect(useChatStore.getState().messages[0]?.toolCalls?.[0]?.id.startsWith('generating:vision_analyze:')).toBe(true);

    rpc.events.dispatchEvent({
      type: 'tool.start',
      sessionId: 's-1',
      payload: { tool_id: 'toolu_1', name: 'vision_analyze', args: { image_url: '/tmp/a.png' } },
    });
    rpc.events.dispatchEvent({
      type: 'tool.complete',
      sessionId: 's-1',
      payload: { tool_id: 'toolu_1', name: 'vision_analyze', result: 'Image loaded' },
    });

    const tools = useChatStore.getState().messages[0]?.toolCalls ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({ id: 'toolu_1', name: 'vision_analyze', input: { image_url: '/tmp/a.png' }, output: 'Image loaded' });
  });

  it('tool.progress updates the running row and a repeated tool.start does not add a second one', () => {
    streamingChat();

    rpc.events.dispatchEvent({ type: 'tool.start', sessionId: 's-1', payload: { tool_id: 7, name: 'terminal', args: '{"command":"date"}' } });
    rpc.events.dispatchEvent({ type: 'tool.progress', sessionId: 's-1', payload: { tool_id: 7, name: 'terminal', input: { command: 'date' }, preview: ' partial ' } });
    rpc.events.dispatchEvent({ type: 'tool.start', sessionId: 's-1', payload: { tool_id: 7, name: 'terminal' } });

    const tools = useChatStore.getState().messages[0]?.toolCalls ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: '7', name: 'terminal', input: { command: 'date', preview: 'partial' } });
  });

  it('tool.complete with todos is the record, not the result echo, and upserts a row it never saw start', () => {
    streamingChat();

    rpc.events.dispatchEvent({
      type: 'tool.complete',
      sessionId: 's-1',
      payload: { tool_id: 'todo-1', name: 'todo', todos: [{ id: 'final', content: 'Final', status: 'completed' }], result: { ignored: true } },
    });

    const tools = useChatStore.getState().messages[0]?.toolCalls ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.output).toBe(JSON.stringify({ todos: [{ id: 'final', content: 'Final', status: 'completed' }] }));
  });

  it('tool.complete without an id completes the pending placeholder of that tool', () => {
    streamingChat();

    rpc.events.dispatchEvent({ type: 'tool.generating', sessionId: 's-1', payload: { name: 'web_search' } });
    rpc.events.dispatchEvent({ type: 'tool.complete', sessionId: 's-1', payload: { name: 'web_search', result: { hits: 3 } } });

    const tools = useChatStore.getState().messages[0]?.toolCalls ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.output).toBe('{"hits":3}');
  });

  it('thinking.delta and status.update feed the live status line, cleaned of terminal decoration', () => {
    streamingChat();

    rpc.events.dispatchEvent({
      type: 'thinking.delta',
      sessionId: 's-1',
      payload: { text: '\u001b[2K◕‿◕ ⠋ computing...\r◕‿◕ ⠙ computing...\r(｡•́︿•̀｡) ⠓ computing...' },
    });
    expect(useChatStore.getState().liveStatus).toBe('(｡•́︿•̀｡) ⠓ computing...');
    expect(useChatStore.getState().messages[0]?.thinking).toBeUndefined();

    rpc.events.dispatchEvent({ type: 'status.update', sessionId: 's-1', payload: { text: 'Calling tool' } });
    expect(useChatStore.getState().liveStatus).toBe('Calling tool');

    rpc.events.dispatchEvent({ type: 'status.update', sessionId: 's-1', payload: { kind: 'ready' } });
    expect(useChatStore.getState().liveStatus).toBe('');
  });

  it('ignores compression lifecycle status frames and status frames outside a turn', () => {
    useChatStore.setState({ sessionId: 's-1', streaming: false, messages: [] });

    rpc.events.dispatchEvent({ type: 'status.update', sessionId: 's-1', payload: { kind: 'compressing', text: 'compressing 12 messages' } });
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().liveStatus).toBe('');

    streamingChat();
    rpc.events.dispatchEvent({
      type: 'status.update',
      sessionId: 's-1',
      payload: { kind: 'lifecycle', text: 'Compacting context: summarizing earlier conversation so I can continue...' },
    });
    expect(useChatStore.getState().liveStatus).toBe('');

    // A status while idle does not start a reply row.
    useChatStore.setState({ streaming: false, messages: [{ id: 'u-1', role: 'user', text: 'hi', createdAt: undefined }] });
    rpc.events.dispatchEvent({ type: 'status.update', sessionId: 's-1', payload: { text: 'Working' } });
    expect(useChatStore.getState().liveStatus).toBe('');
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it('reasoning deltas accumulate and reasoning.available replaces them', () => {
    streamingChat();

    rpc.events.dispatchEvent({ type: 'reasoning.delta', sessionId: 's-1', payload: { text: 'step one ' } });
    rpc.events.dispatchEvent({ type: 'reasoning.delta', sessionId: 's-1', payload: { text: 'step two' } });
    expect(useChatStore.getState().messages[0]?.thinking).toBe('step one step two');

    rpc.events.dispatchEvent({ type: 'reasoning.available', sessionId: 's-1', payload: { text: 'final reasoning summary' } });
    expect(useChatStore.getState().messages[0]?.thinking).toBe('final reasoning summary');
  });

  it('message.complete ends the turn with the final text, clears the status and refreshes history', async () => {
    streamingChat();
    useChatStore.getState().setLiveStatus('thinking');

    rpc.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { message: { content: 'Final answer.' } } });

    expect(useChatStore.getState().messages[0]?.text).toBe('Final answer.');
    expect(useChatStore.getState().streaming).toBe(false);
    expect(useChatStore.getState().liveStatus).toBe('');
    await vi.waitFor(() => expect(rest.profileSessions).toHaveBeenCalled());
  });

  it('accepts events keyed by the durable stored session id', () => {
    useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      messages: [{ id: 'u-1', role: 'user', text: 'Where are you', createdAt: undefined }],
    });

    rpc.events.dispatchEvent({ type: 'message.complete', sessionId: 'stored-1', payload: { text: 'I am here.' } });

    expect(useChatStore.getState().messages.at(-1)?.text).toBe('I am here.');
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('an error frame fails the reply, clears the status and reloads the session list', async () => {
    streamingChat();
    useChatStore.getState().setLiveStatus('computing');

    rpc.events.dispatchEvent({ type: 'error', sessionId: 's-1', payload: { message: 'boom' } });

    expect(useChatStore.getState().streaming).toBe(false);
    expect(useChatStore.getState().error).toBe('boom');
    expect(useChatStore.getState().messages[0]?.text).toBe('Error: boom');
    expect(useChatStore.getState().liveStatus).toBe('');
    await vi.waitFor(() => expect(rest.profileSessions).toHaveBeenCalled());
  });

  it('session.info running:false marks the chat idle and sends the queued prompt', async () => {
    vi.useFakeTimers();
    streamingChat();
    useChatStore.getState().enqueuePrompt('queued after busy');
    expect(rpc.request).not.toHaveBeenCalled();

    rpc.events.dispatchEvent({ type: 'session.info', sessionId: 's-1', payload: { running: false } });

    expect(useChatStore.getState().streaming).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'queued after busy' }, { timeoutMs: 90_000 });
    expect(useChatStore.getState().queuedPrompts).toEqual([]);
  });

  it('session.info running:true is not an idle signal', () => {
    streamingChat();
    rpc.events.dispatchEvent({ type: 'session.info', sessionId: 's-1', payload: { running: true } });
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it('a queued prompt goes out after message.complete, even with the chat screen gone', async () => {
    vi.useFakeTimers();
    streamingChat();
    useChatStore.getState().enqueuePrompt('next prompt');

    rpc.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: 'done' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'next prompt' }, { timeoutMs: 90_000 });
    expect(useChatStore.getState().messages.map((m) => `${m.role}:${m.text}`)).toEqual(['assistant:done', 'user:next prompt', 'assistant:']);
  });

  it('a cancelled queued prompt is never sent', async () => {
    vi.useFakeTimers();
    streamingChat();
    useChatStore.getState().enqueuePrompt('never mind');
    useChatStore.getState().cancelQueuedPrompt(0);

    rpc.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: 'done' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(rpc.request).not.toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ text: 'never mind' }), expect.anything());
  });

  it('does not seed an empty chat from a session-tagged event of another session', () => {
    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 'foreign', payload: { text: 'foreign answer' } });
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('ignores unscoped events unless a turn is running for the bot in use', () => {
    rpc.events.dispatchEvent({ type: 'message.delta', payload: { text: 'orphan' } });
    expect(useChatStore.getState().messages).toEqual([]);

    useChatStore.setState({
      sessionId: 'profile-b-live',
      storedSessionId: 'profile-b-stored',
      streaming: false,
      messages: [{ id: 'b-1', role: 'user', text: 'new profile prompt', createdAt: undefined }],
    });
    rpc.events.dispatchEvent({ type: 'error', payload: { message: 'old profile late error' } });
    expect(useChatStore.getState().error).toBeUndefined();

    streamingChat();
    rpc.events.dispatchEvent({ type: 'message.delta', payload: { text: 'slash response head' } });
    expect(useChatStore.getState().messages.at(-1)?.text).toBe('slash response head');
  });

  it('ignores unscoped deltas from a previous bot during a profile switch', () => {
    detach();
    detach = attachChatEvents(rpc, rest, { getProfile: () => 'research' });
    streamingChat();

    rpc.events.dispatchEvent({ type: 'message.delta', payload: { text: 'old profile bleed' } });

    expect(useChatStore.getState().messages.at(-1)?.text).toBe('');
  });

  it('stops applying events once detached', () => {
    streamingChat();
    detach();
    rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'late' } });
    expect(useChatStore.getState().messages[0]?.text).toBe('');
  });
});

describe('chat event helpers', () => {
  it('cleanLiveStatus keeps the last line and strips ANSI and control bytes', () => {
    expect(cleanLiveStatus('\u001b[2Kfirst\rsecond\n  third   line \u0007')).toBe('third line');
    expect(cleanLiveStatus(undefined)).toBe('');
    expect(cleanLiveStatus(42)).toBe('');
  });

  it('extractMessageText reads every payload shape gateways have used', () => {
    expect(extractMessageText({ text: 'a' })).toBe('a');
    expect(extractMessageText({ rendered: 'b' })).toBe('b');
    expect(extractMessageText({ content: 'c' })).toBe('c');
    expect(extractMessageText({ message: 'd' })).toBe('d');
    expect(extractMessageText({ message: { content: 'e' } })).toBe('e');
    expect(extractMessageText({ message: { rendered: 'f' } })).toBe('f');
    expect(extractMessageText({ other: 1 })).toBeUndefined();
    expect(extractMessageText(undefined)).toBeUndefined();
  });

  it('isNonChatStatus spots compaction housekeeping by kind or text', () => {
    expect(isNonChatStatus('lifecycle', { text: 'anything' })).toBe(true);
    expect(isNonChatStatus('compressing', undefined)).toBe(true);
    expect(isNonChatStatus('status', { text: 'Compacting context now' })).toBe(true);
    expect(isNonChatStatus('status', { text: 'Calling tool' })).toBe(false);
  });

  it('extractToolInput prefers direct args, then nested input shapes, and keeps context and preview', () => {
    expect(extractToolInput({ args: { command: 'date' }, context: ' ctx ' })).toEqual({ context: 'ctx', command: 'date' });
    expect(extractToolInput({ arguments: '{"query":"hermes"}' })).toEqual({ query: 'hermes' });
    expect(extractToolInput({ input: { function: { arguments: { path: '/x' } } } })).toEqual({ path: '/x' });
    expect(extractToolInput({ input: { parameters: { a: 1 } } })).toEqual({ a: 1 });
    expect(extractToolInput({ input: { raw: true } })).toEqual({ raw: true });
    expect(extractToolInput({ preview: 'p' })).toEqual({ preview: 'p' });
    expect(extractToolInput({})).toBeUndefined();
    expect(extractToolInput(undefined)).toBeUndefined();
  });

  it('parseMaybeObject accepts objects and JSON object strings only', () => {
    expect(parseMaybeObject({ a: 1 })).toEqual({ a: 1 });
    expect(parseMaybeObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseMaybeObject('[1]')).toEqual({});
    expect(parseMaybeObject('not json')).toEqual({});
    expect(parseMaybeObject(null)).toEqual({});
  });

  it('eventBelongsToActiveChat matches tagged events by id and untagged ones by a running turn for the bot', () => {
    useChatStore.setState({ sessionId: 'live', storedSessionId: 'stored', streaming: false, cacheProfile: 'default', messages: [] });
    expect(eventBelongsToActiveChat({ type: 'message.delta', sessionId: 'live' }, 'default')).toBe(true);
    expect(eventBelongsToActiveChat({ type: 'message.delta', sessionId: 'stored' }, 'default')).toBe(true);
    expect(eventBelongsToActiveChat({ type: 'message.delta', sessionId: 'other' }, 'default')).toBe(false);
    expect(eventBelongsToActiveChat({ type: 'message.delta' }, 'default')).toBe(false);
    useChatStore.setState({ streaming: true });
    expect(eventBelongsToActiveChat({ type: 'message.delta' }, 'default')).toBe(true);
    expect(eventBelongsToActiveChat({ type: 'message.delta' }, 'research')).toBe(false);
    expect(eventBelongsToActiveChat({ type: 'message.delta' }, undefined)).toBe(true);
  });
});
