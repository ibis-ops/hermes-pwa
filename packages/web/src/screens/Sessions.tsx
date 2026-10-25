import { useEffect, useState } from 'react';
import {
  sessionCurrentSourceId,
  sessionHasDifferentCurrentSource,
  sessionSourceId,
  sessionSourceLabel,
  sessionSourceSearchTerms,
  useSessionsStore,
  useChatStore,
  useProfilesStore,
  type RpcClient,
  type RestClient,
  type Session,
} from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { SessionTranscript } from '../components/SessionTranscript';

interface SessionsProps {
  rpc: RpcClient;
  rest: RestClient;
  onSessionOpen: () => void;
}

type Filter = 'all' | 'live' | 'done' | 'archived';
type SourceFilter = 'all' | string;
/** Phone chats can be resumed; the rest (Signal, scheduled, delegated) is browsed read-only. */
type Scope = 'chats' | 'other';

interface SourceFilterOption {
  key: SourceFilter;
  label: string;
  count: number;
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'done', label: 'Done' },
  { key: 'archived', label: 'Archived' },
];

function fmtAge(updatedAt: number): string {
  const delta = Math.max(0, Date.now() - (updatedAt > 10_000_000_000 ? updatedAt : updatedAt * 1000));
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function sessionTitle(s: Session): string {
  return s.title?.trim() || 'Untitled';
}

function sessionSourceKey(session: Pick<Session, 'source' | 'originSource'>): string {
  return sessionSourceId(session) ?? 'unknown';
}

function buildSourceFilterOptions(sessions: Session[]): SourceFilterOption[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const source = sessionSourceKey(session);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  const sourceOptions = Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: sessionSourceLabel(key) ?? 'Unknown', count }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ key: 'all', label: 'All', count: sessions.length }, ...sourceOptions];
}

function sessionSearchText(session: Session): string {
  const source = sessionSourceKey(session);
  const currentSource = sessionCurrentSourceId(session) ?? source;
  return [
    sessionTitle(session),
    session.profile ?? '',
    session.profileName ?? '',
    session.cwd ?? '',
    source,
    currentSource,
    ...sessionSourceSearchTerms(source),
    ...sessionSourceSearchTerms(currentSource),
  ]
    .join(' ')
    .toLowerCase();
}

function StatusDot({ session }: { session: Session }) {
  const isLive = session.isActive || session.active;
  const color = isLive ? 'var(--hm-color-running)' : 'var(--hm-color-text-faint)';
  return (
    <span
      className="hm-session-dot"
      style={{
        background: color,
        animation: isLive ? 'hm-pulse 1.8s infinite' : undefined,
      }}
      aria-hidden="true"
    />
  );
}

function SessionRow({
  session,
  acting,
  readOnly,
  onSelect,
  onArchiveToggle,
  onDelete,
}: {
  session: Session;
  acting?: boolean;
  /** Browse-only rows open a transcript and carry no archive or delete actions. */
  readOnly?: boolean;
  onSelect: (s: Session) => void | Promise<void>;
  onArchiveToggle: (s: Session) => void | Promise<void>;
  onDelete: (s: Session) => void | Promise<void>;
}) {
  const source = sessionSourceKey(session);
  const sourceLabel = sessionSourceLabel(source);
  const currentSource = sessionCurrentSourceId(session);
  const currentSourceLabel = currentSource ? sessionSourceLabel(currentSource) ?? currentSource : null;
  const bot = session.profileName && session.profileName !== session.profile ? session.profileName : undefined;
  const meta = [
    bot ?? session.profile,
    session.messageCount != null ? `${session.messageCount} msgs` : undefined,
    fmtAge(session.updatedAt),
  ].filter(Boolean);
  const archiveLabel = session.archived ? 'Restore session' : 'Archive session';

  return (
    <div className={`hm-session-row${readOnly ? ' hm-session-row--readonly' : ''}`} data-testid="session-row" data-readonly={readOnly ? 'true' : 'false'}>
      <button
        className="hm-session-row__open"
        onClick={() => void onSelect(session)}
        aria-label={`${readOnly ? 'Read session' : 'Open session'}: ${sessionTitle(session)}`}
      >
        <StatusDot session={session} />
        <span className="hm-session-row__body">
          <span className="hm-session-row__title">{sessionTitle(session)}</span>
          {meta.length > 0 && (
            <span className="hm-session-row__meta">
              {sourceLabel ? <span className="hm-source-badge">{sourceLabel}</span> : null}
              {sessionHasDifferentCurrentSource(session) && currentSourceLabel ? (
                <span className="hm-source-badge hm-source-badge--secondary">Current: {currentSourceLabel}</span>
              ) : null}
              <span>{meta.join(' · ')}</span>
            </span>
          )}
        </span>
      </button>
      {readOnly ? null : (
      <div className="hm-session-row__actions" aria-label={`Actions for ${sessionTitle(session)}`}>
        <button
          type="button"
          className="hm-row-action"
          onClick={() => void onArchiveToggle(session)}
          disabled={acting}
          aria-label={`${archiveLabel}: ${sessionTitle(session)}`}
          title={archiveLabel}
        >
          <Icon name="archive" size={15} />
          <span>{session.archived ? 'Restore' : 'Archive'}</span>
        </button>
        <button
          type="button"
          className="hm-row-action hm-row-action--danger"
          onClick={() => void onDelete(session)}
          disabled={acting}
          aria-label={`Delete session: ${sessionTitle(session)}`}
          title="Delete session"
        >
          <Icon name="trash" size={15} />
          <span>Delete</span>
        </button>
      </div>
      )}
    </div>
  );
}

export function Sessions({ rpc, rest, onSessionOpen }: SessionsProps) {
  const {
    sessions: chatSessions,
    loading: chatsLoading,
    error: chatsError,
    load,
    archive: archiveSession,
    delete: deleteSession,
    browseOnly,
    browseOnlyLoading,
    browseOnlyError,
    loadBrowseOnly,
  } = useSessionsStore();
  const activeName = useProfilesStore((s) => s.activeName);
  const [scope, setScope] = useState<Scope>('chats');
  const [filter, setFilter] = useState<Filter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [search, setSearch] = useState('');
  const [actingId, setActingId] = useState<string | undefined>();
  const [reading, setReading] = useState<Session | undefined>(undefined);

  useEffect(() => {
    void load(rest);
  }, [rest, load]);

  useEffect(() => {
    if (scope === 'other') void loadBrowseOnly(rest);
  }, [scope, rest, loadBrowseOnly]);

  const readOnly = scope === 'other';
  const sessions = readOnly ? browseOnly : chatSessions;
  const loading = readOnly ? browseOnlyLoading : chatsLoading;
  const error = readOnly ? browseOnlyError : chatsError;

  async function handleSelect(session: Session) {
    if (readOnly) {
      setReading(session);
      return;
    }
    await useChatStore.getState().resumeSessionIntoChat(rest, rpc, session.id, session.profile ?? activeName);
    onSessionOpen();
  }

  const switchScope = (next: Scope) => {
    setScope(next);
    setSourceFilter('all');
    setFilter('all');
  };

  async function handleArchiveToggle(session: Session) {
    const nextArchived = !session.archived;
    if (nextArchived) {
      const confirmed = window.confirm(`Archive session "${sessionTitle(session)}"? It will move to the Archived filter.`);
      if (!confirmed) return;
    }
    setActingId(session.id);
    try {
      await archiveSession(rest, session, nextArchived);
    } finally {
      setActingId(undefined);
    }
  }

  async function handleDelete(session: Session) {
    const confirmed = window.confirm(`Delete session "${sessionTitle(session)}"? This removes it from the session database.`);
    if (!confirmed) return;
    setActingId(session.id);
    try {
      await deleteSession(rest, session);
    } finally {
      setActingId(undefined);
    }
  }

  const sourceOptions = buildSourceFilterOptions(sessions);

  const filtered = sessions
    .filter((s) => {
      if (filter === 'live') return s.isActive || s.active;
      if (filter === 'done') return !s.isActive && !s.active && !s.archived;
      if (filter === 'archived') return s.archived;
      return true;
    })
    .filter((s) => sourceFilter === 'all' || sessionSourceKey(s) === sourceFilter);

  const searched = search.trim()
    ? filtered.filter((s) => sessionSearchText(s).includes(search.toLowerCase()))
    : filtered;

  // Stats
  const live = sessions.filter((s) => s.isActive || s.active).length;
  const total = sessions.length;
  const totalMsgs = sessions.reduce((n, s) => n + (s.messageCount ?? 0), 0);
  const statsLine = [
    `${total} session${total !== 1 ? 's' : ''}`,
    live > 0 ? `${live} live` : '',
    totalMsgs > 0 ? `${totalMsgs} msgs` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="hm-sessions">
      <div className="hm-sessions__search-row">
        <input
          className="hm-input hm-sessions__search"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search sessions"
        />
      </div>

      <div className="hm-sessions__scope" role="tablist" aria-label="Session kind">
        <button
          type="button"
          role="tab"
          className={`hm-sessions__scope-btn${scope === 'chats' ? ' hm-sessions__scope-btn--active' : ''}`}
          aria-selected={scope === 'chats'}
          onClick={() => switchScope('chats')}
        >
          Phone chats
        </button>
        <button
          type="button"
          role="tab"
          className={`hm-sessions__scope-btn${scope === 'other' ? ' hm-sessions__scope-btn--active' : ''}`}
          aria-selected={scope === 'other'}
          onClick={() => switchScope('other')}
        >
          Signal, scheduled, delegated
        </button>
      </div>
      {readOnly ? (
        <p className="hm-sessions__scope-hint hm-muted">Conversations the gateway runs on its own. Tap one to read it.</p>
      ) : null}

      {readOnly ? null : (
        <div className="hm-sessions__filters" role="tablist" aria-label="Session filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`hm-filter-chip${filter === f.key ? ' hm-filter-chip--active' : ''}`}
              onClick={() => setFilter(f.key)}
              role="tab"
              aria-selected={filter === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {sourceOptions.length > 1 && (
        <div className="hm-sessions__filters hm-sessions__source-filters" role="tablist" aria-label="Session source filters">
          {sourceOptions.map((option) => (
            <button
              key={option.key}
              className={`hm-filter-chip${sourceFilter === option.key ? ' hm-filter-chip--active' : ''}`}
              onClick={() => setSourceFilter(option.key)}
              role="tab"
              aria-selected={sourceFilter === option.key}
            >
              {option.label}
              <span className="hm-filter-chip__count">{option.count}</span>
            </button>
          ))}
        </div>
      )}

      {total > 0 && (
        <p className="hm-sessions__stats">{statsLine}</p>
      )}

      {error && <div className="hm-warning-banner hm-warning-banner--error">{error}</div>}
      {loading && sessions.length === 0 && <p className="hm-muted hm-loading">Loading…</p>}

      {searched.length === 0 && !loading ? (
        <div className="hm-empty-state">
          <p>{search ? 'No matching sessions' : readOnly ? 'Nothing here yet' : 'No sessions yet'}</p>
          <p className="hm-muted">
            {readOnly ? 'Signal conversations, scheduled jobs and delegated bot runs show up here once they happen.' : 'Start a chat to create your first session.'}
          </p>
        </div>
      ) : (
        <div className="hm-sessions__list">
          {searched.map((s) => (
            <SessionRow
              key={`${s.profile ?? ''}/${s.id}`}
              session={s}
              acting={actingId === s.id}
              readOnly={readOnly}
              onSelect={handleSelect}
              onArchiveToggle={handleArchiveToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {reading ? <SessionTranscript session={reading} rpc={rpc} rest={rest} onClose={() => setReading(undefined)} /> : null}
    </div>
  );
}
