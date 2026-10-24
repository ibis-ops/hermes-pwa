import { act, render, screen } from '@testing-library/react';
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

  it('renders nothing without a timestamp', () => {
    const { container } = render(<MessageMeta message={{ id: 'u', role: 'user', text: 'hi', createdAt: undefined }} />);
    expect(container.firstChild).toBeNull();
  });
});
