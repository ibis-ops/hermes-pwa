import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import * as core from '@hermes-pwa/core';
import { useChatSync } from './useChatSync';

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

function makeRestMock(): core.RestClient {
  return {
    sessionMessages: vi.fn(async () => ({ messages: [] })),
    profileSessions: vi.fn(async () => []),
    setActiveProfile: vi.fn(),
    config: vi.fn(async () => ({ display: { busy_input_mode: 'queue' } })),
    setConfig: vi.fn(async () => ({ ok: true })),
  } as unknown as core.RestClient;
}

function Harness({ rpc, rest }: { rpc: core.RpcClient; rest: core.RestClient }) {
  const activeName = core.useProfilesStore((s) => s.activeName);
  const currentName = core.useProfilesStore((s) => s.currentName);
  useChatSync(rpc, rest, activeName, currentName);
  return null;
}

describe('useChatSync', () => {
  let rpc: core.RpcClient;
  let rest: core.RestClient;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    core.useChatStore.setState({
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
    core.useSessionsStore.setState({ sessions: [], loading: false, error: undefined, pinnedIds: [] });
    core.useConnectionStore.setState({ state: 'connected', error: undefined });
    core.useProfilesStore.setState({ activeName: 'default', currentName: 'default', profiles: [{ name: 'default', displayName: 'default', isActive: true }], loading: false, error: undefined });
    core.useConfigStore.setState({ config: undefined, loading: false, saving: false, error: undefined });
    rpc = makeRpcMock();
    rest = makeRestMock();
  });

  it('applies stream events to the store without any chat screen mounted', async () => {
    core.useChatStore.setState({ sessionId: 's-1', streaming: true });
    render(<Harness rpc={rpc} rest={rest} />);

    act(() => {
      rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'while away' } });
      rpc.events.dispatchEvent({ type: 'thinking.delta', sessionId: 's-1', payload: { text: 'musing' } });
    });

    const { messages, liveStatus } = core.useChatStore.getState();
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', text: 'while away' });
    expect(liveStatus).toBe('musing');
  });

  it('restores the cached chat once connected and loads the config', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:default',
      JSON.stringify({
        profile: 'default',
        sessionId: 'live-default',
        storedSessionId: 'stored-default',
        messages: [{ id: 'm-1', role: 'user', text: 'cached prompt' }],
        streaming: false,
      }),
    );
    render(<Harness rpc={rpc} rest={rest} />);

    await waitFor(() => expect(core.useChatStore.getState().messages.map((m) => m.text)).toEqual(['cached prompt']));
    expect(rest.config).toHaveBeenCalled();
  });

  it('brings up the other bot\'s own chat when the active name changes', async () => {
    window.localStorage.setItem(
      'hermes-pwa.activeSession.v4:research',
      JSON.stringify({
        profile: 'research',
        sessionId: 'live-research',
        storedSessionId: 'stored-research',
        messages: [{ id: 'm-2', role: 'user', text: 'old research chat' }],
        streaming: false,
      }),
    );
    render(<Harness rpc={rpc} rest={rest} />);
    await waitFor(() => expect(core.useChatStore.getState().cacheProfile).toBe('default'));

    act(() => {
      core.useProfilesStore.setState({ activeName: 'research' });
    });

    await waitFor(() => expect(core.useChatStore.getState().cacheProfile).toBe('research'));
    expect(core.useChatStore.getState().messages.map((m) => m.text)).toEqual(['old research chat']);
  });

  it('re-attaches to the live session after the socket comes back', async () => {
    render(<Harness rpc={rpc} rest={rest} />);
    await waitFor(() => expect(core.useChatStore.getState().cacheProfile).toBe('default'));
    const resync = vi.spyOn(core.useChatStore.getState(), 'resyncLiveSession').mockResolvedValue('attached');

    act(() => {
      core.useConnectionStore.setState({ state: 'reconnecting' });
    });
    act(() => {
      core.useConnectionStore.setState({ state: 'connected' });
    });

    await waitFor(() => expect(resync).toHaveBeenCalledWith(rest, rpc, 'default'));
    resync.mockRestore();
  });

  it('detaches the events when the shell goes away', () => {
    core.useChatStore.setState({ sessionId: 's-1', streaming: true });
    const { unmount } = render(<Harness rpc={rpc} rest={rest} />);
    unmount();

    act(() => {
      rpc.events.dispatchEvent({ type: 'message.delta', sessionId: 's-1', payload: { text: 'after unmount' } });
    });

    expect(core.useChatStore.getState().messages).toEqual([]);
  });
});
