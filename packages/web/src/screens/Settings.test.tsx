import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Settings } from './Settings';
import { HERMES_PWA_RELEASE_VERSION } from '../app/version';
import { useConnectionStore, useProfilesStore, useModelStore, useConfigStore } from '@hermes-pwa/core';

const makeRest = (overrides = {}) =>
  ({
    systemStats: vi.fn().mockResolvedValue({
      version: 'v0.16.0',
      uptimeSeconds: 123,
      activeSessions: 1,
      cpuPercent: 5,
      memoryUsedMb: 100,
      memoryTotalMb: 1000,
    }),
    modelOptions: vi.fn().mockResolvedValue({
      model: 'gpt-5.5',
      provider: 'openai-codex',
      providers: [
        { name: 'OpenAI Codex', slug: 'openai-codex', models: ['gpt-5.5', 'gpt-5'], authenticated: true },
        { name: 'Anthropic', slug: 'anthropic', models: ['claude-opus-4', 'claude-sonnet-4'] },
      ],
    }),
    modelInfo: vi.fn().mockResolvedValue({ model: 'gpt-5.5', provider: 'openai-codex', capabilities: {} }),
    modelSet: vi.fn().mockResolvedValue({ ok: true }),
    profileUpdateModel: vi.fn().mockResolvedValue({ ok: true, provider: 'openai-codex', model: 'gpt-5' }),
    profileList: vi.fn().mockResolvedValue([{ name: 'default', displayName: 'Default', provider: 'openai-codex', model: 'gpt-5', isActive: true }]),
    profileActive: vi.fn().mockResolvedValue({ active: 'default', current: 'default' }),
    config: vi.fn().mockResolvedValue({ display: { busy_input_mode: 'steer' } }),
    setConfig: vi.fn().mockResolvedValue({ ok: true }),
    pushStatus: vi.fn().mockResolvedValue({ available: false, enabled: false, reason: 'missing VAPID', subscriptions: [] }),
    pushSubscribe: vi.fn().mockResolvedValue({ id: 'sha256:sub', enabled: true }),
    pushUnsubscribe: vi.fn().mockResolvedValue({ ok: true }),
    pushTest: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }) as unknown as import('@hermes-pwa/core').RestClient;

describe('Settings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Chrome' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    useConnectionStore.setState({ state: 'connected', error: undefined, user: undefined });
    useProfilesStore.setState({
      profiles: [{ name: 'default', displayName: 'Default', provider: 'openai-codex', model: 'gpt-5.5', isActive: true }],
      activeName: 'default',
      currentName: 'default',
      loading: false,
      error: undefined,
    });
    useModelStore.setState({ options: undefined, info: undefined, auxiliary: undefined, loading: false, setting: false, error: undefined });
    useConfigStore.setState({ config: undefined, loading: false, saving: false, error: undefined });
  });

  it('renders connection and profiles sections', async () => {
    render(<Settings rest={makeRest()} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connection' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Bots' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Manage bots/i })).toBeInTheDocument();
  });

  it('loads separate PWA client and Hermes backend versions on mount', async () => {
    const rest = makeRest();
    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    await waitFor(() => expect(rest.systemStats).toHaveBeenCalled());
    await waitFor(() => expect(rest.modelOptions).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('PWA client')).toBeInTheDocument());
    expect(screen.getByText(HERMES_PWA_RELEASE_VERSION)).toBeInTheDocument();
    expect(screen.getByText('Hermes backend')).toBeInTheDocument();
    expect(screen.getByText('v0.16.0')).toBeInTheDocument();
    expect(screen.queryByText('Version')).not.toBeInTheDocument();
  });

  it('navigates to profiles when manage profiles is clicked', async () => {
    const onNavigate = vi.fn();
    render(<Settings rest={makeRest()} onNavigate={onNavigate} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Manage bots/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Manage bots/i }));
    expect(onNavigate).toHaveBeenCalledWith('profiles');
  });

  it('opens model picker and saves model for the selected profile only', async () => {
    const rest = makeRest();
    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Change/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Change/i }));
    await waitFor(() => expect(screen.getByText('Save model')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('gpt-5.5'), { target: { value: 'gpt-5' } });
    fireEvent.click(screen.getByText('Save model'));
    await waitFor(() =>
      expect(rest.profileUpdateModel).toHaveBeenCalledWith('default', {
        provider: 'openai-codex',
        model: 'gpt-5',
        reasoning_effort: 'high',
        show_reasoning: false,
      }),
    );
    expect(rest.modelSet).not.toHaveBeenCalled();
  });

  it('uses the active non-default profile model as picker state and update target', async () => {
    useProfilesStore.setState({
      profiles: [{ name: 'research', displayName: 'Research', provider: 'anthropic', model: 'claude-sonnet-4', isActive: true }],
      activeName: 'research',
      currentName: 'default',
      loading: false,
      error: undefined,
    });
    const rest = makeRest({
      profileList: vi.fn().mockResolvedValue([{ name: 'research', displayName: 'Research', provider: 'anthropic', model: 'claude-opus-4', isActive: true }]),
      profileActive: vi.fn().mockResolvedValue({ active: 'research', current: 'default' }),
    });

    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/anthropic \/ claude-sonnet-4/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Change/i }));
    await waitFor(() => expect(screen.getByDisplayValue('claude-sonnet-4')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('claude-sonnet-4'), { target: { value: 'claude-opus-4' } });
    fireEvent.click(screen.getByText('Save model'));

    await waitFor(() =>
      expect(rest.profileUpdateModel).toHaveBeenCalledWith('research', {
        provider: 'anthropic',
        model: 'claude-opus-4',
        reasoning_effort: 'high',
        show_reasoning: false,
      }),
    );
    expect(rest.modelSet).not.toHaveBeenCalled();
  });

  it('switches provider and resets model', async () => {
    const rest = makeRest();
    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Change/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Change/i }));
    await waitFor(() => expect(screen.getByText('Save model')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('OpenAI Codex ✓'), { target: { value: 'anthropic' } });
    await waitFor(() => expect(screen.getByDisplayValue('claude-opus-4')).toBeInTheDocument());
  });

  it('navigates to command center from About', async () => {
    const onNavigate = vi.fn();
    render(<Settings rest={makeRest()} onNavigate={onNavigate} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /System command center/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /System command center/i }));
    expect(onNavigate).toHaveBeenCalledWith('command');
  });

  it('loads and saves busy input mode', async () => {
    const rest = makeRest({ config: vi.fn().mockResolvedValue({ display: { busy_input_mode: 'queue' } }) });
    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Queue after current turn')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio', { name: 'Interrupt current turn' }));

    await waitFor(() => {
      expect(rest.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ display: expect.objectContaining({ busy_input_mode: 'interrupt' }) }),
      );
    });
  });

  it('loads and renders notification status in Settings only', async () => {
    const rest = makeRest({
      pushStatus: vi.fn().mockResolvedValue({
        available: true,
        enabled: true,
        vapidPublicKey: 'public-key',
        subscriptions: [{ id: 'sha256:sub', enabled: true, profile: 'default', label: 'iPhone' }],
      }),
    });
    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);

    await waitFor(() => expect(rest.pushStatus).toHaveBeenCalledWith('default'));
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    const testButton = screen.getByRole('button', { name: 'Send a test notification' });
    expect(testButton).toBeEnabled();
    fireEvent.click(testButton);
    await waitFor(() => expect(rest.pushTest).toHaveBeenCalledWith('sha256:sub', 'default'));
  });

  it('scopes notification status and test actions to the active profile', async () => {
    useProfilesStore.setState({
      profiles: [{ name: 'research', displayName: 'Research', provider: 'anthropic', model: 'claude-sonnet-4', isActive: true }],
      activeName: 'research',
      currentName: 'default',
      loading: false,
      error: undefined,
    });
    const rest = makeRest({
      pushStatus: vi.fn().mockResolvedValue({
        available: true,
        enabled: true,
        vapidPublicKey: 'public-key',
        subscriptions: [{ id: 'sha256:research-sub', enabled: true, profile: 'research', label: 'iPhone' }],
      }),
    });
    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);

    await waitFor(() => expect(rest.pushStatus).toHaveBeenCalledWith('research'));
    fireEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
    await waitFor(() => expect(rest.pushTest).toHaveBeenCalledWith('sha256:research-sub', 'research'));
  });

  it('applies and remembers the appearance choice', async () => {
    render(<Settings rest={makeRest()} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('hermes-pwa.appearance.v1')).toBe('dark');
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('hermes-pwa.appearance.v1')).toBeNull();
  });

  it('asks before logging out', async () => {
    const onLogout = vi.fn();
    render(<Settings rest={makeRest()} onNavigate={vi.fn()} onLogout={onLogout} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onLogout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(onLogout).toHaveBeenCalled());
  });

  it('clears the chats cached on this phone after asking', async () => {
    window.localStorage.setItem('hermes-pwa.activeSession.v4:default', '{"messages":[]}');
    window.localStorage.setItem('hermes-pwa.draft.v1:default', '{"text":"hi","attachments":[]}');
    window.localStorage.setItem('hermes-pwa.appearance.v1', 'dark');
    render(<Settings rest={makeRest()} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Clear saved chats on this phone/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
    await waitFor(() => expect(window.localStorage.getItem('hermes-pwa.activeSession.v4:default')).toBeNull());
    expect(window.localStorage.getItem('hermes-pwa.draft.v1:default')).toBeNull();
    expect(window.localStorage.getItem('hermes-pwa.appearance.v1')).toBe('dark');
  });

  it('shows an install button when the browser install prompt is available', async () => {
    render(<Settings rest={makeRest()} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Install app' })).toBeInTheDocument());

    const event = new Event('beforeinstallprompt') as Event & {
      preventDefault: () => void;
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: 'accepted' }>;
    };
    Object.defineProperty(event, 'preventDefault', { value: vi.fn(), writable: true });
    Object.defineProperty(event, 'prompt', { value: vi.fn().mockResolvedValue(undefined), writable: true });
    Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: 'accepted' as const }), writable: true });
    window.dispatchEvent(event);

    const installButton = await screen.findByRole('button', { name: 'Install Hermes Mobile' });
    fireEvent.click(installButton);
    await waitFor(() => expect(screen.getByText('Install accepted.')).toBeInTheDocument());
  });

  it('shows iOS Safari Add to Home Screen instructions without a browser install prompt', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });

    render(<Settings rest={makeRest()} onNavigate={vi.fn()} onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Install app' })).toBeInTheDocument());
    expect(screen.getByText('iPhone/iPad Safari: tap Share, then choose Add to Home Screen.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Hermes Mobile' })).not.toBeInTheDocument();
  });

  it('shows error when stats fail to load', async () => {
    const rest = makeRest({ systemStats: vi.fn().mockRejectedValue(new Error('stats error')) });
    render(<Settings rest={rest} onNavigate={vi.fn()} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('stats error')).toBeInTheDocument());
  });
});
