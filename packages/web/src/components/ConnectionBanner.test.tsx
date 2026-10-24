import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ConnectionBanner } from './ConnectionBanner';

describe('ConnectionBanner', () => {
  it('renders nothing when connected', () => {
    const { container } = render(<ConnectionBanner state="connected" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the reconnecting banner with retry once the reconnect has lasted a moment', () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      render(<ConnectionBanner state="reconnecting" error="Live updates disconnected." onRetry={onRetry} />);
      // A quick reconnect (every return from another app) must not blink a banner.
      expect(screen.queryByText(/Reconnecting/i)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1600);
      });
      expect(screen.getByText(/Reconnecting/i)).toBeInTheDocument();
      expect(screen.getByText(/Live updates/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Retry now/i }));
      expect(onRetry).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the pending banner when the connection comes back quickly', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ConnectionBanner state="ticketing" />);
      act(() => {
        vi.advanceTimersByTime(800);
      });
      rerender(<ConnectionBanner state="connected" />);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText(/Reconnecting/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows offline banner with retry', () => {
    const onRetry = vi.fn();
    render(<ConnectionBanner state="offline" error="Network offline." onRetry={onRetry} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText(/Network offline/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry now/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});
