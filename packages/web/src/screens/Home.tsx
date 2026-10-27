import {
  useActivityStore,
  useSessionsStore,
  useChatStore,
  useProfilesStore,
  type RpcClient,
  type RestClient,
} from '@hermes-pwa/core';
import { Icon } from '../components/Icon';

interface HomeProps {
  rpc: RpcClient;
  rest: RestClient;
  onNavigate: (screen: string) => void;
}

function fmtAge(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

const TILES: {
  key: string;
  label: string;
  sub: string;
  icon: import('../components/Icon').IconName;
  tint: string;
  color: string;
}[] = [
  // iOS system colors as filled icon squares with white glyphs; they read the
  // same in light and dark mode.
  { key: 'chat', label: 'New chat', sub: 'Start fresh', icon: 'chat', tint: 'var(--hm-color-primary)', color: 'var(--hm-color-primary-text)' },
  { key: 'approvals', label: 'Approvals', sub: 'Waiting on you', icon: 'shield', tint: 'var(--hm-color-warning)', color: 'var(--hm-color-primary-text)' },
  { key: 'kanban', label: 'Kanban', sub: 'Tasks and runs', icon: 'kanban', tint: 'var(--hm-color-purple)', color: 'var(--hm-color-primary-text)' },
  { key: 'sessions', label: 'Sessions', sub: 'History', icon: 'sessions', tint: 'var(--hm-color-success)', color: 'var(--hm-color-primary-text)' },
  { key: 'cron', label: 'Schedules', sub: 'Recurring jobs', icon: 'cron', tint: 'var(--hm-color-teal)', color: 'var(--hm-color-primary-text)' },
  { key: 'command', label: 'System', sub: 'Gateway and health', icon: 'system', tint: 'var(--hm-color-danger)', color: 'var(--hm-color-primary-text)' },
];

export function Home({ rpc, rest, onNavigate }: HomeProps) {
  const { items: activityItems } = useActivityStore();
  const { sessions } = useSessionsStore();
  const activeName = useProfilesStore((s) => s.activeName);
  const { startNewSession, resumeSessionIntoChat } = useChatStore();

  const pendingApprovals = activityItems.filter((i) => i.status === 'needs_you').length;
  const liveSessions = sessions.filter((s) => s.isActive || s.active).length;
  const recentSessions = sessions.slice(0, 3);

  async function handleRecentOpen(sessionId: string, profile?: string) {
    await resumeSessionIntoChat(rest, rpc, sessionId, profile ?? activeName);
    onNavigate('chat');
  }

  function handleTileNavigate(key: string) {
    if (key === 'chat') {
      startNewSession(activeName);
    }
    onNavigate(key);
  }

  return (
    <div className="hm-home">
      <div className="hm-home__scroll">
      {/* Hero */}
      <div className="hm-home__hero">
        <h1 className="hm-home__wordmark">Hermes</h1>
        <p className="hm-home__desc">Running on your Mac. Ask for anything.</p>
      </div>

      {/* Approval banner */}
      {pendingApprovals > 0 && (
        <button
          className="hm-home__approval-banner"
          onClick={() => onNavigate('approvals')}
          data-testid="approval-banner"
        >
          <span className="hm-home__approval-icon">
            <Icon name="alert" size={18} />
          </span>
          <span className="hm-home__approval-body">
            <span className="hm-home__approval-title">
              {pendingApprovals} approval{pendingApprovals !== 1 ? 's' : ''} waiting
            </span>
            <span className="hm-home__approval-sub">Agent is paused waiting on you</span>
          </span>
          <span className="hm-home__approval-chevron" aria-hidden="true">
            <Icon name="chevR" size={15} />
          </span>
        </button>
      )}

      {/* Mission Control grid */}
      <div>
        <div className="hm-home__section-title">Mission Control</div>
        <div className="hm-home__grid">
          {TILES.map((tile) => (
            <button
              key={tile.key}
              className="hm-home__tile"
              onClick={() => handleTileNavigate(tile.key)}
              data-testid={`tile-${tile.key}`}
            >
              {tile.key === 'approvals' && pendingApprovals > 0 && (
                <span className="hm-home__tile-badge">{pendingApprovals}</span>
              )}
              <span
                className="hm-home__tile-icon"
                style={{ background: tile.tint, color: tile.color }}
              >
                <Icon name={tile.icon} size={18} />
              </span>
              <span className="hm-home__tile-label">{tile.label}</span>
              <span className="hm-home__tile-sub">
                {tile.key === 'chat' && liveSessions > 0
                  ? `${liveSessions} live session${liveSessions !== 1 ? 's' : ''}`
                  : tile.sub}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Recent sessions */}
      {recentSessions.length > 0 && (
        <div>
          <div className="hm-home__section-head">
            <span className="hm-home__section-title">Recent sessions</span>
            <button className="hm-home__all-link" onClick={() => onNavigate('sessions')}>
              All {sessions.length} ›
            </button>
          </div>
          <div className="hm-home__recent-list">
            {recentSessions.map((s) => (
              <button
                key={s.id}
                className="hm-home__recent-row"
                onClick={() => {
                  void handleRecentOpen(s.id, s.profile);
                }}
                data-testid="recent-session"
              >
                <span className="hm-home__recent-body">
                  <span className="hm-home__recent-title">{s.title?.trim() || 'Untitled'}</span>
                  <span className="hm-home__recent-meta">
                    {[
                      s.profile ? `${s.profile}` : undefined,
                      s.messageCount ? `${s.messageCount} msgs` : undefined,
                      s.updatedAt ? fmtAge(s.updatedAt) : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      </div>
      {/*
        TODO: Home composer is intentionally disabled until we decide whether
        Home should support prompt submission or remain navigation-only.
        Keep the Chat screen composer enabled; this is only the Home entry point.
      */}
    </div>
  );
}
