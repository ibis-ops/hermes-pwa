import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpawnStore } from '@hermes-pwa/core';
import { SubagentPanel } from './SubagentPanel';

describe('SubagentPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSpawnStore.setState({ sessionId: 's-1', agents: [], tree: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing without agents for this turn', () => {
    const { container } = render(<SubagentPanel since={Date.now() / 1000} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows who is working on what, with a live clock, then the final duration', () => {
    const promptAt = Date.now() / 1000 - 30;
    useSpawnStore.getState().handleEvent('subagent.start', {
      subagent_id: 'sa-1',
      goal: 'Pull the bloodwork PDF and extract the markers',
      model: 'anthropic/claude-sonnet-5',
      task_index: 0,
      task_count: 2,
      started_at: Date.now() - 12_000,
    });
    useSpawnStore.getState().handleEvent('subagent.tool', { subagent_id: 'sa-1', tool_name: 'read_file', text: 'labs.pdf' });
    render(<SubagentPanel since={promptAt} />);
    const row = screen.getByTestId('subagent-row');
    expect(row).toHaveAttribute('data-status', 'running');
    expect(row).toHaveTextContent('claude-sonnet-5 · 1/2');
    expect(row).toHaveTextContent('Pull the bloodwork PDF');
    expect(row).toHaveTextContent(/12s…/);
    expect(row).toHaveTextContent(/Read File\("labs.pdf"\)/);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(row).toHaveTextContent(/15s…/);

    act(() => {
      useSpawnStore.getState().handleEvent('subagent.complete', { subagent_id: 'sa-1', status: 'completed', duration_seconds: 41, summary: 'Extracted 14 markers' });
    });
    expect(screen.getByTestId('subagent-row')).toHaveAttribute('data-status', 'completed');
    expect(screen.getByTestId('subagent-row')).toHaveTextContent(/41s/);
    expect(screen.getByTestId('subagent-row')).toHaveTextContent(/Extracted 14 markers/);
    expect(screen.getByTestId('subagent-panel')).toHaveTextContent('all done');
  });

  it('ignores agents from an earlier turn', () => {
    useSpawnStore.getState().handleEvent('subagent.start', { subagent_id: 'old', goal: 'old work', started_at: Date.now() - 600_000 });
    const { container } = render(<SubagentPanel since={Date.now() / 1000} />);
    expect(container.firstChild).toBeNull();
  });
});
