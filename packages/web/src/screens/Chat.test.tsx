import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Chat } from './Chat';
import { useChatSync } from '../hooks/useChatSync';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentTooLargeMessage,
  unsupportedAttachmentTypeMessage,
} from '../components/attachmentLimits';
import * as core from '@hermes-pwa/core';

function makeRpcMock(): core.RpcClient {
  return {
    request: vi.fn(async (method: string) => {
      if (method === 'session.most_recent') return {};
      return {};
    }),
    onFrame: vi.fn(),
    events: core.makeRpcEvents(),
  } as unknown as core.RpcClient;
}

function makeRestMock(overrides = {}): core.RestClient {
  return {
    sessionMessages: vi.fn(async () => ({ messages: [] })),
    profileSessions: vi.fn(async () => []),
    setActiveProfile: vi.fn(),
    config: vi.fn(async () => ({ display: { busy_input_mode: 'steer' } })),
    setConfig: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as core.RestClient;
}

/** The chat as the shell mounts it: the store kept in step with the gateway by the shell-level hook. */
function ChatWithSync({ rpc, rest }: { rpc: core.RpcClient; rest: core.RestClient }) {
  const activeName = core.useProfilesStore((s) => s.activeName);
  const currentName = core.useProfilesStore((s) => s.currentName);
  useChatSync(rpc, rest, activeName, currentName);
  return <Chat rpc={rpc} rest={rest} />;
}

function makeSizedFile(name: string, size: number): File {
  const file = new File(['x'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

describe('Chat', () => {
  let rpcMock: core.RpcClient;
  let restMock: core.RestClient;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    core.useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined, liveStatus: '', queuedPrompts: [], lastFailedText: undefined });
    core.useSessionsStore.setState({ sessions: [], loading: false, error: undefined, pinnedIds: [] });
    core.useConnectionStore.setState({ state: 'connected', error: undefined });
    core.useProfilesStore.setState({ activeName: 'default', currentName: 'default', profiles: [{ name: 'default', displayName: 'default', isActive: true }], loading: false, error: undefined });
    core.useActivityStore.setState({ items: [], loading: false, error: undefined });
    core.useConfigStore.setState({ config: undefined, loading: false, saving: false, error: undefined });

    core.__setLiveEventAge(undefined);
    rpcMock = makeRpcMock();
    restMock = makeRestMock();
  });

  it('shows empty state when no messages', () => {
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    const log = screen.getByRole('log', { name: /conversation/i });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-relevant', 'additions text');
    expect(screen.getByText(/Start a conversation/i)).toBeInTheDocument();
  });

  it('does not seed an empty chat from a session-tagged event', () => {
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'message.delta', sessionId: 'foreign-session', payload: { text: 'foreign answer' } });

    expect(screen.queryByText('foreign answer')).not.toBeInTheDocument();
    expect(core.useChatStore.getState().messages).toEqual([]);
    expect(screen.getByText(/Start a conversation/i)).toBeInTheDocument();
  });

  it('ignores unscoped live events when no active turn owns them', () => {
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'message.delta', payload: { text: 'orphan answer' } });

    expect(screen.queryByText('orphan answer')).not.toBeInTheDocument();
    expect(core.useChatStore.getState().messages).toEqual([]);
    expect(screen.getByText(/Start a conversation/i)).toBeInTheDocument();
  });

  it('does not apply unscoped errors to a newly switched idle chat', () => {
    core.useChatStore.setState({
      sessionId: 'profile-b-live',
      storedSessionId: 'profile-b-stored',
      streaming: false,
      messages: [{ id: 'b-1', role: 'user', text: 'new profile prompt', createdAt: undefined }],
      error: undefined,
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'error', payload: { message: 'old profile late error' } });

    expect(core.useChatStore.getState().error).toBeUndefined();
    expect(core.useChatStore.getState().messages.map((message) => message.text)).toEqual(['new profile prompt']);
    expect(screen.queryByText(/old profile late error/i)).not.toBeInTheDocument();
  });

  it('accepts unscoped deltas only for the active streaming profile', async () => {
    core.useChatStore.setState({
      sessionId: 'profile-a-live',
      storedSessionId: 'profile-a-stored',
      cacheProfile: 'default',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
      error: undefined,
    });
    // A turn that is producing events: the shell's REST refresh leaves it alone.
    core.__setLiveEventAge(1_000);
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    await waitFor(() => expect(screen.getByRole('log', { name: /conversation/i })).toBeInTheDocument());

    rpcMock.events.dispatchEvent({ type: 'message.delta', payload: { text: 'slash response head' } });

    await waitFor(() => expect(screen.getByText('slash response head')).toBeInTheDocument());
    expect(core.useChatStore.getState().messages.at(-1)?.text).toBe('slash response head');
  });

  it('ignores unscoped deltas from a previous profile during a profile switch', () => {
    core.useProfilesStore.setState({ activeName: 'research', currentName: 'research', profiles: [{ name: 'research', displayName: 'research', isActive: true }], loading: false, error: undefined });
    core.useChatStore.setState({
      sessionId: 'default-live',
      storedSessionId: 'default-stored',
      cacheProfile: 'default',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
      error: undefined,
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'message.delta', payload: { text: 'old profile bleed' } });

    expect(screen.queryByText('old profile bleed')).not.toBeInTheDocument();
    expect(core.useChatStore.getState().messages.at(-1)?.text).toBe('');
  });

  it('keeps the cached transcript on screen while offline instead of a connecting notice', () => {
    core.useChatStore.setState({
      messages: [{ id: 'm-1', role: 'assistant', text: 'Cached reply', createdAt: 1 }],
    });
    core.useConnectionStore.setState({ state: 'offline', error: 'Gateway unreachable' });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    expect(screen.getByText('Cached reply')).toBeInTheDocument();
    expect(screen.queryByText(/Connecting to Hermes/i)).not.toBeInTheDocument();
  });

  it('hands a prompt the gateway did not take back to the composer', async () => {
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => {
      if (method === 'prompt.submit') throw new Error('gateway exploded');
      if (method === 'session.create') return { session_id: 's-new' };
      return {};
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    const box = screen.getByPlaceholderText(/^Message$/);
    fireEvent.change(box, { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => expect(box).toHaveValue('keep me'));
    expect(core.useChatStore.getState().lastFailedText).toBeUndefined();
  });

  it('keeps cached content visible while reconnecting', () => {
    core.useChatStore.setState({
      messages: [{ id: 'm-1', role: 'assistant', text: 'Cached reply', createdAt: 1 }],
    });
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    expect(screen.getByText('Cached reply')).toBeInTheDocument();
  });

  it('renders todo only from authoritative tool.complete todos, not tool.start input', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({
      type: 'tool.start',
      sessionId: 's-1',
      payload: {
        tool_id: 'todo-1',
        name: 'todo',
        args: { todos: [{ id: 'partial', content: 'Partial start state', status: 'in_progress' }] },
      },
    });

    expect(screen.queryByText('Partial start state')).not.toBeInTheDocument();

    rpcMock.events.dispatchEvent({
      type: 'tool.complete',
      sessionId: 's-1',
      payload: {
        tool_id: 'todo-1',
        name: 'todo',
        todos: [{ id: 'final', content: 'Final complete state', status: 'completed' }],
        result: { ignored: true },
      },
    });

    await waitFor(() => expect(screen.getAllByText('Final complete state').length).toBeGreaterThan(0));
    expect(core.useChatStore.getState().messages[0]?.toolCalls?.[0]?.output).toBe(
      JSON.stringify({ todos: [{ id: 'final', content: 'Final complete state', status: 'completed' }] }),
    );
  });

  it('folds tool.generating into the real tool.start instead of leaving a second running row', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    // Hermes emits tool.generating without an id while the model writes the call.
    rpcMock.events.dispatchEvent({ type: 'tool.generating', sessionId: 's-1', payload: { name: 'vision_analyze' } });
    rpcMock.events.dispatchEvent({ type: 'tool.generating', sessionId: 's-1', payload: { name: 'vision_analyze' } });
    expect(core.useChatStore.getState().messages[0]?.toolCalls).toHaveLength(1);

    rpcMock.events.dispatchEvent({
      type: 'tool.start',
      sessionId: 's-1',
      payload: { tool_id: 'toolu_1', name: 'vision_analyze', args: { image_url: '/tmp/a.png' } },
    });
    rpcMock.events.dispatchEvent({
      type: 'tool.complete',
      sessionId: 's-1',
      payload: { tool_id: 'toolu_1', name: 'vision_analyze', result: 'Image loaded' },
    });

    await waitFor(() => expect(core.useChatStore.getState().messages[0]?.toolCalls?.[0]?.output).toBe('Image loaded'));
    const tools = core.useChatStore.getState().messages[0]?.toolCalls ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual(expect.objectContaining({ id: 'toolu_1', name: 'vision_analyze', input: { image_url: '/tmp/a.png' } }));
  });

  it('shows local thinking status as live activity, not inside Thinking body', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: 'musing' } });
    await waitFor(() => expect(screen.getByText('musing')).toBeInTheDocument());
    expect(container.querySelector('.hm-live-status')).toHaveTextContent('musing');
    expect(container.querySelector('.hm-thinking__body')).toBeNull();

    rpcMock.events.dispatchEvent({ type: 'reasoning.delta', sessionId: 's-1', payload: { text: 'provider reasoning step' } });
    await waitFor(() => expect(screen.getByText('provider reasoning step')).toBeInTheDocument());
    expect(container.querySelector('.hm-thinking__body')).toHaveTextContent('provider reasoning step');

    rpcMock.events.dispatchEvent({ type: 'reasoning.available', sessionId: 's-1', payload: { text: 'final reasoning summary' } });
    await waitFor(() => expect(screen.getByText('final reasoning summary')).toBeInTheDocument());
    expect(screen.queryByText('provider reasoning step')).not.toBeInTheDocument();
  });

  it('renders live status as the raw backend status line', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({
      type: 'thinking.delta',
      sessionId: 's-1',
      payload: { text: '(｡•́︿•̀｡) computing...' },
    });

    await waitFor(() => expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('(｡•́︿•̀｡) computing...'));
    const liveStatus = container.querySelector('.hm-live-status');
    expect(container.querySelector('.hm-live-status__face')).toBeNull();
    expect(liveStatus).toHaveTextContent('(｡•́︿•̀｡) computing...');
    expect(container.querySelector('.hm-live-status__dots')).toBeNull();
    expect(screen.getByLabelText('Hermes is typing')).toBeInTheDocument();

    rpcMock.events.dispatchEvent({ type: 'status.update', sessionId: 's-1', payload: { text: 'Calling tool' } });
    await waitFor(() => expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('Calling tool'));

    rpcMock.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: '(¬‿¬) switching...' } });
    await waitFor(() => expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('(¬‿¬) switching...'));
  });

  it('shows streaming/live activity only on the active last assistant bubble', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [
        { id: 'a-old', role: 'assistant', text: 'Old answer', createdAt: undefined },
        { id: 'a-new', role: 'assistant', text: '', createdAt: undefined },
      ],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    expect(screen.getAllByLabelText('Hermes is typing')).toHaveLength(1);

    rpcMock.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: '(¬‿¬) computing...' } });

    await waitFor(() => expect(container.querySelectorAll('.hm-live-status')).toHaveLength(1));
    expect(container.querySelectorAll('.hm-message--assistant')[0]?.querySelector('.hm-live-status')).toBeNull();
    expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('(¬‿¬) computing...');
    expect(container.querySelector('.hm-live-status__face')).toBeNull();
    expect(container.querySelector('.hm-live-status__dots')).toBeNull();
  });

  it('does not create or update an assistant bubble for compression lifecycle status updates', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({ sessionId: 's-1', streaming: false, messages: [] });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({
      type: 'status.update',
      sessionId: 's-1',
      payload: { kind: 'compressing', text: 'compressing 12 messages (~245,124 tok)…' },
    });

    await waitFor(() => expect(screen.queryByText(/compressing 12 messages/i)).not.toBeInTheDocument());
    expect(core.useChatStore.getState().messages).toHaveLength(0);

    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [
        { id: 'u-1', role: 'user', text: 'Knock knock', createdAt: undefined },
        { id: 'a-1', role: 'assistant', text: '', createdAt: undefined },
      ],
    });

    rpcMock.events.dispatchEvent({
      type: 'status.update',
      sessionId: 's-1',
      payload: { kind: 'lifecycle', text: '🗜️ Compacting context — summarizing earlier conversation so I can continue...' },
    });

    await waitFor(() => expect(screen.queryByText(/Compacting context/i)).not.toBeInTheDocument());
    expect(core.useChatStore.getState().messages).toHaveLength(2);
  });

  it('keeps a defensive bridge for legacy decorated status payloads by showing the latest backend line', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({
      type: 'thinking.delta',
      sessionId: 's-1',
      payload: { text: '\u001b[2K◕‿◕ ⠋ computing...\r◕‿◕ ⠙ computing...\r(｡•́︿•̀｡) ⠓ computing...' },
    });

    await waitFor(() => expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('(｡•́︿•̀｡) ⠓ computing...'));
    expect(container.querySelector('.hm-live-status__face')).toBeNull();
    expect(container.querySelector('.hm-live-status__dots')).toBeNull();
  });

  it('renders unwrapped backend kaomoji inside the live status text', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: 'ಠ_ಠ formulating...' } });

    await waitFor(() => expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('ಠ_ಠ formulating...'));
    expect(container.querySelector('.hm-live-status__face')).toBeNull();
  });

  it('preserves spaced backend kaomoji prefixes in live status text', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({
      type: 'thinking.delta',
      sessionId: 's-1',
      payload: { text: '٩ (๑•́ω•̀๑) ۶ ••• processing...' },
    });

    await waitFor(() => expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('٩ (๑•́ω•̀๑) ۶ ••• processing...'));
    expect(container.querySelector('.hm-live-status__face')).toBeNull();
  });

  it('renders every backend waiting/thinking face as part of the raw status text', async () => {
    const backendFaces = [
      '(｡◕‿◕｡)',
      '(◕‿◕✿)',
      '٩(◕‿◕｡)۶',
      '(✿◠‿◠)',
      '( ˘▽˘)っ',
      '♪(´ε` )',
      '(◕ᴗ◕✿)',
      'ヾ(＾∇＾)',
      '(≧◡≦)',
      '(★ω★)',
      '(｡•́︿•̀｡)',
      '(◔_◔)',
      '(¬‿¬)',
      '( •_•)>⌐■-■',
      '(⌐■_■)',
      '(´･_･`)',
      '◉_◉',
      '(°ロ°)',
      '( ˘⌣˘)♡',
      'ヽ(>∀<☆)☆',
      '٩(๑❛ᴗ❛๑)۶',
      '(⊙_⊙)',
      '(¬_¬)',
      '( ͡° ͜ʖ ͡°)',
      'ಠ_ಠ',
    ];
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    for (const backendFace of backendFaces) {
      rpcMock.events.dispatchEvent({
        type: 'thinking.delta',
        sessionId: 's-1',
        payload: { text: `${backendFace} mulling...` },
      });

      await waitFor(() => expect(container.querySelector('.hm-live-status__text')?.textContent).toBe(`${backendFace} mulling...`));
      expect(container.querySelector('.hm-live-status__face')).toBeNull();
    }
  });

  it('auto-scrolls when live status changes while already at the bottom', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    const list = container.querySelector('.hm-chat__messages') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 800 });
    list.scrollTop = 600;

    rpcMock.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: 'Working' } });

    await waitFor(() => expect(list.scrollTop).toBe(800));
  });

  it('coalesces pending auto-scroll work into one animation frame', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: 'first', createdAt: undefined }],
    });
    const frames: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    try {
      const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
      const list = container.querySelector('.hm-chat__messages') as HTMLDivElement;
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 800 });
      list.scrollTop = 600;

      await waitFor(() => expect(frames).toHaveLength(1));

      rpcMock.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: ' second' } });
      rpcMock.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: 'Working' } });

      expect(frames).toHaveLength(1);
      act(() => frames[0]?.(0));
      expect(list.scrollTop).toBe(800);
    } finally {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });

  it('recovers assistant stream when live delta arrives after history ended on user', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'u-1', role: 'user', text: 'Status?', createdAt: undefined }],
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'Online' } });

    await waitFor(() => expect(screen.getByText('Online')).toBeInTheDocument());
    expect(core.useChatStore.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('recovers final assistant message when complete arrives after history ended on user', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'u-1', role: 'user', text: 'Where are you', createdAt: undefined }],
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: 'I am here.' } });

    await waitFor(() => expect(screen.getByText('I am here.')).toBeInTheDocument());
    expect(core.useChatStore.getState().streaming).toBe(false);
  });

  it('accepts assistant events keyed by durable stored session id', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 'live-1',
      storedSessionId: 'stored-1',
      streaming: true,
      messages: [{ id: 'u-1', role: 'user', text: 'Where are you', createdAt: undefined }],
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 'stored-1', payload: { text: 'I am here.' } });

    await waitFor(() => expect(screen.getByText('I am here.')).toBeInTheDocument());
    expect(core.useChatStore.getState().streaming).toBe(false);
  });

  it('extracts final assistant text from content-shaped complete payloads', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'u-1', role: 'user', text: 'Answer?', createdAt: undefined }],
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { message: { content: 'Final answer.' } } });

    await waitFor(() => expect(screen.getByText('Final answer.')).toBeInTheDocument());
    expect(core.useChatStore.getState().streaming).toBe(false);
  });

  it('does not render a caret-only row before live status', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: 'brainstorming...' } });

    await waitFor(() => expect(screen.getByText(/brainstorming\.\.\./)).toBeInTheDocument());
    expect(container.querySelector('.hm-message__caret')).toBeNull();
    expect(container.querySelector('.hm-message--assistant .hm-live-status')).toHaveTextContent('brainstorming...');
  });

  it('hides Thinking when short available reasoning duplicates the final answer', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useSessionsStore.setState({
      sessions: [{ id: 's-1', title: 'Local session', updatedAt: 1, messageCount: 1, source: 'tui', profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(restMock.profileSessions).mockResolvedValue([
      { id: 's-1', title: 'Local session', updatedAt: 1, messageCount: 1, source: 'tui', profile: 'default' },
    ] as core.Session[]);
    const duplicate = 'Online. Updated the todo.';
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'reasoning.available', sessionId: 's-1', payload: { text: duplicate } });
    await waitFor(() => expect(container.querySelector('.hm-thinking__body')).toHaveTextContent(duplicate));

    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: duplicate } });
    await waitFor(() => expect(container.querySelector('.hm-thinking__body')).toBeNull());
    expect(screen.getByText(duplicate)).toBeInTheDocument();
  });

  it('hides Thinking when available reasoning duplicates the final answer', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useSessionsStore.setState({
      sessions: [{ id: 's-1', title: 'Local session', updatedAt: 1, messageCount: 1, source: 'tui', profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(restMock.profileSessions).mockResolvedValue([
      { id: 's-1', title: 'Local session', updatedAt: 1, messageCount: 1, source: 'tui', profile: 'default' },
    ] as core.Session[]);
    const duplicate =
      'The logical next step is to **finish the PWA approval/todo test**, because we started it and left two pending.\n\nHere is what I would do:\n\n1. Mark the second item in_progress.\n2. Send a test approval command.';
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'reasoning.available', sessionId: 's-1', payload: { text: duplicate } });
    await waitFor(() => expect(container.querySelector('.hm-thinking__body')).toHaveTextContent('The logical next step'));

    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: duplicate.replace(/\*\*/g, '') } });
    await waitFor(() => expect(container.querySelector('.hm-thinking__body')).toBeNull());
    expect(screen.getByText(/The logical next step/)).toBeInTheDocument();
  });

  it('upserts complete-only todo events', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: true,
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({
      type: 'tool.complete',
      sessionId: 's-1',
      payload: {
        tool_id: 'todo-complete-only',
        name: 'todo',
        todos: [{ id: 'only', content: 'Complete-only state', status: 'completed' }],
      },
    });

    await waitFor(() => expect(screen.getAllByText('Complete-only state').length).toBeGreaterThan(0));
  });

  it('sends message via composer', async () => {
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => {
      if (method === 'session.create') return { session_id: 's-1', stored_session_id: 'stored-1' };
      if (method === 'session.most_recent') return {};
      return { status: 'ok' };
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    fireEvent.change(screen.getByPlaceholderText(/^Message$/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('session.create', { profile: 'default' });
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'hello' }, { timeoutMs: 90_000 });
    });
  });

  it('stages selected files through file.attach before sending the file reference', async () => {
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => {
      if (method === 'session.create') return { session_id: 's-1', stored_session_id: 'stored-1' };
      if (method === 'file.attach') return { attached: true, ref_path: '.hermes/desktop-attachments/note.txt' };
      if (method === 'session.most_recent') return {};
      return { status: 'ok' };
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    expect(screen.getByRole('menuitem', { name: /File/i })).toBeInTheDocument();
    expect(screen.queryByText(/Photo or video/i)).not.toBeInTheDocument();

    const input = container.querySelector('input[type="file"]')!;
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith(
        'file.attach',
        expect.objectContaining({
          session_id: 's-1',
          path: 'note.txt',
          name: 'note.txt',
          data_url: expect.stringMatching(/^data:text\/plain;base64,/),
        }),
      );
    });
    const attachCall = vi.mocked(rpcMock.request).mock.calls.find(([method]) => method === 'file.attach');
    expect(attachCall?.[1]).not.toHaveProperty('overwrite');

    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', {
        session_id: 's-1',
        text: '@file:.hermes/desktop-attachments/note.txt',
      }, { timeoutMs: 90_000 });
    });
  });

  it('sanitizes attachment names before file.attach', async () => {
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => {
      if (method === 'session.create') return { session_id: 's-1', stored_session_id: 'stored-1' };
      if (method === 'file.attach') return { attached: true, ref_path: '.hermes/desktop-attachments/secret.txt' };
      if (method === 'session.most_recent') return {};
      return { status: 'ok' };
    });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(['hello'], 'safe.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'name', { configurable: true, value: '../secret.txt' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith(
        'file.attach',
        expect.objectContaining({ path: 'secret.txt', name: 'secret.txt' }),
      );
    });
  });

  it('rejects unsupported attachment MIME types before reading or touching the gateway', async () => {
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    try {
      const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

      fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
      const input = container.querySelector('input[type="file"]')!;
      const file = new File(['MZ'], 'malware.exe', { type: 'application/x-msdownload' });
      fireEvent.change(input, { target: { files: [file] } });

      expect(readSpy).not.toHaveBeenCalled();
      expect(rpcMock.request).not.toHaveBeenCalledWith('session.create', expect.anything());
      expect(rpcMock.request).not.toHaveBeenCalledWith('file.attach', expect.anything());
      await waitFor(() =>
        expect(screen.getByText(unsupportedAttachmentTypeMessage('malware.exe', 'application/x-msdownload'))).toBeInTheDocument(),
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it('rejects oversized file attachments before reading or touching the gateway', async () => {
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    try {
      const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

      fireEvent.click(screen.getByRole('button', { name: /Add attachment/i }));
      const input = container.querySelector('input[type="file"]')!;
      const file = makeSizedFile('huge.csv', MAX_ATTACHMENT_BYTES + 1);
      fireEvent.change(input, { target: { files: [file] } });

      expect(readSpy).not.toHaveBeenCalled();
      expect(rpcMock.request).not.toHaveBeenCalledWith('session.create', expect.anything());
      expect(rpcMock.request).not.toHaveBeenCalledWith('file.attach', expect.anything());
      await waitFor(() => expect(screen.getByText(attachmentTooLargeMessage('huge.csv'))).toBeInTheDocument());
    } finally {
      readSpy.mockRestore();
    }
  });

  it('force-scrolls to the bottom after local composer send', async () => {
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: false,
      messages: [{ id: 'old', role: 'assistant', text: 'old reply', createdAt: undefined }],
    });
    vi.mocked(rpcMock.request).mockResolvedValue({ status: 'streaming' });
    const { container } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    const list = container.querySelector('.hm-chat__messages') as HTMLDivElement;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 800 });
    list.scrollTop = 0;
    fireEvent.scroll(list);

    fireEvent.change(screen.getByLabelText(/Message input/i), { target: { value: 'scroll me' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => expect(list.scrollTop).toBe(800));
  });

  it('rebinds cached durable history on reload and stays idle until send', async () => {
    core.useChatStore.setState({
      sessionId: 'dead-live',
      storedSessionId: 'stored-1',
      messages: [{ id: 'cached-1', role: 'assistant', text: 'cached reply', createdAt: 1 }],
      streaming: false,
      error: undefined,
    });
    core.useSessionsStore.setState({
      sessions: [{ id: 'stored-1', title: 'Local stored', updatedAt: 1, messageCount: 1, profile: 'default' }],
      loading: false,
      error: undefined,
      pinnedIds: [],
    });
    vi.mocked(restMock.sessionMessages).mockImplementation(async (sessionId: string) => {
      expect(sessionId).not.toBe('dead-live');
      return { messages: [{ id: 'stored-1-msg', role: 'assistant', text: 'cached reply' }] };
    });
    vi.mocked(restMock.profileSessions).mockResolvedValue([
      { id: 'stored-1', title: 'Local stored', updatedAt: 1, messageCount: 1, profile: 'default' },
    ] as core.Session[]);
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => {
      if (method === 'session.usage' || method === 'session.activate') throw new Error('4001 session not found');
      if (method === 'session.resume') return { session_id: 'live-2', session_key: 'stored-1', messages: [] };
      if (method === 'prompt.submit') return { status: 'streaming' };
      if (method === 'session.most_recent') return {};
      return {};
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    expect(screen.getByText('cached reply')).toBeInTheDocument();
    await waitFor(() => {
      expect(restMock.sessionMessages).toHaveBeenCalledWith('stored-1', 'default');
      expect(rpcMock.request).toHaveBeenCalledWith('session.resume', { session_id: 'stored-1', profile: 'default' }, { timeoutMs: 300_000 });
      expect(core.useChatStore.getState().sessionId).toBe('live-2');
      expect(core.useChatStore.getState().storedSessionId).toBe('stored-1');
      expect(core.useChatStore.getState().streaming).toBe(false);
    });

    fireEvent.change(screen.getByPlaceholderText(/^Message$/), { target: { value: 'after reload' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 'live-2', text: 'after reload' }, { timeoutMs: 90_000 });
    });
    expect(rpcMock.request).not.toHaveBeenCalledWith('prompt.submit', { session_id: 'dead-live', text: 'after reload' });
  });

  it('queues normal submit when backend reports session busy', async () => {
    core.useChatStore.setState({
      sessionId: 's-1',
      streaming: false,
      messages: [{ id: 'm-old', role: 'assistant', text: 'old', createdAt: undefined }],
    });
    core.useConfigStore.setState({ config: { display: { busy_input_mode: 'queue' } } });
    let submitAttempts = 0;
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => {
      if (method === 'prompt.submit') {
        submitAttempts += 1;
        if (submitAttempts === 1) throw new Error('4009 session busy');
        return { status: 'streaming' };
      }
      return {};
    });
    const rest = makeRestMock({
      config: vi.fn(async () => ({ display: { busy_input_mode: 'queue' } })),
      sessionMessages: vi.fn(async () => ({ messages: [{ id: 'm-old', role: 'assistant', text: 'old' }] })),
    });
    render(<ChatWithSync rpc={rpcMock} rest={rest} />);

    await waitFor(() => expect(core.useChatStore.getState().streaming).toBe(false));
    fireEvent.change(screen.getByPlaceholderText(/^Message$/), { target: { value: 'queued after busy' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => expect(submitAttempts).toBe(1));
    expect(core.useChatStore.getState().messages.map((m) => m.text)).toEqual(['old']);
    expect(core.useChatStore.getState().streaming).toBe(true);

    rpcMock.events.dispatchEvent({ type: 'session.info', sessionId: 's-1', payload: { running: false } });

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'queued after busy' }, { timeoutMs: 90_000 });
      expect(submitAttempts).toBe(2);
    });
  });

  it('steers the active turn instead of disabling input while streaming', async () => {
    core.useChatStore.setState({ streaming: true, sessionId: 's-1' });
    core.useConfigStore.setState({ config: { display: { busy_input_mode: 'steer' } } });
    vi.mocked(rpcMock.request).mockResolvedValue({ status: 'queued' });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.change(screen.getByPlaceholderText(/Steer the reply/i), { target: { value: 'adjust this' } });
    fireEvent.click(screen.getByRole('button', { name: /Steer agent/i }));

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('session.steer', { session_id: 's-1', text: 'adjust this' });
    });
  });

  it('falls back to queue when steer is rejected', async () => {
    core.useChatStore.setState({ streaming: true, sessionId: 's-1' });
    core.useConfigStore.setState({ config: { display: { busy_input_mode: 'steer' } } });
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => {
      if (method === 'session.steer') return { status: 'rejected' };
      return { status: 'streaming' };
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.change(screen.getByPlaceholderText(/Steer the reply/i), { target: { value: 'fallback me' } });
    fireEvent.click(screen.getByRole('button', { name: /Steer agent/i }));

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('session.steer', { session_id: 's-1', text: 'fallback me' });
    });
    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: 'done' } });

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'fallback me' }, { timeoutMs: 90_000 });
    });
  });

  it('queues busy input and submits it after the current turn completes', async () => {
    core.useChatStore.setState({ streaming: true, sessionId: 's-1' });
    core.useConfigStore.setState({ config: { display: { busy_input_mode: 'queue' } } });
    vi.mocked(rpcMock.request).mockResolvedValue({ status: 'streaming' });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.change(screen.getByPlaceholderText(/Send after this reply/i), { target: { value: 'next prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /Queue message/i }));

    expect(rpcMock.request).not.toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'next prompt' });
    // The waiting message is visible in the chat, marked as queued.
    const queued = screen.getByTestId('queued-prompt');
    expect(queued).toHaveTextContent('next prompt');
    expect(queued).toHaveTextContent(/Queued, sends when Hermes finishes/);

    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: 'done' } });

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'next prompt' }, { timeoutMs: 90_000 });
    });
    await waitFor(() => expect(screen.queryByTestId('queued-prompt')).toBeNull());
  });

  it('lets a queued message be cancelled before it sends', async () => {
    core.useChatStore.setState({ streaming: true, sessionId: 's-1' });
    core.useConfigStore.setState({ config: { display: { busy_input_mode: 'queue' } } });
    vi.mocked(rpcMock.request).mockResolvedValue({ status: 'streaming' });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.change(screen.getByPlaceholderText(/Send after this reply/i), { target: { value: 'never mind' } });
    fireEvent.click(screen.getByRole('button', { name: /Queue message/i }));
    expect(screen.getByTestId('queued-prompt')).toHaveTextContent('never mind');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('queued-prompt')).toBeNull();
    rpcMock.events.dispatchEvent({ type: 'message.complete', sessionId: 's-1', payload: { text: 'done' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rpcMock.request).not.toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ text: 'never mind' }), expect.anything());
  });

  it('shows a steered message in the chat as part of the running task', async () => {
    core.useChatStore.setState({
      streaming: true,
      sessionId: 's-1',
      messages: [
        { id: 'u-1', role: 'user', text: 'long task', createdAt: 1 },
        { id: 'a-1', role: 'assistant', text: 'Working.', createdAt: 1 },
      ],
    });
    core.useConfigStore.setState({ config: { display: { busy_input_mode: 'steer' } } });
    vi.mocked(rpcMock.request).mockImplementation(async (method: string) => (method === 'session.steer' ? { status: 'queued' } : { status: 'streaming' }));
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.change(screen.getByPlaceholderText(/Steer the reply/i), { target: { value: 'also check the logs' } });
    fireEvent.click(screen.getByRole('button', { name: /Steer agent/i }));

    await waitFor(() => expect(screen.getByText('also check the logs')).toBeInTheDocument());
    expect(screen.getByText(/Added to the running task/)).toBeInTheDocument();
    expect(core.useChatStore.getState().messages.at(-1)?.role).toBe('assistant');
    expect(core.useChatStore.getState().streaming).toBe(true);

    // The steered message carries a way out: stop the turn and send it as a fresh prompt.
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send now' }));
    await waitFor(() => expect(rpcMock.request).toHaveBeenCalledWith('session.interrupt', { session_id: 's-1' }));
    expect(screen.getByTestId('queued-prompt')).toHaveTextContent('also check the logs');
    rpcMock.events.dispatchEvent({ type: 'session.info', sessionId: 's-1', payload: { running: false } });
    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'also check the logs' }, { timeoutMs: 90_000 });
    });
  });

  it('interrupts the current turn and sends busy input after idle event in interrupt mode', async () => {
    core.useChatStore.setState({ streaming: true, sessionId: 's-1' });
    core.useConfigStore.setState({ config: { display: { busy_input_mode: 'interrupt' } } });
    vi.mocked(rpcMock.request).mockResolvedValue({ status: 'streaming' });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    fireEvent.change(screen.getByPlaceholderText(/Interrupt and send/i), { target: { value: 'new prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /Interrupt and send/i }));

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('session.interrupt', { session_id: 's-1' });
      expect(core.useChatStore.getState().streaming).toBe(true);
    });
    expect(rpcMock.request).not.toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'new prompt' });

    rpcMock.events.dispatchEvent({ type: 'session.info', sessionId: 's-1', payload: { running: false } });

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('prompt.submit', { session_id: 's-1', text: 'new prompt' }, { timeoutMs: 90_000 });
    });
  });

  it('stops generation via stop button', async () => {
    core.useChatStore.setState({ streaming: true, sessionId: 's-1' });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /Stop/i }));
    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('session.interrupt', { session_id: 's-1' });
    });
  });

  it('clears stuck streaming when backend emits error or idle session.info', async () => {
    core.useChatStore.setState({
      streaming: true,
      sessionId: 's-1',
      messages: [{ id: 'a-1', role: 'assistant', text: '', createdAt: undefined }],
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({ type: 'error', sessionId: 's-1', payload: { message: 'boom' } });

    await waitFor(() => {
      expect(core.useChatStore.getState().streaming).toBe(false);
      expect(screen.queryByRole('button', { name: /Stop/i })).not.toBeInTheDocument();
      expect(screen.getByText(/Error: boom/i)).toBeInTheDocument();
    });

    core.useChatStore.setState({ streaming: true, sessionId: 's-1', error: undefined });
    rpcMock.events.dispatchEvent({ type: 'session.info', sessionId: 's-1', payload: { running: false } });

    await waitFor(() => {
      expect(core.useChatStore.getState().streaming).toBe(false);
    });
  });

  it('renders rehydrated stored tool calls after a finished chat reload', async () => {
    core.useConnectionStore.setState({ state: 'connected', error: undefined });
    core.useChatStore.setState({
      sessionId: 'sess-1',
      storedSessionId: 'stored-1',
      streaming: false,
      messages: [
        {
          id: 'a-1',
          role: 'assistant',
          text: '',
          createdAt: undefined,
          toolCalls: [{ id: 'tool-1', name: 'terminal', output: 'whoami=stasstep' }],
        },
      ],
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    expect(screen.getByText('Tool actions')).toBeInTheDocument();
    expect(screen.getByText(/1 step · done/i)).toBeInTheDocument();
    expect(screen.getByText(/Ran command/i)).toBeInTheDocument();
    expect(screen.getByText(/whoami=stasstep/i)).toBeInTheDocument();
  });

  it('renders approval inline on the running terminal tool row and sends canonical choice', async () => {
    vi.mocked(rpcMock.request).mockResolvedValue({ resolved: true });
    core.useChatStore.setState({
      sessionId: 'sess-1',
      storedSessionId: 'stored-1',
      streaming: true,
      messages: [
        {
          id: 'a-1',
          role: 'assistant',
          text: '',
          createdAt: undefined,
          toolCalls: [{ id: 'tool-1', name: 'terminal' }],
        },
      ],
    });
    core.useActivityStore.setState({
      items: [
        {
          id: 'approval-1',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          summary: 'hermes gateway restart',
          sessionId: 'sess-1',
          highImpact: true,
          createdAt: 1,
        } as core.Approval,
      ],
      loading: false,
      error: undefined,
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    expect(screen.getByText('hermes gateway restart')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('approval.respond', {
        choice: 'once',
        session_id: 'sess-1',
      });
    });
  });

  it('sends deny and confirms always approval choices', async () => {
    vi.mocked(rpcMock.request).mockResolvedValue({ resolved: true });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [{ id: 'a-1', role: 'assistant', text: '', tool_calls: [{ id: 'tool-1', name: 'terminal' }] }],
    });
    core.useConnectionStore.setState({ state: 'reconnecting', error: undefined });
    core.useChatStore.setState({
      sessionId: 'sess-1',
      streaming: true,
      messages: [
        { id: 'a-1', role: 'assistant', text: '', createdAt: undefined, toolCalls: [{ id: 'tool-1', name: 'terminal' }] },
      ],
    });
    core.useActivityStore.setState({
      items: [
        {
          id: 'approval-1',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          summary: 'dangerous command',
          sessionId: 'sess-1',
          highImpact: true,
          createdAt: 1,
        } as core.Approval,
      ],
      loading: false,
      error: undefined,
    });

    const { unmount } = render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('approval.respond', {
        choice: 'deny',
        session_id: 'sess-1',
      });
    });

    unmount();
    core.useActivityStore.setState({
      items: [
        {
          id: 'approval-2',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          summary: 'dangerous command again',
          sessionId: 'sess-1',
          highImpact: true,
          createdAt: 2,
        } as core.Approval,
      ],
      loading: false,
      error: undefined,
    });
    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);
    const alwaysButton = await screen.findByRole('button', { name: 'Always allow' });
    await waitFor(() => expect(alwaysButton).not.toBeDisabled());
    fireEvent.click(alwaysButton);
    expect(rpcMock.request).not.toHaveBeenCalledWith('approval.respond', expect.objectContaining({ choice: 'always' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Always allow' }));

    await waitFor(() => {
      expect(rpcMock.request).toHaveBeenCalledWith('approval.respond', {
        choice: 'always',
        session_id: 'sess-1',
      });
    });
  });

  it('does not surface another session approval inside the active chat tool row', () => {
    core.useChatStore.setState({
      sessionId: 'active-session',
      streaming: true,
      messages: [
        {
          id: 'a-1',
          role: 'assistant',
          text: '',
          createdAt: undefined,
          toolCalls: [{ id: 'tool-1', name: 'terminal' }],
        },
      ],
    });
    core.useActivityStore.setState({
      items: [
        {
          id: 'approval-other',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          summary: 'background command',
          sessionId: 'other-session',
          highImpact: true,
          createdAt: 1,
        } as core.Approval,
      ],
      loading: false,
      error: undefined,
    });

    render(<ChatWithSync rpc={rpcMock} rest={restMock} />);

    expect(screen.queryByText('background command')).not.toBeInTheDocument();
  });
});
