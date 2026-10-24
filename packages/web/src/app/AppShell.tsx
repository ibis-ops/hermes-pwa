import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Approval, Clarify, ConnectionState, RpcClient, RestClient, RpcEvent, Session, UpdateCheck } from '@hermes-pwa/core';
import { SPAWN_EVENT_TYPES, connectionStateLabel, sessionSourceId, sessionSourceLabel, useActivityStore, useProfilesStore, useSessionsStore, useChatStore, useConnectionStore, useProjectsStore, useSpawnStore } from '@hermes-pwa/core';
import { Home } from '../screens/Home';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { Icon, type IconName } from '../components/Icon';
import { UpdateNotification } from '../components/UpdateNotification';
import { LazyScreenErrorBoundary } from './LazyScreenErrorBoundary';
import { usePresence } from '../hooks/usePresence';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { useSettledConnectionState } from '../hooks/useSettledConnectionState';
import { getInitialScreen, persistScreen } from '../lib/screenStorage';
import { disablePushNotifications, syncPushSubscription } from '../pwa/push';

export type Screen =
  | 'home'
  | 'chat'
  | 'sessions'
  | 'approvals'
  | 'kanban'
  | 'agents'
  | 'messaging'
  | 'profiles'
  | 'cron'
  | 'artifacts'
  | 'skills'
  | 'command'
  | 'settings';

interface AppShellProps {
  connectionState: ConnectionState;
  rpc: RpcClient;
  rest: RestClient;
  onRetry?: () => void;
}

type SourceFilter = 'all' | string;
const UPDATE_DISMISSED_STORAGE_KEY = 'hermes-pwa:update-dismissed-version';

const Chat = lazy(() => import('../screens/Chat').then((module) => ({ default: module.Chat })));
const Activity = lazy(() => import('../screens/Activity').then((module) => ({ default: module.Activity })));
const Projects = lazy(() => import('../screens/Projects').then((module) => ({ default: module.Projects })));
const Agents = lazy(() => import('../screens/Agents').then((module) => ({ default: module.Agents })));
const Messaging = lazy(() => import('../screens/Messaging').then((module) => ({ default: module.Messaging })));
const Profiles = lazy(() => import('../screens/Profiles').then((module) => ({ default: module.Profiles })));
const Sessions = lazy(() => import('../screens/Sessions').then((module) => ({ default: module.Sessions })));
const CommandCenter = lazy(() => import('../screens/CommandCenter').then((module) => ({ default: module.CommandCenter })));
const Cron = lazy(() => import('../screens/Cron').then((module) => ({ default: module.Cron })));
const Artifacts = lazy(() => import('../screens/Artifacts').then((module) => ({ default: module.Artifacts })));
const Settings = lazy(() => import('../screens/Settings').then((module) => ({ default: module.Settings })));

const DRAWER_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function drawerFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute('disabled')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (element.hidden) return false;
    return true;
  });
}

interface SourceFilterOption {
  key: SourceFilter;
  label: string;
  count: number;
}

function sessionSourceKey(session: Pick<Session, 'source'>): string {
  return sessionSourceId(session) ?? 'unknown';
}

function buildSourceFilterOptions(sessions: Session[]): SourceFilterOption[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    counts.set(sessionSourceKey(session), (counts.get(sessionSourceKey(session)) ?? 0) + 1);
  }
  const sourceOptions = Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: sessionSourceLabel(key) ?? 'Unknown', count }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ key: 'all', label: 'All', count: sessions.length }, ...sourceOptions];
}

function eventPayload(event: RpcEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
}

function approvalFromEvent(event: RpcEvent): Approval {
  const d = eventPayload(event);
  const command = typeof d.command === 'string' ? d.command : '';
  const description = typeof d.description === 'string' ? d.description : '';
  const patternKey = typeof d.pattern_key === 'string' ? d.pattern_key : '';
  const item: Approval = {
    id: typeof d.id === 'string'
      ? d.id
      : `approval-${event.sessionId ?? 'global'}-${patternKey || Date.now()}`,
    kind: 'approval',
    status: 'needs_you',
    title: typeof d.title === 'string' ? d.title : 'Approval required',
    highImpact: Boolean(d.high_impact ?? d.highImpact ?? true),
    createdAt: Date.now(),
  };
  if (event.sessionId) item.sessionId = event.sessionId;
  if (typeof d.session === 'string') item.session = d.session;
  else if (event.sessionId) item.session = `Session ${event.sessionId.slice(0, 8)}`;
  const summary = [command, description].filter(Boolean).join('\n');
  if (summary) item.summary = summary;
  if (command) {
    item.command = command;
    item.commandComplete = true;
  }
  if (typeof d.visibility === 'string' && (d.visibility === 'private' || d.visibility === 'public')) {
    item.visibility = d.visibility;
  } else {
    item.visibility = 'private';
  }
  return item;
}

function clarifyFromEvent(event: RpcEvent): Clarify {
  const d = eventPayload(event);
  const item: Clarify = {
    id: typeof d.id === 'string' ? d.id : `clarify-${event.sessionId ?? 'global'}-${Date.now()}`,
    kind: 'clarify',
    status: 'needs_you',
    title: typeof d.title === 'string' ? d.title : 'Clarification needed',
    question: typeof d.question === 'string' ? d.question : '',
    createdAt: Date.now(),
  };
  if (event.sessionId) item.sessionId = event.sessionId;
  return item;
}

const DRAWER_ITEMS: { key: Screen; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'profiles', label: 'Profiles', icon: 'profiles' },
  { key: 'chat', label: 'Chat', icon: 'chat' },
  { key: 'approvals', label: 'Approvals', icon: 'shield' },
  { key: 'sessions', label: 'Sessions', icon: 'sessions' },
  { key: 'kanban', label: 'Kanban', icon: 'kanban' },
  { key: 'cron', label: 'Cron', icon: 'cron' },
  { key: 'agents', label: 'Agents', icon: 'agents' },
  { key: 'messaging', label: 'Messaging', icon: 'messaging' },
  // TODO: Skills/Tools is temporarily hidden from the PWA menu until we decide
  // whether this administrative surface belongs in the mobile app.
  // { key: 'skills', label: 'Skills & Tools', icon: 'skills' },
  { key: 'command', label: 'System', icon: 'system' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

const HIDDEN_ADMIN_SCREENS = new Set<Screen>([
  // TODO: Skills/Tools is temporarily hidden from the PWA until we decide
  // whether this administrative surface belongs in the mobile app.
  // Keep the screen modules in the codebase, but block stale/internal navigation
  // from opening them in the production shell for now.
  'skills',
]);

const SCREEN_TITLES: Record<Screen, string> = {
  home: 'Home',
  chat: 'Chat',
  sessions: 'Sessions',
  approvals: 'Approvals',
  kanban: 'Kanban',
  agents: 'Agents',
  messaging: 'Messaging',
  profiles: 'Profiles',
  cron: 'Cron',
  artifacts: 'Artifacts',
  skills: 'Skills',
  command: 'System',
  settings: 'Settings',
};

type GatewayHealth = 'checking' | 'running' | 'unavailable';

function StatusChip({ state, gatewayHealth }: { state: ConnectionState; gatewayHealth: GatewayHealth }) {
  const isOk = state === 'connected';
  const isWarn = state === 'reconnecting' || state === 'ticketing';
  const gatewayWarning = isOk && gatewayHealth !== 'running';
  const color = isOk
    ? gatewayWarning
      ? 'var(--hm-color-warning)'
      : 'var(--hm-color-success)'
    : isWarn
      ? 'var(--hm-color-warning)'
      : 'var(--hm-color-danger)';
  const label = isOk
    ? gatewayHealth === 'running'
      ? 'System OK'
      : gatewayHealth === 'checking'
        ? 'Checking'
        : 'Gateway ?'
    : connectionStateLabel(state);
  return (
    <div className="hm-status-chip" data-testid="status-chip" style={{ borderColor: 'var(--hm-color-border)' }}>
      <span
        className="hm-status-chip__dot"
        style={{ background: color, animation: isOk && !gatewayWarning ? 'hm-pulse 2s infinite' : undefined }}
      />
      <span className="hm-status-chip__label">{label}</span>
    </div>
  );
}

function gatewayStatusLabel(state: ConnectionState, gatewayHealth: GatewayHealth): string {
  if (state !== 'connected') return connectionStateLabel(state);
  if (gatewayHealth === 'running') return 'Gateway ready';
  if (gatewayHealth === 'checking') return 'Checking gateway';
  return 'Gateway ?';
}

function gatewayStatusTone(state: ConnectionState, gatewayHealth: GatewayHealth): 'ok' | 'warn' | 'error' {
  if (state === 'connected' && gatewayHealth === 'running') return 'ok';
  if (state === 'offline') return 'error';
  return 'warn';
}

function DrawerSessionRow({
  dot,
  title,
  msgs,
  onClick,
}: {
  dot: string;
  title: string;
  msgs: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className="hm-drawer__session" onClick={onClick}>
      <span className="hm-drawer__session-dot" style={{ background: dot }} />
      <span className="hm-drawer__session-title">{title}</span>
      <span className="hm-drawer__session-msgs">{msgs}</span>
    </button>
  );
}

export function AppShell({ connectionState, rpc, rest, onRetry }: AppShellProps) {
  useVisualViewport();
  // Header status follows the connection only once a drop has lasted a moment.
  const settledConnectionState = useSettledConnectionState(connectionState);
  const [screen, setScreen] = useState<Screen>(() => getInitialScreen());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSourceFilter, setDrawerSourceFilter] = useState<SourceFilter>('all');
  const [gatewayHealth, setGatewayHealth] = useState<GatewayHealth>('checking');
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | undefined>();
  const [updateDismissedVersion, setUpdateDismissedVersion] = useState<string | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(UPDATE_DISMISSED_STORAGE_KEY);
  });
  const drawer = usePresence(drawerOpen, 260);
  const activeName = useProfilesStore((s) => s.activeName);
  const currentName = useProfilesStore((s) => s.currentName);
  const { profiles, load: loadProfiles } = useProfilesStore();
  const { sessions, load } = useSessionsStore();
  const { sessionId, storedSessionId } = useChatStore();
  const { startNewSession } = useChatStore();
  const addActivityItem = useActivityStore((s) => s.addItem);
  const loadActivity = useActivityStore((s) => s.load);
  const pendingApprovals = useActivityStore(
    (s) => s.items.filter((item) => item.kind === 'approval' && item.status === 'needs_you').length,
  );
  const { loadBoards } = useProjectsStore();

  const currentSession = sessions.find((s) => {
    if (storedSessionId && (s.id === storedSessionId || s.lineageRootId === storedSessionId)) return true;
    if (sessionId && (s.id === sessionId || s.lineageRootId === sessionId)) return true;
    return false;
  });
  const screenTitle = screen === 'chat' && currentSession?.title ? currentSession.title : SCREEN_TITLES[screen];
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerPanelRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const drawerPreviousFocusRef = useRef<HTMLElement | null>(null);
  const pendingRefreshInFlightRef = useRef(false);
  const chatRecoveryInFlightRef = useRef(false);
  const pushSyncInFlightRef = useRef(false);

  useEffect(() => {
    persistScreen(screen);
  }, [screen]);

  useEffect(() => {
    function persistCurrentScreen() {
      persistScreen(screen);
    }
    function persistWhenHidden() {
      if (document.visibilityState === 'hidden') persistCurrentScreen();
    }
    window.addEventListener('pagehide', persistCurrentScreen);
    document.addEventListener('visibilitychange', persistWhenHidden);
    return () => {
      window.removeEventListener('pagehide', persistCurrentScreen);
      document.removeEventListener('visibilitychange', persistWhenHidden);
    };
  }, [screen]);

  useEffect(() => {
    if (!drawerOpen) return;
    void load(rest);
  }, [drawerOpen, load, rest]);

  useEffect(() => {
    void loadProfiles(rest);
  }, [rest, loadProfiles]);

  useEffect(() => {
    if (connectionState !== 'connected') return undefined;
    let cancelled = false;
    void rest
      .updateCheck()
      .then((next) => {
        if (!cancelled) setUpdateCheck(next);
      })
      .catch(() => {
        if (!cancelled) setUpdateCheck(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionState, rest]);

  useEffect(() => {
    if (!activeName) return;
    rest.setActiveProfile?.(activeName);
    void load(rest);
    void loadBoards(rest);
  }, [activeName, rest, load, loadBoards]);

  useEffect(() => {
    if (connectionState !== 'connected') return undefined;
    let cancelled = false;

    const refreshPendingActions = () => {
      if (cancelled || pendingRefreshInFlightRef.current) return;
      pendingRefreshInFlightRef.current = true;
      const profile = activeName ?? 'default';
      void loadActivity(rest, profile).finally(() => {
        pendingRefreshInFlightRef.current = false;
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshPendingActions();
    };

    refreshPendingActions();
    window.addEventListener('focus', refreshPendingActions);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshPendingActions);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [connectionState, activeName, rest, loadActivity]);

  useEffect(() => {
    if (connectionState !== 'connected') return undefined;
    if (screen === 'chat') return undefined;
    if (activeName && currentName && activeName !== currentName) return undefined;
    let cancelled = false;

    const recoverActiveChatHistory = () => {
      if (cancelled || chatRecoveryInFlightRef.current) return;
      const { sessionId: liveId, storedSessionId: durableId, messages } = useChatStore.getState();
      if (!liveId && !durableId && messages.length === 0) return;
      chatRecoveryInFlightRef.current = true;
      const profile = activeName ?? useChatStore.getState().cacheProfile ?? 'default';
      void (async () => {
        try {
          await useSessionsStore.getState().load(rest);
          if (cancelled) return;
          await useChatStore.getState().refreshHistory(rest, profile);
        } finally {
          chatRecoveryInFlightRef.current = false;
        }
      })();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverActiveChatHistory();
    };

    recoverActiveChatHistory();
    window.addEventListener('focus', recoverActiveChatHistory);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', recoverActiveChatHistory);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [connectionState, screen, activeName, currentName, rest]);

  useEffect(() => {
    if (connectionState !== 'connected') return undefined;
    let cancelled = false;

    const syncExistingPushSubscription = () => {
      if (cancelled || pushSyncInFlightRef.current) return;
      pushSyncInFlightRef.current = true;
      const profile = activeName ?? 'default';
      void (async () => {
        try {
          const status = await rest.pushStatus();
          if (!cancelled && status.available && status.vapidPublicKey) {
            await syncPushSubscription(rest, status.vapidPublicKey, profile);
          }
        } catch {
          // Best-effort startup/focus sync; Settings still shows the explicit push state.
        } finally {
          pushSyncInFlightRef.current = false;
        }
      })();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') syncExistingPushSubscription();
    };

    syncExistingPushSubscription();
    window.addEventListener('focus', syncExistingPushSubscription);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', syncExistingPushSubscription);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [connectionState, activeName, rest]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function probeGateway() {
      // A brief reconnect keeps the last known gateway health; the probe runs
      // again as soon as the socket is back.
      if (connectionState !== 'connected') return;
      try {
        await rest.systemStats();
        if (!cancelled) setGatewayHealth('running');
      } catch {
        if (!cancelled) setGatewayHealth('unavailable');
      }
    }

    void probeGateway();
    if (connectionState === 'connected') {
      timer = window.setInterval(() => {
        void probeGateway();
      }, 30_000);
    }

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [connectionState, rest]);

  useEffect(() => {
    const onApprovalRequired = (event: RpcEvent) => addActivityItem(approvalFromEvent(event));
    const onClarifyRequired = (event: RpcEvent) => addActivityItem(clarifyFromEvent(event));
    const onStatusUpdate = (event: RpcEvent) => {
      const d = eventPayload(event);
      const kind = typeof d.kind === 'string' ? d.kind : undefined;
      const text = typeof d.text === 'string' ? d.text : undefined;
      if (kind === 'process' && text) {
        addActivityItem({
          id: `status-${event.sessionId ?? 'global'}-${Date.now()}`,
          kind: 'run',
          status: 'running',
          title: text,
          createdAt: Date.now(),
        });
      }
    };

    rpc.events.addEventListener('approval.request', onApprovalRequired);
    rpc.events.addEventListener('clarify.request', onClarifyRequired);
    rpc.events.addEventListener('status.update', onStatusUpdate);
    return () => {
      rpc.events.removeEventListener('approval.request', onApprovalRequired);
      rpc.events.removeEventListener('clarify.request', onClarifyRequired);
      rpc.events.removeEventListener('status.update', onStatusUpdate);
    };
  }, [rpc, addActivityItem]);

  // Subagent frames feed the spawn store from here, whatever screen is open,
  // so the chat can show delegated agents as they run and the Agents screen
  // opens with the full picture.
  const chatSessionId = useChatStore((s) => s.sessionId);
  useEffect(() => {
    if (chatSessionId) useSpawnStore.getState().setSession(chatSessionId);
  }, [chatSessionId]);
  useEffect(() => {
    const handlers = SPAWN_EVENT_TYPES.map((type) => {
      const handler = (event: RpcEvent) => {
        useSpawnStore.getState().handleEvent(type, (event.payload ?? {}) as Record<string, unknown>);
      };
      rpc.events.addEventListener(type, handler);
      return { type, handler };
    });
    return () => {
      for (const { type, handler } of handlers) rpc.events.removeEventListener(type, handler);
    };
  }, [rpc]);


  useEffect(() => {
    if (!drawer.mounted || !drawerOpen) return;
    drawerPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallbackFocus = menuRef.current;
    if (drawerCloseRef.current) {
      drawerCloseRef.current.focus();
    }
    return () => {
      const previous = drawerPreviousFocusRef.current;
      drawerPreviousFocusRef.current = null;
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      } else {
        fallbackFocus?.focus({ preventScroll: true });
      }
    };
  }, [drawer.mounted, drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = drawerPanelRef.current;
      if (!panel) return;
      const focusable = drawerFocusableElements(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  function navigate(s: Screen) {
    if (HIDDEN_ADMIN_SCREENS.has(s)) {
      s = 'home';
    }
    setScreen(s);
    persistScreen(s);
    setDrawerOpen(false);
  }

  function handleNewSession() {
    startNewSession(activeName);
    navigate('chat');
  }

  const handleDrawerSession = useCallback(async (session: Session) => {
    await useChatStore.getState().resumeSessionIntoChat(rest, rpc, session.id, session.profile ?? activeName);
    navigate('chat');
  }, [activeName, rest, rpc]);

  const activeProfile = profiles.find((p) => p.name === activeName);
  const activeModel = activeProfile?.model?.trim() || 'Model not set';
  const activeProvider = activeProfile?.provider?.trim();
  const activeProfileLabel = activeProfile?.displayName ?? activeName ?? 'default';
  const modelDetail = activeProvider ? `${activeProvider} · ${activeProfileLabel}` : activeProfileLabel;
  const gatewayLabel = gatewayStatusLabel(settledConnectionState, gatewayHealth);
  const gatewayTone = gatewayStatusTone(connectionState, gatewayHealth);
  const showUpdateNotification = updateCheck?.updateAvailable === true && updateCheck.latest !== updateDismissedVersion;

  function dismissUpdateNotification() {
    const version = updateCheck?.latest ?? updateCheck?.current;
    if (!version) return;
    localStorage.setItem(UPDATE_DISMISSED_STORAGE_KEY, version);
    setUpdateDismissedVersion(version);
  }

  const visibleSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions]);
  const drawerSourceOptions = useMemo(() => buildSourceFilterOptions(visibleSessions), [visibleSessions]);
  const filteredDrawerSessions = useMemo(
    () =>
      drawerSourceFilter === 'all'
        ? visibleSessions
        : visibleSessions.filter((s) => sessionSourceKey(s) === drawerSourceFilter),
    [drawerSourceFilter, visibleSessions],
  );
  const drawerSessions = useMemo(
    () =>
      filteredDrawerSessions.slice(0, 7).map((s) => ({
        id: s.id,
        title: `${sessionSourceLabel(sessionSourceKey(s)) ?? 'Unknown'} · ${s.title?.trim() || 'Untitled'}`,
        msgs: s.messageCount ?? 0,
        dot: s.isActive || s.active ? '#15a06a' : '#9aa2b4',
        onClick: () => void handleDrawerSession(s),
      })),
    [filteredDrawerSessions, handleDrawerSession],
  );

  return (
    <div className="hm-app-shell">
      {/* ── Header ───────────────────────────────────────────────── */}
      <header className="hm-header" data-testid="app-header">
        <button
          ref={menuRef}
          className="hm-header__menu"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-haspopup="dialog"
        >
          <Icon name="menu" size={22} />
        </button>
        <h1 className="hm-header__title">{screenTitle}</h1>
        <button
          type="button"
          className="hm-header__status"
          onClick={() => navigate('command')}
          aria-label="Open system status"
          aria-haspopup="dialog"
        >
          <StatusChip state={settledConnectionState} gatewayHealth={gatewayHealth} />
        </button>
      </header>

      {/* ── Connection banner ────────────────────────────────────── */}
      <ConnectionBanner state={connectionState} error={undefined} onRetry={onRetry} />
      {showUpdateNotification && updateCheck ? (
        <UpdateNotification update={updateCheck} onDismiss={dismissUpdateNotification} />
      ) : null}

      {/* ── Screen ───────────────────────────────────────────────── */}
      <main className="hm-screen">
        <LazyScreenErrorBoundary key={screen}>
          <Suspense fallback={<p className="hm-muted hm-loading">Loading…</p>}>
            {screen === 'chat'      && <Chat key={activeName ?? 'default'} rpc={rpc} rest={rest} />}
            {screen === 'sessions'  && <Sessions key={activeName ?? 'default'} rpc={rpc} rest={rest} onSessionOpen={() => navigate('chat')} />}
            {screen === 'approvals' && <Activity key={activeName ?? 'default'} rpc={rpc} />}
            {screen === 'kanban'    && <Projects key={activeName ?? 'default'} rest={rest} />}
            {screen === 'agents'    && <Agents key={activeName ?? 'default'} rpc={rpc} />}
            {screen === 'messaging' && <Messaging key={activeName ?? 'default'} rest={rest} />}
            {screen === 'profiles'  && <Profiles key={activeName ?? 'default'} rest={rest} />}
            {screen === 'home'      && <Home key={activeName ?? 'default'} rpc={rpc} rest={rest} onNavigate={(s) => navigate(s as Screen)} />}
            {screen === 'command'   && <CommandCenter key={activeName ?? 'default'} rest={rest} />}
            {screen === 'cron'      && <Cron key={activeName ?? 'default'} rest={rest} />}
            {screen === 'artifacts' && <Artifacts key={activeName ?? 'default'} rest={rest} />}
            {screen === 'settings'  && (
              <Settings
                key={activeName ?? 'default'}
                rest={rest}
                onNavigate={(s) => navigate(s as Screen)}
                onLogout={() => {
                  void (async () => {
                    // A logged-out phone must stop receiving approval and reply
                    // notifications; drop the push subscription first while the
                    // session cookie can still authorize the unsubscribe call.
                    try {
                      await disablePushNotifications(rest, undefined, activeName ?? 'default');
                    } catch {
                      // Best effort; logout proceeds either way.
                    }
                    await useConnectionStore.getState().logout();
                  })();
                }}
              />
            )}
          </Suspense>
        </LazyScreenErrorBoundary>
      </main>

      {/* ── Drawer ───────────────────────────────────────────────── */}
      {(drawerOpen || drawer.mounted) && (
        <div
          className="hm-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          data-closing={drawer.leaving || undefined}
        >
          <button
            className="hm-drawer__overlay"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
            tabIndex={-1}
          />
          <nav className="hm-drawer__panel" ref={drawerPanelRef} tabIndex={-1}>
            <div className="hm-drawer__header">
              <span className="hm-drawer__brand">
                <img className="hm-drawer__brand-logo" src="./icons/icon-192.png" alt="" aria-hidden="true" />
                <span className="hm-drawer__wordmark">
                  Hermes
                  <span className="hm-drawer__wordmark-sub">Mobile, unofficial</span>
                </span>
              </span>
              <button
                ref={drawerCloseRef}
                className="hm-drawer__close"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                <Icon name="close" size={17} />
              </button>
            </div>

            <div className="hm-drawer__cta">
              <button type="button" className="hm-drawer__new" onClick={handleNewSession}>
                <Icon name="plus" size={18} />
                <span>New session</span>
              </button>
            </div>

            <div className="hm-drawer__nav">
              {DRAWER_ITEMS.map((item) => (
                <button
                  key={item.key}
                  className={`hm-drawer__item${screen === item.key ? ' hm-drawer__item--active' : ''}`}
                  onClick={() => navigate(item.key)}
                  aria-current={screen === item.key ? 'page' : undefined}
                >
                  <span className="hm-drawer__item-icon" aria-hidden="true">
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span className="hm-drawer__item-label">{item.label}</span>
                  {item.key === 'approvals' && pendingApprovals > 0 && (
                    <span className="hm-drawer__badge">{pendingApprovals}</span>
                  )}
                  {item.key === 'sessions' && sessions.length > 0 && (
                    <span className="hm-drawer__badge hm-drawer__badge--muted">{sessions.length}</span>
                  )}
                </button>
              ))}
            </div>

            {visibleSessions.length > 0 && (
              <>
                <div className="hm-drawer__section-head">
                  <span>Sessions</span>
                  <span className="hm-drawer__section-count">{filteredDrawerSessions.length}/{visibleSessions.length}</span>
                </div>
                <div className="hm-drawer__source-filters" role="tablist" aria-label="Session source filters">
                  {drawerSourceOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`hm-drawer__source-chip${drawerSourceFilter === option.key ? ' hm-drawer__source-chip--active' : ''}`}
                      onClick={() => setDrawerSourceFilter(option.key)}
                      role="tab"
                      aria-selected={drawerSourceFilter === option.key}
                    >
                      <span>{option.label}</span>
                      <span className="hm-drawer__source-count">{option.count}</span>
                    </button>
                  ))}
                </div>
                <div className="hm-drawer__sessions" aria-live="polite">
                  {drawerSessions.map((s) => (
                    <DrawerSessionRow
                      key={s.id}
                      dot={s.dot}
                      title={s.title}
                      msgs={s.msgs}
                      onClick={s.onClick}
                    />
                  ))}
                  {drawerSessions.length === 0 && (
                    <div className="hm-drawer__sessions-empty">No sessions for this source.</div>
                  )}
                </div>
              </>
            )}

            <div className="hm-drawer__footer">
              <button
                type="button"
                className="hm-drawer__footer-row hm-drawer__footer-row--model"
                onClick={() => navigate('settings')}
                aria-label="Open model settings"
              >
                <span className="hm-drawer__footer-main">{activeModel}</span>
                <span className="hm-drawer__footer-sub">{modelDetail}</span>
              </button>
              <button
                type="button"
                className="hm-drawer__footer-row hm-drawer__footer-row--gateway"
                onClick={() => navigate('command')}
                aria-label="Open system status"
              >
                <span className={`hm-drawer__status-dot hm-drawer__status-dot--${gatewayTone}`} />
                <span className="hm-drawer__status-text">{gatewayLabel}</span>
                <span className="hm-drawer__footer-sub">System</span>
              </button>
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
