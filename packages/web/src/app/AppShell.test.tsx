import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AppShell } from './AppShell';
import { useActivityStore, useConnectionStore, useProfilesStore, useProjectsStore, useChatStore, useSessionsStore, makeRpcEvents } from '@hermes-pwa/core';

const rpcMock = {
  request: vi.fn(),
  onFrame: vi.fn(),
  events: makeRpcEvents(),
  onServerRequest: vi.fn(() => () => undefined),
  respond: vi.fn(),
  respondError: vi.fn(),
  replayServerRequests: vi.fn(),
} as unknown as import('@hermes-pwa/core').RpcClient;

const restMock = {
  status: vi.fn(),
  providers: vi.fn(),
  passwordLogin: vi.fn(),
  me: vi.fn(),
  wsTicket: vi.fn(),
  logout: vi.fn(),
  kanbanBoards: vi.fn().mockResolvedValue([]),
  kanbanBoard: vi.fn().mockResolvedValue({ slug: '', name: '', columns: [] }),
  kanbanComment: vi.fn(),
  profileSessions: vi.fn().mockResolvedValue([]),
  sessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
  setActiveProfile: vi.fn(),
  profileList: vi.fn().mockResolvedValue([]),
  profileActive: vi.fn().mockRejectedValue(new Error('none')),
  profileActivate: vi.fn(),
  systemStats: vi.fn().mockResolvedValue({}),
  opsRun: vi.fn().mockResolvedValue({ status: 'ok' }),
  gatewayAction: vi.fn().mockResolvedValue({ ok: true, name: 'gateway-restart' }),
  actionStatus: vi.fn().mockResolvedValue({ name: 'doctor', running: false, exitCode: 0, lines: [] }),
  pendingActions: vi.fn().mockResolvedValue([]),
  pushStatus: vi.fn().mockResolvedValue({ available: false, enabled: false, reason: 'test', subscriptions: [] }),
  pushSubscribe: vi.fn().mockResolvedValue({ id: 'sha256:test', enabled: true }),
  pushUnsubscribe: vi.fn().mockResolvedValue({ ok: true }),
  pushTest: vi.fn().mockResolvedValue({ ok: true }),
  updateCheck: vi.fn().mockResolvedValue({
    ok: true,
    current: '0.1.0',
    latest: '0.1.0',
    source: 'npm',
    updateAvailable: false,
    canApply: false,
    manualRequired: false,
    installMethod: 'unknown',
    instructions: [],
  }),
  opsCheckpoints: vi.fn().mockResolvedValue([]),
  opsBackups: vi.fn().mockResolvedValue([]),
  cronJobs: vi.fn().mockResolvedValue([]),
  sessionArtifacts: vi.fn().mockResolvedValue([]),
  envList: vi.fn().mockResolvedValue([]),
  mcpServers: vi.fn().mockResolvedValue([]),
  mcpToggle: vi.fn().mockResolvedValue(undefined),
  skillsList: vi.fn().mockResolvedValue([]),
  speechVoices: vi.fn().mockResolvedValue({ available: false, voices: [], defaultVoice: undefined }),
  latestSession: vi.fn().mockResolvedValue(undefined),
  botGraph: vi.fn().mockResolvedValue(undefined),
  saveBotGraph: vi.fn(async (map: unknown) => map),
  speechAudio: vi.fn().mockRejectedValue(new Error('not in tests')),
  obsidianActivity: vi.fn().mockResolvedValue({ available: true, vaults: [], notes: [], scannedAt: undefined, days: 60, total: 0, error: undefined }),
  obsidianSync: vi.fn().mockResolvedValue({ available: true, running: true, started: false }),
  routerStatus: vi.fn().mockResolvedValue({ settings: { enabled: false, bot: 'router', jevModel: '~typesafe/jev-latest', minConfidence: 0.6 }, keyConfigured: false, decisions: [] }),
  routerDecisions: vi.fn().mockResolvedValue([]),
} as unknown as import('@hermes-pwa/core').RestClient;

describe('AppShell', () => {
  beforeEach(() => {
    localStorage.clear();
    // Most of these tests were written around the Home screen; the app itself
    // now lands on Chat (see the tab bar tests below).
    localStorage.setItem('hermes-mobile-screen', 'home');
    useConnectionStore.setState({ state: 'connected', error: undefined } as ReturnType<typeof useConnectionStore.getState>);
    useProfilesStore.setState({ profiles: [], activeName: undefined, currentName: undefined, loading: false, error: undefined });
    useProjectsStore.setState({ boards: [], activeBoardSlug: undefined, tasks: [], workers: [], loading: false, error: undefined });
    useChatStore.setState({ sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, error: undefined });
    useSessionsStore.setState({ sessions: [], loading: false, error: undefined, pinnedIds: [] });
    useActivityStore.setState({ items: [], loading: false, error: undefined });
    vi.clearAllMocks();
    vi.mocked(restMock.profileSessions).mockResolvedValue([]);
    vi.mocked(restMock.sessionMessages).mockResolvedValue({ messages: [] });
    vi.mocked(restMock.profileList).mockResolvedValue([]);
    vi.mocked(restMock.profileActive).mockRejectedValue(new Error('none'));
    vi.mocked(restMock.systemStats).mockResolvedValue({});
    vi.mocked(restMock.pendingActions).mockResolvedValue([]);
    vi.mocked(restMock.pushStatus).mockResolvedValue({ available: false, enabled: false, reason: 'test', subscriptions: [] });
    vi.mocked(restMock.pushSubscribe).mockResolvedValue({ id: 'sha256:test', enabled: true });
    vi.mocked(restMock.updateCheck).mockResolvedValue({
      ok: true,
      current: '0.1.0',
      latest: '0.1.0',
      source: 'npm',
      updateAvailable: false,
      canApply: false,
      manualRequired: false,
      installMethod: 'unknown',
      instructions: [],
    });
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('renders home screen when it was the last screen', () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('lands on Chat on a fresh install', () => {
    localStorage.clear();
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
  });

  it('switches screens from the tab bar and shows the approvals badge', async () => {
    useActivityStore.setState({
      items: [
        { id: 'ap-1', kind: 'approval', status: 'needs_you', title: 'Approval required', createdAt: Date.now(), highImpact: true } as import('@hermes-pwa/core').Approval,
      ],
      loading: false,
      error: undefined,
    });
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    const tabs = screen.getByTestId('tab-bar');
    expect(within(tabs).getByTestId('tab-approvals-badge')).toHaveTextContent('1');
    fireEvent.click(within(tabs).getByRole('button', { name: /Sessions/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument());
    expect(window.history.state?.screen).toBe('sessions');
    fireEvent.click(within(tabs).getByRole('button', { name: /More/ }));
    expect(screen.getByRole('dialog', { name: /navigation menu/i })).toBeInTheDocument();
  });

  it('keeps Bots in the tab bar, second after Chat', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    const tabs = screen.getByTestId('tab-bar');
    expect(within(tabs).getAllByRole('button').map((tab) => tab.textContent)).toEqual(['Chat', 'Bots', 'Obsidian', 'Approvals', 'Sessions', 'More']);
    fireEvent.click(within(tabs).getByRole('button', { name: 'Bots' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bots' })).toBeInTheDocument());
    expect(window.history.state?.screen).toBe('profiles');
  });

  it('opens Obsidian from the tab bar', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(within(screen.getByTestId('tab-bar')).getByRole('button', { name: 'Obsidian' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Obsidian' })).toBeInTheDocument());
    expect(window.history.state?.screen).toBe('obsidian');
  });

  it('pushes a history entry for in-app navigation and steps back on popstate', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /Open system status/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument());
    expect(window.history.state?.screen).toBe('command');
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();

    window.history.replaceState({ screen: 'home' }, '');
    fireEvent(window, new PopStateEvent('popstate', { state: { screen: 'home' } }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('shows update notification when backend reports a newer version', async () => {
    vi.mocked(restMock.updateCheck).mockResolvedValue({
      ok: true,
      current: '0.1.0',
      latest: '0.1.1',
      source: 'npm',
      updateAvailable: true,
      canApply: false,
      manualRequired: true,
      installMethod: 'unknown',
      instructions: [
        {
          id: 'web-ui-force-reinstall',
          label: 'Hermes Web UI / Git URL',
          steps: ['Open Hermes Web UI → Plugins', 'Enable Force reinstall'],
        },
        {
          id: 'npx-force-reinstall',
          label: 'npm / npx',
          command: 'npx -y hermes-pwa@latest install --force',
          steps: ['Run the command on the Hermes host'],
        },
      ],
    });

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    await waitFor(() => expect(screen.getByTestId('update-notification')).toBeInTheDocument());
    expect(screen.getByText('Hermes PWA 0.1.0 → 0.1.1')).toBeInTheDocument();
    expect(screen.getAllByText('npx -y hermes-pwa@latest install --force')[0]).toBeInTheDocument();
  });

  it('does not show update notification when backend reports current version', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    await waitFor(() => expect(restMock.updateCheck).toHaveBeenCalled());
    expect(screen.queryByTestId('update-notification')).not.toBeInTheDocument();
  });

  it('dismisses update notification for the reported latest version', async () => {
    vi.mocked(restMock.updateCheck).mockResolvedValue({
      ok: true,
      current: '0.1.0',
      latest: '0.1.1',
      source: 'npm',
      updateAvailable: true,
      canApply: false,
      manualRequired: true,
      installMethod: 'unknown',
      instructions: [],
    });

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    await waitFor(() => expect(screen.getByTestId('update-notification')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this version' }));

    await waitFor(() => expect(screen.queryByTestId('update-notification')).not.toBeInTheDocument());
    expect(localStorage.getItem('hermes-pwa:update-dismissed-version')).toBe('0.1.1');
  });

  it('does not crash when update check fails', async () => {
    vi.mocked(restMock.updateCheck).mockRejectedValue(new Error('registry down'));

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    await waitFor(() => expect(restMock.updateCheck).toHaveBeenCalled());
    expect(screen.queryByTestId('update-notification')).not.toBeInTheDocument();
  });

  it('does not show unstable gateway/model status chips on Home', () => {
    useProfilesStore.setState({
      profiles: [{ name: 'default', displayName: 'Default', model: 'GPT-5.5', isActive: true }],
      activeName: 'default',
      currentName: 'default',
      loading: false,
      error: undefined,
    });

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByText('Gateway ready')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
    expect(document.querySelector('.hm-home__chips')).not.toBeInTheDocument();
  });

  it('keeps Home recent preview free of status dot and chevron clutter', () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    act(() => {
      useSessionsStore.setState({
        sessions: [
          {
            id: 'recent-1',
            title: 'Recent work',
            profile: 'default',
            messageCount: 3,
            updatedAt: Date.now(),
            active: false,
            isActive: false,
          },
        ],
        loading: false,
        error: undefined,
        pinnedIds: [],
      });
    });

    const row = screen.getByTestId('recent-session');
    expect(row).toHaveTextContent('Recent work');
    expect(row.querySelector('.hm-home__recent-dot')).not.toBeInTheDocument();
    expect(row.querySelector('.hm-home__recent-chevron')).not.toBeInTheDocument();
  });

  it('keeps message input off Home but available in Chat', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Message input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('tile-chat'));
    await waitFor(() => expect(screen.getByLabelText('Message input')).toBeInTheDocument());
  });

  it('shows header with menu button and title', () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('opens and closes drawer', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = screen.getByRole('dialog', { name: /navigation menu/i });
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).getByText('Mobile, unofficial')).toBeInTheDocument();
    expect(drawer.querySelector('.hm-drawer__wordmark')?.textContent).toContain('Hermes');
    expect(within(drawer).getByRole('button', { name: 'New session' })).toBeInTheDocument();
    expect(within(drawer).queryByText('⌘N')).not.toBeInTheDocument();
    expect(drawer.querySelector('.hm-drawer__brand-logo')).toHaveAttribute('src', './icons/icon-192.png');
    fireEvent.click(screen.getByRole('button', { name: /close menu/i }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /navigation menu/i })).not.toBeInTheDocument(),
    );
  });

  it('traps drawer focus and restores focus to the menu button', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    const menuButton = screen.getByRole('button', { name: /open menu/i });
    menuButton.focus();
    fireEvent.click(menuButton);

    const drawer = screen.getByRole('dialog', { name: /navigation menu/i });
    const closeButton = within(drawer).getByRole('button', { name: /close menu/i });
    const lastButton = within(drawer).getByRole('button', { name: /open system status/i });
    await waitFor(() => expect(closeButton).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(lastButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /navigation menu/i })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(menuButton).toHaveFocus());
  });

  it('hides undecided administrative surfaces from the drawer', () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = screen.getByRole('dialog', { name: /navigation menu/i });
    expect(within(drawer).queryByRole('button', { name: 'Skills & Tools' })).not.toBeInTheDocument();
    // Messaging (which chat services run a Hermes bot) is a first-class screen.
    expect(within(drawer).getByRole('button', { name: 'Messaging' })).toBeInTheDocument();
    expect(within(drawer).queryByText('Telegram')).not.toBeInTheDocument();
  });

  it('does not restore hidden administrative screens from localStorage', () => {
    localStorage.setItem('hermes-mobile-screen', 'skills');
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument();
    expect(restMock.skillsList).not.toHaveBeenCalled();

    localStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem('hermes-mobile-screen', 'messaging');
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getAllByRole('heading', { name: 'Messaging' }).length).toBeGreaterThan(0);
  });

  it('shows Bots in the main drawer directly after Home and opens it', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = screen.getByRole('dialog', { name: /navigation menu/i });
    const navItems = within(drawer).getAllByRole('button').map((button) => button.textContent?.replace(/\s+/g, ' ').trim());
    const homeIndex = navItems.indexOf('Home');
    const profilesIndex = navItems.indexOf('Bots');
    expect(homeIndex).toBeGreaterThanOrEqual(0);
    expect(profilesIndex).toBe(homeIndex + 1);

    fireEvent.click(within(drawer).getByRole('button', { name: 'Bots' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bots' })).toBeInTheDocument());
  });

  it('filters main drawer sessions by source', async () => {
    vi.mocked(restMock.profileSessions).mockResolvedValue([
      { id: 'cli-1', title: 'CLI case', source: 'cli', message_count: 3, updated_at: Date.now() },
      { id: 'tui-1', title: 'TUI case', source: 'tui', message_count: 2, updated_at: Date.now() },
    ] as unknown as import('@hermes-pwa/core').Session[]);

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = screen.getByRole('dialog', { name: /navigation menu/i });

    await waitFor(() => expect(within(drawer).getByText('CLI · CLI case')).toBeInTheDocument());
    expect(within(drawer).getByText('TUI · TUI case')).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('tab', { name: /TUI/i }));
    expect(within(drawer).getByText('TUI · TUI case')).toBeInTheDocument();
    expect(within(drawer).queryByText('CLI · CLI case')).not.toBeInTheDocument();
  });

  it('navigates via drawer and updates title', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = screen.getByRole('dialog', { name: /navigation menu/i });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Approvals' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /navigation menu/i })).not.toBeInTheDocument(),
    );
  });

  it('switches to kanban via drawer', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Kanban$/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Kanban' })).toBeInTheDocument(),
    );
  });

  it('navigates to settings screen', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument(),
    );
  });

  it('shows model details in drawer footer and opens settings', async () => {
    vi.mocked(restMock.profileList).mockResolvedValue([
      { name: 'default', displayName: 'default', provider: 'openai-codex', model: 'gpt-5.5', isActive: true },
    ] as unknown as import('@hermes-pwa/core').Profile[]);
    vi.mocked(restMock.profileActive).mockResolvedValue({ active: 'default', current: 'default' });

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = await screen.findByRole('dialog', { name: /navigation menu/i });

    await waitFor(() => expect(within(drawer).getByText('gpt-5.5')).toBeInTheDocument());
    expect(within(drawer).queryByRole('button', { name: /Open profile switcher/i })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /Activate default profile/i })).not.toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('button', { name: /Open model settings/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument());
  });

  it('opens system status from the drawer footer', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = await screen.findByRole('dialog', { name: /navigation menu/i });
    await waitFor(() => expect(within(drawer).getByText(/Gateway ready/i)).toBeInTheDocument());

    fireEvent.click(within(drawer).getByRole('button', { name: /Open system status/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'System' })).toBeInTheDocument());
  });

  it('shows system health in the status chip for connected state', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    const chip = screen.getByTestId('status-chip');
    await waitFor(() => expect(within(chip).getByText(/System OK/i)).toBeInTheDocument());
    expect(within(chip).queryByText(/gpt-5\.5/i)).not.toBeInTheDocument();
  });

  it('restores the last screen from localStorage', () => {
    localStorage.setItem('hermes-mobile-screen', 'settings');
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('restores Kanban from localStorage instead of falling back to Home/New chat', async () => {
    localStorage.setItem('hermes-mobile-screen', 'kanban');
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    expect(screen.getByRole('heading', { name: 'Kanban' })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('hermes-mobile-screen')).toBe('kanban'));
  });

  it('keeps the current screen persisted when the PWA is backgrounded or closed', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Kanban' })).toBeInTheDocument());
    localStorage.removeItem('hermes-mobile-screen');
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem('hermes-mobile-screen')).toBe('kanban');
  });

  it('persists screen to localStorage when navigating', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument(),
    );
    expect(localStorage.getItem('hermes-mobile-screen')).toBe('agents');
  });

  it('opens drawer sessions with the selected session profile', async () => {
    useProfilesStore.setState({
      profiles: [{ name: 'default', displayName: 'default', isActive: true }],
      activeName: 'default',
      currentName: 'default',
      loading: false,
      error: undefined,
    });
    vi.mocked(restMock.profileSessions).mockResolvedValue([
      { id: 'sess-2', title: 'Other profile session', profile: 'research', messageCount: 2, updatedAt: Date.now() },
    ] as unknown as import('@hermes-pwa/core').Session[]);
    const resume = vi.spyOn(useChatStore.getState(), 'resumeSessionIntoChat').mockResolvedValue(undefined);

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = await screen.findByRole('dialog', { name: /navigation menu/i });
    await waitFor(() => expect(within(drawer).getByText(/Other profile session/)).toBeInTheDocument());
    fireEvent.click(within(drawer).getByText(/Other profile session/));

    await waitFor(() =>
      expect(resume).toHaveBeenCalledWith(restMock, rpcMock, 'sess-2', 'research'),
    );
  });

  it('captures approval events globally while chat is open and responds with backend session choice', async () => {
    localStorage.setItem('hermes-mobile-screen', 'chat');
    localStorage.setItem(
      'hermes-pwa.activeSession.v4:default',
      JSON.stringify({
        profile: 'default',
        sessionId: 'sess-approval-1',
        storedSessionId: 'stored-approval-1',
        messages: [{ id: 'a-1', role: 'assistant', text: '', toolCalls: [{ id: 'tool-approval-1', name: 'terminal' }] }],
      }),
    );
    useChatStore.setState({
      sessionId: 'sess-approval-1',
      storedSessionId: 'stored-approval-1',
      streaming: true,
      messages: [
        {
          id: 'a-1',
          role: 'assistant',
          text: '',
          createdAt: undefined,
          toolCalls: [{ id: 'tool-approval-1', name: 'terminal' }],
        },
      ],
      error: undefined,
    });
    vi.mocked(rpcMock.request).mockResolvedValue({ resolved: 1 });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      messages: [
        {
          id: 'a-1',
          role: 'assistant',
          text: '',
          tool_calls: [{ id: 'tool-approval-1', name: 'terminal' }],
        },
      ],
    });
    useConnectionStore.setState({ state: 'reconnecting', error: undefined } as ReturnType<typeof useConnectionStore.getState>);
    render(<AppShell connectionState="reconnecting" rpc={rpcMock} rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Tool actions')).toBeInTheDocument());

    rpcMock.events.dispatchEvent({
      type: 'approval.request',
      sessionId: 'sess-approval-1',
      payload: {
        id: 'approval-1',
        command: 'systemctl --user restart hermes-dashboard',
        description: 'Dangerous command approval required',
        pattern_key: 'systemctl-restart',
      },
    });

    await waitFor(() => expect(screen.getByText(/systemctl --user restart hermes-dashboard/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(rpcMock.request).toHaveBeenCalledWith('approval.respond', {
        choice: 'once',
        session_id: 'sess-approval-1',
      }),
    );
  });

  it('keeps approval events visible on the approvals screen even if they arrive elsewhere', async () => {
    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    rpcMock.events.dispatchEvent({
      type: 'approval.request',
      sessionId: 'sess-approval-2',
      payload: {
        id: 'approval-2',
        command: 'rm -rf /tmp/test',
        description: 'Dangerous command approval required',
        pattern_key: 'rm-rf',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    const drawer = await screen.findByRole('dialog', { name: /navigation menu/i });
    await waitFor(() => expect(within(drawer).getByText('1')).toBeInTheDocument());
    fireEvent.click(within(drawer).getByRole('button', { name: /Approvals/ }));

    await waitFor(() => expect(screen.getByText(/rm -rf \/tmp\/test/)).toBeInTheDocument());
  });

  it('hydrates pending approvals when a push opens the approvals screen cold', async () => {
    window.location.hash = '#/approvals';
    vi.mocked(restMock.pendingActions).mockResolvedValue([
      {
        id: 'approval:push-open',
        kind: 'approval',
        status: 'needs_you',
        title: 'Approval required',
        highImpact: true,
        sessionId: 'gateway-session-key',
        summary: 'rm -rf /tmp/from-push\nDangerous command approval required',
        createdAt: Date.now(),
      },
    ] as import('@hermes-pwa/core').Approval[]);

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    await waitFor(() => expect(restMock.pendingActions).toHaveBeenCalledWith('default'));
    expect(await screen.findByText(/rm -rf \/tmp\/from-push/)).toBeInTheDocument();
  });

  it('recovers the cached active chat history even when push opens approvals instead of mounting Chat', async () => {
    window.location.hash = '#/approvals';
    useChatStore.setState({
      sessionId: 'live-from-cache',
      storedSessionId: 'stored-from-cache',
      streaming: true,
      messages: [
        { id: 'u-1', role: 'user', text: 'trigger approval', createdAt: 1 },
        {
          id: 'a-local',
          role: 'assistant',
          text: '',
          createdAt: 2,
          toolCalls: [{ id: 'tool-local', name: 'terminal', input: { command: 'rm -rf /tmp/from-push' } }],
        },
      ],
      error: undefined,
      cacheProfile: 'default',
    });
    vi.mocked(restMock.sessionMessages).mockResolvedValue({
      session_id: 'stored-from-cache',
      messages: [
        { id: 'u-1', role: 'user', text: 'trigger approval', created_at: 1 },
        { id: 'a-rest', role: 'assistant', text: 'waiting for approval', created_at: 2 },
      ],
    });

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    await waitFor(() => expect(restMock.sessionMessages).toHaveBeenCalledWith('stored-from-cache', 'default'));
    await waitFor(() => expect(useChatStore.getState().messages.some((message) => message.text === 'waiting for approval')).toBe(true));
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('syncs an existing browser push subscription after connected startup using the active profile', async () => {
    useProfilesStore.setState({
      profiles: [{ name: 'dev', displayName: 'Dev', isActive: true }],
      activeName: 'dev',
      currentName: 'dev',
      loading: false,
      error: undefined,
    });
    vi.mocked(restMock.pushStatus).mockResolvedValue({
      available: true,
      enabled: true,
      vapidPublicKey: 'test-public-key',
      subscriptions: [],
    });
    const subscription = {
      endpoint: 'https://push.example/new-endpoint',
      toJSON: () => ({ endpoint: 'https://push.example/new-endpoint', keys: { p256dh: 'p', auth: 'a' } }),
    };
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('PushManager', function PushManager() {});
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue(subscription),
          },
        }),
      },
    });

    render(<AppShell connectionState="connected" rpc={rpcMock} rest={restMock} />);

    await waitFor(() => expect(restMock.pushSubscribe).toHaveBeenCalledWith(
      { subscription: subscription.toJSON(), label: 'Hermes Mobile' },
      'dev',
    ));
  });

  it('shows status chip for reconnecting state', () => {
    render(<AppShell connectionState="reconnecting" rpc={rpcMock} rest={restMock} />);
    const chip = screen.getByTestId('status-chip');
    expect(within(chip).getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
