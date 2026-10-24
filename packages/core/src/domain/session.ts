/**
 * Session / chat domain types and small UI helpers shared by stores/components.
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  createdAt: number | undefined;
  /** Epoch seconds when an assistant reply finished (its last row, or message.complete). */
  completedAt?: number;
  /** Display-only typing from Hermes, e.g. 'skill_invocation' for a /skill turn shown as typed. */
  displayKind?: string;
}

export interface Session {
  /** Durable stored session id from Hermes state.db/session APIs. */
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number | undefined;
  profile: string | undefined;

  /** PWA release-scope row source: local CLI/TUI/Desktop-style sessions only. */
  source?: string | undefined;
  /** User-facing logical source for the conversation lineage. */
  originSource?: string | undefined;
  /** Technical source for the current openable head/tip row. */
  currentSource?: string | undefined;
  cwd?: string | undefined;
  archived?: boolean | undefined;
  isActive?: boolean | undefined;
  active?: boolean | undefined;
  lineageRootId?: string | undefined;
  startedAt?: number | undefined;
  lastActive?: number | undefined;
}

const SOURCE_LABELS: Record<string, string> = {
  cli: 'CLI',
  codex: 'Codex',
  desktop: 'Desktop',
  gateway: 'Gateway',
  local: 'Local',
  tui: 'TUI',
};

const SOURCE_ALIASES: Record<string, string[]> = {
  cli: ['terminal'],
  desktop: ['app', 'gui'],
  local: ['machine'],
  tui: ['terminal'],
};

export const PWA_LOCAL_SESSION_SOURCE_IDS = ['cli', 'codex', 'desktop', 'gateway', 'local', 'tui'] as const;

// Backend currently supports exclude_sources but not include_sources. Keep this
// list isolated at the transport boundary; do not model these sources in PWA UI.
export const PWA_NON_LOCAL_SESSION_SOURCES = [
  'cron',
  'curator',
  'telegram',
  'discord',
  'slack',
  'mattermost',
  'matrix',
  'signal',
  'whatsapp',
  'bluebubbles',
  'homeassistant',
  'email',
  'sms',
  'webhook',
  'api_server',
  'weixin',
  'wecom',
  'qqbot',
  'yuanbao',
  'dingtalk',
  'feishu',
] as const;

export function normalizeSessionSource(source: null | string | undefined): string | null {
  const id = source?.trim().toLowerCase();
  return id || null;
}

export function sessionOriginSourceId(session: Pick<Session, 'source' | 'originSource'>): string | null {
  return normalizeSessionSource(session.originSource ?? session.source);
}

export function sessionCurrentSourceId(session: Pick<Session, 'source' | 'currentSource'>): string | null {
  return normalizeSessionSource(session.currentSource ?? session.source);
}

export function sessionSourceId(session: Pick<Session, 'source' | 'originSource'>): string | null {
  return sessionOriginSourceId(session);
}

export function sessionHasDifferentCurrentSource(
  session: Pick<Session, 'source' | 'originSource' | 'currentSource'>,
): boolean {
  const origin = sessionOriginSourceId(session);
  const current = sessionCurrentSourceId(session);
  return Boolean(origin && current && origin !== current);
}

export function sessionSourceLabel(source: null | string | undefined): string | null {
  const id = normalizeSessionSource(source);
  if (!id) return null;
  return SOURCE_LABELS[id] || id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function sessionSourceSearchTerms(source: null | string | undefined): string[] {
  const id = normalizeSessionSource(source);
  if (!id) return [];
  const label = sessionSourceLabel(id);
  return [id, label ?? '', ...(SOURCE_ALIASES[id] ?? [])].filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function toSession(raw: Record<string, unknown>): Session {
  const source = optionalString(raw.source);
  const originSource = optionalString(raw.origin_source ?? raw.originSource) ?? source;
  const currentSource = optionalString(raw.current_source ?? raw.currentSource) ?? source;

  return {
    id: String(raw.id ?? raw.session_id ?? 'unknown'),
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled',
    updatedAt: Number(raw.updated_at ?? raw.updatedAt ?? raw.last_active ?? raw.started_at ?? 0),
    messageCount: optionalNumber(raw.message_count ?? raw.messageCount),
    profile: optionalString(raw.profile),
    source,
    originSource,
    currentSource,
    cwd: optionalString(raw.cwd),
    archived: optionalBoolean(raw.archived),
    isActive: optionalBoolean(raw.is_active ?? raw.isActive),
    active: optionalBoolean(raw.active),
    lineageRootId: optionalString(raw._lineage_root_id ?? raw.lineageRootId),
    startedAt: optionalNumber(raw.started_at ?? raw.startedAt),
    lastActive: optionalNumber(raw.last_active ?? raw.lastActive),
  };
}

export function sessionsFromResult(raw: unknown): Session[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === 'object') {
    const candidate = (raw as Record<string, unknown>).sessions;
    if (Array.isArray(candidate)) items = candidate;
  }
  return items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map(toSession);
}

/** Stable logical-conversation key; lineage root survives auto-compression. */
export function sessionLineageKey(session: Pick<Session, 'id' | 'lineageRootId'>): string {
  return session.lineageRootId ?? session.id;
}

/** Durable id for local pins; lineage root survives auto-compression. */
export function sessionPinId(session: Pick<Session, 'id' | 'lineageRootId'>): string {
  return sessionLineageKey(session);
}

function sessionFreshness(session: Session): number {
  return Math.max(session.lastActive ?? 0, session.updatedAt ?? 0, session.startedAt ?? 0);
}

function preferSessionRow(current: Session | undefined, incoming: Session): Session {
  if (!current) return incoming;
  const mergeMetadata = (preferred: Session, other: Session): Session => ({
    ...preferred,
    lineageRootId: preferred.lineageRootId ?? other.lineageRootId,
    source: preferred.source ?? other.source,
    originSource: preferred.originSource ?? other.originSource ?? preferred.source ?? other.source,
    currentSource: preferred.currentSource ?? preferred.source ?? other.currentSource ?? other.source,
    isActive: preferred.isActive || other.isActive || undefined,
    active: preferred.active || other.active || undefined,
  });
  const currentFreshness = sessionFreshness(current);
  const incomingFreshness = sessionFreshness(incoming);
  if (incomingFreshness > currentFreshness) {
    return mergeMetadata(incoming, current);
  }
  if (incomingFreshness < currentFreshness) {
    return mergeMetadata(current, incoming);
  }
  const currentCount = current.messageCount ?? 0;
  const incomingCount = incoming.messageCount ?? 0;
  if (incomingCount > currentCount) {
    return mergeMetadata(incoming, current);
  }
  return mergeMetadata(current, incoming);
}

/**
 * Desktop-compatible session list merge: one logical compressed conversation
 * owns one visible row, keyed by `_lineage_root_id ?? id`; the row's `id`
 * remains the current openable tip/head.
 */
export function mergeSessionsByLineage(existing: Session[], incoming: Session[]): Session[] {
  const byKey = new Map<string, Session>();
  const order: string[] = [];
  for (const session of [...existing, ...incoming]) {
    const key = sessionLineageKey(session);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, preferSessionRow(byKey.get(key), session));
  }
  return order
    .map((key) => byKey.get(key))
    .filter((session): session is Session => Boolean(session))
    .sort((a, b) => sessionFreshness(b) - sessionFreshness(a));
}

export function findSessionByAlias(sessions: Session[], sessionId: string | undefined): Session | undefined {
  if (!sessionId) return undefined;
  return sessions.find((session) => session.id === sessionId || session.lineageRootId === sessionId);
}
