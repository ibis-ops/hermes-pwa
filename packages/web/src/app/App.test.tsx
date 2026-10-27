import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { App } from './App';

const mockInit = vi.fn();
const mockLogin = vi.fn();
const mockBindTransport = vi.fn();

vi.mock('@hermes-pwa/core', async () => {
  const actual = await vi.importActual<typeof import('@hermes-pwa/core')>('@hermes-pwa/core');
  return {
    ...actual,
    useConnectionStore: vi.fn(() => ({
      state: 'init',
      error: undefined,
      init: mockInit,
      login: mockLogin,
      bindTransport: mockBindTransport,
    })),
  };
});

import * as coreModule from '@hermes-pwa/core';

describe('App Phase 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders connecting state on init', () => {
    render(<App />);
    expect(screen.getByText(/Connecting/i)).toBeInTheDocument();
  });

  it('renders login screen when connection state is login', () => {
    vi.mocked(coreModule.useConnectionStore).mockReturnValue({
      state: 'login',
      error: undefined,
      init: mockInit,
      login: mockLogin,
      bindTransport: mockBindTransport,
    } as ReturnType<typeof coreModule.useConnectionStore>);

    render(<App />);
    expect(screen.getByText('Sign in to Hermes')).toBeInTheDocument();
  });

  it('renders AppShell when connected', async () => {
    vi.mocked(coreModule.useConnectionStore).mockReturnValue({
      state: 'connected',
      error: undefined,
      init: mockInit,
      login: mockLogin,
      bindTransport: mockBindTransport,
    } as ReturnType<typeof coreModule.useConnectionStore>);

    render(<App />);
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
    const menu = screen.getByRole('button', { name: /Open menu/i });
    expect(menu).toBeInTheDocument();
    fireEvent.click(menu);
    const drawer = await screen.findByRole('dialog', { name: /navigation menu/i });
    await waitFor(() =>
      expect(within(drawer).getByRole('button', { name: /^Chat$/i })).toBeInTheDocument(),
    );
  });

  it('renders offline state with retry button', () => {
    vi.mocked(coreModule.useConnectionStore).mockReturnValue({
      state: 'offline',
      error: 'Network down',
      init: mockInit,
      login: mockLogin,
      bindTransport: mockBindTransport,
    } as ReturnType<typeof coreModule.useConnectionStore>);

    render(<App />);
    expect(screen.getByText('Network down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('retry button rebinds and reinitializes', () => {
    vi.mocked(coreModule.useConnectionStore).mockReturnValue({
      state: 'offline',
      error: 'Network down',
      init: mockInit,
      login: mockLogin,
      bindTransport: mockBindTransport,
    } as ReturnType<typeof coreModule.useConnectionStore>);

    render(<App />);
    screen.getByRole('button', { name: /Retry/i }).click();
    expect(mockBindTransport).toHaveBeenCalled();
    expect(mockInit).toHaveBeenCalled();
  });

  it('renders incompatible transport without a retry loop button', () => {
    vi.mocked(coreModule.useConnectionStore).mockReturnValue({
      state: 'incompatible-transport',
      error: 'This Hermes server does not support the current WebSocket ticket transport.',
      init: mockInit,
      login: mockLogin,
      bindTransport: mockBindTransport,
    } as ReturnType<typeof coreModule.useConnectionStore>);

    render(<App />);
    expect(screen.getByText(/WebSocket ticket transport/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });

  it('binds transport and initiates on mount', async () => {
    render(<App />);
    await waitFor(() => {
      expect(mockBindTransport).toHaveBeenCalled();
      expect(mockInit).toHaveBeenCalled();
    });
  });

  it('locks the native viewport and cancels horizontal touch pan', () => {
    render(<App />);
    expect(document.documentElement.classList.contains('hm-native-viewport-lock')).toBe(true);
    // A document wider than the screen is the case the lock exists for.
    Object.defineProperty(document.documentElement, 'scrollWidth', { configurable: true, value: window.innerWidth + 200 });

    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', {
      value: [{ clientX: 10, clientY: 10 }],
    });
    document.dispatchEvent(start);

    const horizontalMove = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalMove, 'touches', {
      value: [{ clientX: 70, clientY: 14 }],
    });
    document.dispatchEvent(horizontalMove);
    expect(horizontalMove.defaultPrevented).toBe(true);

    const verticalMove = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalMove, 'touches', {
      value: [{ clientX: 12, clientY: 70 }],
    });
    document.dispatchEvent(verticalMove);
    expect(verticalMove.defaultPrevented).toBe(false);
  });

  it('leaves angled thumb scrolls alone when the document fits the screen', () => {
    render(<App />);
    Object.defineProperty(document.documentElement, 'scrollWidth', { configurable: true, value: window.innerWidth });

    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', { value: [{ clientX: 10, clientY: 10 }] });
    document.dispatchEvent(start);

    const angledMove = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(angledMove, 'touches', { value: [{ clientX: 70, clientY: 14 }] });
    document.dispatchEvent(angledMove);
    expect(angledMove.defaultPrevented).toBe(false);
  });

  it('cancels pinch-style multi-touch moves and gesture zoom events', () => {
    render(<App />);

    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', {
      value: [
        { clientX: 10, clientY: 10 },
        { clientX: 80, clientY: 10 },
      ],
    });
    document.dispatchEvent(start);

    const pinchMove = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(pinchMove, 'touches', {
      value: [
        { clientX: 10, clientY: 10 },
        { clientX: 100, clientY: 10 },
      ],
    });
    document.dispatchEvent(pinchMove);
    expect(pinchMove.defaultPrevented).toBe(true);

    const gestureStart = new Event('gesturestart', { bubbles: true, cancelable: true });
    document.dispatchEvent(gestureStart);
    expect(gestureStart.defaultPrevented).toBe(true);
  });
});
