import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import { areMessageBubblePropsEqual } from './MessageBubble.helpers';
import { useActivityStore, useChatStore, type Approval, type RpcClient } from '@hermes-pwa/core';

const rpcMock = { request: vi.fn(), onFrame: vi.fn(), events: new EventTarget() } as unknown as RpcClient;

describe('MessageBubble', () => {
  beforeEach(() => {
    useActivityStore.setState({ items: [], loading: false, error: undefined });
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined });
  });

  it('memo comparator skips only unchanged message bubble props', () => {
    const message = { id: 'memo-old', role: 'assistant' as const, text: 'Completed markdown', createdAt: undefined };
    expect(
      areMessageBubblePropsEqual(
        { rpc: rpcMock, message, isLast: false, streaming: true, liveStatus: '' },
        { rpc: rpcMock, message, isLast: false, streaming: true, liveStatus: '' },
      ),
    ).toBe(true);
    expect(
      areMessageBubblePropsEqual(
        { rpc: rpcMock, message, isLast: false, streaming: true, liveStatus: '' },
        { rpc: rpcMock, message: { ...message, text: 'Changed' }, isLast: false, streaming: true, liveStatus: '' },
      ),
    ).toBe(false);
    expect(
      areMessageBubblePropsEqual(
        { rpc: rpcMock, message, isLast: true, streaming: true, liveStatus: 'Thinking' },
        { rpc: rpcMock, message, isLast: true, streaming: true, liveStatus: 'Calling tool' },
      ),
    ).toBe(false);
    expect(
      areMessageBubblePropsEqual(
        { rpc: rpcMock, message, isLast: true, streaming: true, liveStatus: '' },
        { rpc: rpcMock, message, isLast: false, streaming: true, liveStatus: '' },
      ),
    ).toBe(false);
  });

  it('renders user message', () => {
    render(<MessageBubble rpc={rpcMock} message={{ id: '1', role: 'user', text: 'Hello', createdAt: undefined }} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders assistant message with markdown', () => {
    render(<MessageBubble rpc={rpcMock} message={{ id: '2', role: 'assistant', text: '# Title\n\nparagraph', createdAt: undefined }} />);
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('paragraph')).toBeInTheDocument();
  });

  it('opens markdown links without opener access', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{ id: '2-link', role: 'assistant', text: '[Hermes](https://example.com)', createdAt: undefined }}
      />,
    );

    const link = screen.getByRole('link', { name: 'Hermes' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('shows a typing bubble instead of streaming/done status text while the reply has no text', () => {
    render(<MessageBubble rpc={rpcMock} streaming message={{ id: '2b', role: 'assistant', text: '', createdAt: undefined }} />);
    expect(screen.getByLabelText('Hermes is typing')).toBeInTheDocument();
    expect(screen.queryByText(/streaming|done/i)).not.toBeInTheDocument();
  });

  it('drops the typing bubble once text arrives and shows no avatar or name', () => {
    const { container } = render(
      <MessageBubble rpc={rpcMock} streaming isLast message={{ id: '2c', role: 'assistant', text: 'Hello', createdAt: undefined }} />,
    );
    expect(screen.queryByLabelText('Hermes is typing')).toBeNull();
    expect(container.querySelector('.hm-message__avatar')).toBeNull();
    expect(container.querySelector('.hm-message__header')).toBeNull();
    expect(screen.queryByText('Hermes')).not.toBeInTheDocument();
  });

  it('reveals the time stamp of an older bubble on tap and offers Copy', async () => {
    const { container } = render(
      <MessageBubble rpc={rpcMock} isLast={false} message={{ id: '2d', role: 'assistant', text: 'Older answer', createdAt: 1_700_000_000 }} />,
    );
    expect(screen.queryByTestId('message-meta')).toBeNull();
    fireEvent.click(container.querySelector('.hm-message__text')!);
    expect(screen.getByTestId('message-meta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('renders tool calls when present', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: '3',
          role: 'assistant',
          text: 'ok',
          createdAt: undefined,
          toolCalls: [{ id: 't1', name: 'search', output: 'results' }],
        }}
      />,
    );
    expect(screen.getByText('Search')).toBeInTheDocument();
  });

  it('keeps inline approval visible for a pending tool after restore clears streaming', () => {
    useChatStore.setState({ sessionId: 'live-rebound', storedSessionId: 'stored-1', streaming: false });
    useActivityStore.setState({
      items: [
        {
          id: 'approval:rest-key',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          highImpact: true,
          sessionId: 'backend-approval-key',
          summary: 'rm -rf /tmp/example\nDangerous command approval required',
          createdAt: Date.now(),
        } as Approval,
      ],
      loading: false,
      error: undefined,
    });

    render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: 'approval-msg',
          role: 'assistant',
          text: '',
          createdAt: undefined,
          toolCalls: [{ id: 'tool-1', name: 'terminal', input: { command: 'rm -rf /tmp/example' } }],
        }}
        pendingApprovals={useActivityStore.getState().items as Approval[]}
        activeSessionIds={['live-rebound', 'stored-1']}
      />,
    );

    expect(screen.getByText('Approval required')).toBeInTheDocument();
    expect(screen.getByText(/wants to run/)).toBeInTheDocument();
    expect(screen.getAllByText(/rm -rf \/tmp\/example/).length).toBeGreaterThan(0);
  });

  it('re-renders a stable assistant bubble when a recovered approval prop arrives', () => {
    const message = {
      id: 'approval-msg-stable',
      role: 'assistant' as const,
      text: 'Waiting for approval.',
      createdAt: Date.now(),
    };
    const approval = {
      id: 'approval:late',
      kind: 'approval',
      status: 'needs_you',
      title: 'Approval required',
      highImpact: true,
      sessionId: 'gateway-late',
      summary: 'rm -rf /tmp/late',
      createdAt: Date.now(),
    } as Approval;

    const { rerender } = render(
      <MessageBubble
        rpc={rpcMock}
        isLast
        message={message}
        pendingApprovals={[]}
        activeSessionIds={['live-stable']}
      />,
    );

    expect(screen.queryByText(/wants to run/)).not.toBeInTheDocument();

    useActivityStore.setState({ items: [approval], loading: false, error: undefined });
    rerender(
      <MessageBubble
        rpc={rpcMock}
        isLast
        message={message}
        pendingApprovals={[approval]}
        activeSessionIds={['live-stable']}
      />,
    );

    expect(screen.getByText(/wants to run/)).toBeInTheDocument();
    expect(screen.getAllByText(/rm -rf \/tmp\/late/).length).toBeGreaterThan(0);
  });

  it('reconstructs inline approval from the sole recovered pending approval when REST history has no tool calls', () => {
    useChatStore.setState({ sessionId: 'live-push-open', storedSessionId: 'stored-push-open', streaming: false });
    useActivityStore.setState({
      items: [
        {
          id: 'approval:gateway-key',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          highImpact: true,
          sessionId: 'gateway-session-key',
          summary: 'rm -rf /tmp/from-push\nDangerous command approval required',
          createdAt: Date.now(),
        } as Approval,
      ],
      loading: false,
      error: undefined,
    });

    render(
      <MessageBubble
        rpc={rpcMock}
        isLast
        message={{
          id: 'approval-msg',
          role: 'assistant',
          text: 'Waiting for approval.',
          createdAt: undefined,
        }}
        pendingApprovals={useActivityStore.getState().items as Approval[]}
        activeSessionIds={['live-push-open', 'stored-push-open']}
      />,
    );

    expect(screen.getByText('Approval required')).toBeInTheDocument();
    expect(screen.getByText(/wants to run/)).toBeInTheDocument();
    expect(screen.getAllByText(/rm -rf \/tmp\/from-push/).length).toBeGreaterThan(0);
  });

  it('does not reconstruct inline approval when multiple recovered approvals are ambiguous', () => {
    useChatStore.setState({ sessionId: 'live-push-open', storedSessionId: 'stored-push-open', streaming: false });
    useActivityStore.setState({
      items: [
        {
          id: 'approval:one',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          highImpact: true,
          sessionId: 'gateway-one',
          summary: 'rm -rf /tmp/one',
          createdAt: 1,
        } as Approval,
        {
          id: 'approval:two',
          kind: 'approval',
          status: 'needs_you',
          title: 'Approval required',
          highImpact: true,
          sessionId: 'gateway-two',
          summary: 'rm -rf /tmp/two',
          createdAt: 2,
        } as Approval,
      ],
      loading: false,
      error: undefined,
    });

    render(
      <MessageBubble
        rpc={rpcMock}
        isLast
        message={{
          id: 'approval-msg',
          role: 'assistant',
          text: 'Waiting for approval.',
          createdAt: undefined,
        }}
        pendingApprovals={useActivityStore.getState().items as Approval[]}
        activeSessionIds={['live-push-open', 'stored-push-open']}
      />,
    );

    expect(screen.queryByText(/wants to run/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rm -rf \/tmp\/one/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rm -rf \/tmp\/two/)).not.toBeInTheDocument();
  });

  it('does not render todo panels from tool.start input', () => {
    const { container } = render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: '4',
          role: 'assistant',
          text: '',
          createdAt: undefined,
          toolCalls: [
            {
              id: 'todo-start',
              name: 'todo',
              input: {
                todos: [{ id: 'a', content: 'Partial start state', status: 'in_progress' }],
              },
            },
          ],
        }}
      />,
    );

    expect(container.querySelector('.hm-todo-panel')).toBeNull();
    expect(screen.queryByText('Partial start state')).not.toBeInTheDocument();
  });

  it('keeps ordinary assistant text next to todo tool panel', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: '5',
          role: 'assistant',
          text: 'OK. The last task is not marked in the list.',
          createdAt: undefined,
          toolCalls: [
            {
              id: 'todo-1',
              name: 'todo',
              output: JSON.stringify({
                todos: [{ id: 'a', content: 'Report the approval test result', status: 'in_progress' }],
              }),
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('Report the approval test result').length).toBeGreaterThan(0);
    expect(screen.getByText('OK. The last task is not marked in the list.')).toBeInTheDocument();
  });

  it('renders only the latest todo tool panel from repeated todo updates', () => {
    const { container } = render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: '6',
          role: 'assistant',
          text: '',
          createdAt: undefined,
          toolCalls: [
            {
              id: 'todo-old',
              name: 'todo',
              output: JSON.stringify({ todos: [{ id: 'old', content: 'Old state', status: 'in_progress' }] }),
            },
            {
              id: 'todo-new',
              name: 'todo',
              output: JSON.stringify({ todos: [{ id: 'new', content: 'Current state', status: 'completed' }] }),
            },
          ],
        }}
      />,
    );

    expect(container.querySelectorAll('.hm-todo-panel')).toHaveLength(1);
    expect(screen.queryByText('Old state')).not.toBeInTheDocument();
    expect(screen.getAllByText('Current state').length).toBeGreaterThan(0);
  });

  it('keeps ordinary markdown checklists when they are not a todo summary', () => {
    render(
      <MessageBubble
        rpc={rpcMock}
        message={{
          id: '8',
          role: 'assistant',
          text: 'Check manually:\n\n- [x] item stays as regular markdown',
          createdAt: undefined,
        }}
      />,
    );

    expect(screen.getByText('Check manually:')).toBeInTheDocument();
    // GitHub-flavored markdown renders the checklist as a read-only checkbox.
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText(/item stays as regular markdown/)).toBeInTheDocument();
  });

  it('renders the live status as one quiet line under the typing bubble', () => {
    const { container } = render(
      <MessageBubble
        rpc={rpcMock}
        streaming
        isLast
        liveStatus="computing"
        message={{ id: '9', role: 'assistant', text: '', createdAt: undefined }}
      />,
    );

    expect(container.querySelector('.hm-live-status__text')).toHaveTextContent('computing');
    expect(container.querySelector('.hm-live-status__face')).toBeNull();
    expect(container.querySelector('.hm-live-status__dots')).toBeNull();
    expect(screen.getByLabelText('Hermes is typing')).toBeInTheDocument();
    expect(container.querySelector('.hm-message__avatar')).toBeNull();
    expect(screen.queryByText('Hermes')).not.toBeInTheDocument();
  });
});
