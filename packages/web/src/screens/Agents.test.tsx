import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Agents } from './Agents';
import { useChatStore, useSpawnStore, makeRpcEvents } from '@hermes-pwa/core';

const rpcMock = {
  request: vi.fn().mockResolvedValue({}),
  onFrame: vi.fn(),
  events: makeRpcEvents(),
} as unknown as import('@hermes-pwa/core').RpcClient;

describe('Agents (spawn tree)', () => {
  beforeEach(() => {
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined });
    useSpawnStore.setState({ sessionId: undefined, agents: [], tree: [] });
  });

  it('shows empty state when no agents', () => {
    render(<Agents rpc={rpcMock} />);
    expect(screen.getByText(/No active agents/i)).toBeInTheDocument();
  });

  it('renders spawn tree for current session', () => {
    useChatStore.setState({ sessionId: 's-1' });
    useSpawnStore.setState({
      sessionId: 's-1',
      agents: [
        {
          id: 'a-1',
          parentId: null,
          sessionId: 's-1',
          goal: 'Research topic',
          status: 'running',
          taskIndex: 0,
          taskCount: 1,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          filesRead: [],
          filesWritten: [],
          stream: [],
        },
      ],
      tree: [
        {
          id: 'a-1',
          parentId: null,
          sessionId: 's-1',
          goal: 'Research topic',
          status: 'running',
          taskIndex: 0,
          taskCount: 1,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          filesRead: [],
          filesWritten: [],
          stream: [],
          children: [],
        },
      ],
    });
    render(<Agents rpc={rpcMock} />);
    expect(screen.getByText('Research topic')).toBeInTheDocument();
    expect(screen.getAllByTestId('spawn-row')).toHaveLength(1);
  });
});

describe('Agents (history)', () => {
  beforeEach(() => {
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined });
    useSpawnStore.setState({ sessionId: undefined, agents: [], tree: [] });
  });

  it('lists every delegated run by day with the bot, goal and answer', async () => {
    const today = new Date();
    today.setHours(9, 37, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const rest = {
      agentHistory: vi.fn().mockResolvedValue({
        runs: [
          { id: 'sub1', bot: 'google-calander', ownerProfile: 'default', goal: 'Check the calendar for today', model: 'claude-sonnet-5', status: 'completed', startedAt: today.getTime(), endedAt: today.getTime() + 63_000, durationSeconds: 63, messageCount: 13, toolCallCount: 6, inputTokens: 12, outputTokens: 5492, costUsd: undefined, lastActivity: undefined, parent: { id: 'p', title: 'Check Google Calendar via delegate_task', source: 'oneshot', profile: 'default' }, result: '## Summary\n\nTwo events today.' },
          { id: 'sub2', bot: 'default', ownerProfile: 'default', goal: 'List the three largest downloads', model: 'claude-sonnet-5', status: 'interrupted', startedAt: yesterday.getTime(), endedAt: yesterday.getTime() + 5_000, durationSeconds: 5, messageCount: 2, toolCallCount: 1, inputTokens: 0, outputTokens: 0, costUsd: undefined, lastActivity: undefined, parent: undefined, result: undefined },
        ],
        days: 30,
        total: 2,
        scannedAt: Date.now(),
        error: undefined,
      }),
    } as unknown as import('@hermes-pwa/core').RestClient;

    const { findAllByTestId, getByText, getByTestId, queryByTestId, getAllByTestId } = render(<Agents rpc={rpcMock} rest={rest} />);
    expect(getByTestId('agents-empty')).toBeInTheDocument();
    const days = await findAllByTestId('agent-history-day');
    expect(days).toHaveLength(2);
    expect(getByText('Today')).toBeInTheDocument();
    expect(getByText('Yesterday')).toBeInTheDocument();
    const runs = getAllByTestId('agent-run');
    expect(runs.map((r) => r.getAttribute('data-status'))).toEqual(['completed', 'interrupted']);
    expect(getByText('Google Calander')).toBeInTheDocument();
    expect(getByText('Check the calendar for today')).toBeInTheDocument();
    expect(getByText(/Done · claude-sonnet-5 · 1m 03s · 6 tools/)).toBeInTheDocument();

    expect(queryByTestId('agent-run-result')).toBeNull();
    fireEvent.click(runs[0]!.querySelector('button')!);
    expect(getByTestId('agent-run-result')).toHaveTextContent('Two events today.');
    expect(getByText(/Asked by “Check Google Calendar via delegate_task”/)).toBeInTheDocument();
    fireEvent.click(runs[1]!.querySelector('button')!);
    expect(getByText('No answer was recorded for this run.')).toBeInTheDocument();
  });

  it('explains an empty history and shows load errors', async () => {
    const empty = { agentHistory: vi.fn().mockResolvedValue({ runs: [], days: 30, total: 0, scannedAt: Date.now(), error: undefined }) } as unknown as import('@hermes-pwa/core').RestClient;
    const first = render(<Agents rpc={rpcMock} rest={empty} />);
    expect(await first.findByText(/No bot has been delegated to in the last 30 days/)).toBeInTheDocument();
    first.unmount();

    const failing = { agentHistory: vi.fn().mockRejectedValue(new Error('Gateway offline')) } as unknown as import('@hermes-pwa/core').RestClient;
    const second = render(<Agents rpc={rpcMock} rest={failing} />);
    expect(await second.findByText('Gateway offline')).toBeInTheDocument();
  });
});
