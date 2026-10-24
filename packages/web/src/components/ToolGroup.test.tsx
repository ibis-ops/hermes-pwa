import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ToolGroup } from './ToolGroup';
import { useActivityStore, type Approval, type RpcClient } from '@hermes-pwa/core';

const rpcMock = { request: vi.fn(), onFrame: vi.fn(), events: new EventTarget() } as unknown as RpcClient;

describe('ToolGroup', () => {
  it('renders terminal row as "Ran · <command>" when done', () => {
    render(
      <ToolGroup
        rpc={rpcMock}
        tools={[{ id: 't1', name: 'terminal', input: { command: 'pytest -k reconnect' }, output: '2 passed' }]}
      />,
    );
    expect(screen.getByText('Ran · pytest -k reconnect')).toBeInTheDocument();
    expect(screen.getByText('2 passed')).toBeInTheDocument();
  });

  it('renders running state for tools without output', () => {
    render(<ToolGroup rpc={rpcMock} tools={[{ id: 't1', name: 'search_files', input: { path: 'src' } }]} streaming />);
    expect(screen.getByText('Searching files')).toBeInTheDocument();
  });

  it('shows the pulsing dot only while the reply is still streaming', () => {
    const tools = [{ id: 't1', name: 'search_files', input: { path: 'src' } }];
    const { rerender, container } = render(<ToolGroup rpc={rpcMock} tools={tools} streaming />);
    expect(container.querySelector('.hm-tool-group__header-running')).not.toBeNull();
    expect(container.querySelector('.hm-tool-group__row-running')).not.toBeNull();
    expect(screen.getByText(/1 step · running/)).toBeInTheDocument();

    rerender(<ToolGroup rpc={rpcMock} tools={tools} streaming={false} />);
    expect(container.querySelector('.hm-tool-group__header-running')).toBeNull();
    expect(container.querySelector('.hm-tool-group__row-running')).toBeNull();
    expect(container.querySelector('.hm-tool-group__row--running')).toBeNull();
    expect(screen.getByText(/1 step · done/)).toBeInTheDocument();
    // A finished call with no stored result reads as done, not as still searching.
    expect(screen.getByText('Searched files')).toBeInTheDocument();
  });

  it('keeps a result-less approval tool pending after a reload while its approval is open', () => {
    useActivityStore.setState({
      items: [
        { id: 'a1', kind: 'approval', status: 'needs_you', title: 'Approval required', highImpact: true, sessionId: 'k', summary: 'rm -rf /tmp/x', createdAt: Date.now() } as Approval,
      ],
      loading: false,
      error: undefined,
    });
    try {
      const { container } = render(
        <ToolGroup rpc={rpcMock} tools={[{ id: 't1', name: 'terminal', input: { command: 'rm -rf /tmp/x' } }, { id: 't2', name: 'search_files', input: { path: 'src' } }]} streaming={false} />,
      );
      expect(screen.getByText(/2 steps · running/)).toBeInTheDocument();
      expect(container.querySelectorAll('.hm-tool-group__row--running')).toHaveLength(1);
      expect(screen.getByText('Searched files')).toBeInTheDocument();
    } finally {
      act(() => useActivityStore.setState({ items: [], loading: false, error: undefined }));
    }
  });

  it('expands a tool row to show output', () => {
    render(<ToolGroup rpc={rpcMock} tools={[{ id: 't1', name: 'terminal', input: { command: 'ls' }, output: 'file.txt' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Ran/i }));
    expect(screen.getAllByText('file.txt').length).toBeGreaterThanOrEqual(1);
  });
});
