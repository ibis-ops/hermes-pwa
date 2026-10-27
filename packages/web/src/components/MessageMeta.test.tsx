import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageMeta } from './MessageMeta';

describe('MessageMeta', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the send time on a user message', () => {
    const at = new Date(2026, 9, 23, 18, 42).getTime() / 1000;
    render(<MessageMeta message={{ id: 'u', role: 'user', text: 'hi', createdAt: at }} />);
    expect(screen.getByTestId('message-meta')).toHaveTextContent(/6:42/);
  });

  it('shows finish time and how long the reply took, counted from the prompt', () => {
    const prompt = new Date(2026, 9, 23, 18, 42, 0).getTime() / 1000;
    const done = prompt + 75;
    render(
      <MessageMeta
        message={{ id: 'a', role: 'assistant', text: 'done', createdAt: prompt + 2, completedAt: done }}
        elapsedFrom={prompt}
      />,
    );
    expect(screen.getByTestId('message-meta')).toHaveTextContent(/6:43.*1m 15s/);
  });

  it('ticks while the reply is in progress', () => {
    const start = Date.now() / 1000 - 3;
    render(<MessageMeta message={{ id: 'a', role: 'assistant', text: '', createdAt: start }} active elapsedFrom={start} />);
    expect(screen.getByTestId('message-meta')).toHaveTextContent(/3s…/);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('message-meta')).toHaveTextContent(/5s…/);
  });

  it('offers Listen under a finished reply, and Stop while it reads', () => {
    const onToggle = vi.fn();
    const reply = { id: 'a', role: 'assistant' as const, text: 'done', createdAt: 1_700_000_000, completedAt: 1_700_000_005 };
    const { rerender } = render(<MessageMeta message={reply} readAloud={{ status: 'idle', onToggle }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read this reply aloud' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('read-aloud')).toHaveTextContent('Listen');

    rerender(<MessageMeta message={reply} readAloud={{ status: 'playing', onToggle }} />);
    expect(screen.getByRole('button', { name: 'Stop reading aloud' })).toHaveTextContent('Stop');

    rerender(<MessageMeta message={reply} readAloud={{ status: 'idle', error: 'Could not read this aloud.', onToggle }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not read this aloud.');
  });

  it('keeps Listen off a reply still being written, and off your own messages', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <MessageMeta message={{ id: 'a', role: 'assistant', text: 'part', createdAt: Date.now() / 1000 }} active readAloud={{ status: 'idle', onToggle }} />,
    );
    expect(screen.queryByTestId('read-aloud')).toBeNull();
    rerender(<MessageMeta message={{ id: 'u', role: 'user', text: 'hi', createdAt: 1_700_000_000 }} readAloud={{ status: 'idle', onToggle }} />);
    expect(screen.queryByTestId('read-aloud')).toBeNull();
  });

  it('says Stopped under a reply that was cut off', () => {
    render(<MessageMeta message={{ id: 'a', role: 'assistant', text: 'half', createdAt: 1_700_000_000 }} stopped />);
    expect(screen.getByTestId('reply-stopped')).toHaveTextContent('Stopped');
  });

  it('renders nothing without a timestamp', () => {
    const { container } = render(<MessageMeta message={{ id: 'u', role: 'user', text: 'hi', createdAt: undefined }} />);
    expect(container.firstChild).toBeNull();
  });
});
