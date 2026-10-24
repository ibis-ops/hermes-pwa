/**
 * Delegated agent runs, from the hermes-pwa plugin's `/agents/history` route:
 * every subagent session Hermes ran, which bot ran it, for which chat, and
 * what it answered. Durable, unlike the live spawn events.
 */

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export interface AgentRunParent {
  id: string;
  title: string | undefined;
  source: string | undefined;
  profile: string | undefined;
}

export interface AgentRun {
  id: string;
  /** Hermes profile that did the work. */
  bot: string;
  /** Profile whose chat asked for it. */
  ownerProfile: string;
  goal: string;
  model: string | undefined;
  status: AgentRunStatus;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number | undefined;
  durationSeconds: number | undefined;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | undefined;
  lastActivity: string | undefined;
  parent: AgentRunParent | undefined;
  /** The run's final answer, trimmed by the server. */
  result: string | undefined;
}

export interface AgentHistory {
  runs: AgentRun[];
  days: number | undefined;
  total: number;
  scannedAt: number | undefined;
  error: string | undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
  const seconds = num(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return seconds > 1_000_000_000_000 ? seconds : seconds * 1000;
}

const STATUSES = new Set<AgentRunStatus>(['running', 'completed', 'failed', 'interrupted', 'unknown']);

function toParent(raw: unknown): AgentRunParent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = str(record.id);
  if (!id) return undefined;
  return { id, title: str(record.title), source: str(record.source), profile: str(record.profile) };
}

export function toAgentRun(raw: unknown): AgentRun | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = str(record.id);
  const startedAt = epochMs(record.started_at);
  if (!id || startedAt === undefined) return undefined;
  const status = str(record.status) as AgentRunStatus | undefined;
  return {
    id,
    bot: str(record.bot) ?? 'default',
    ownerProfile: str(record.owner_profile) ?? 'default',
    goal: str(record.goal) ?? 'Delegated task',
    model: str(record.model),
    status: status && STATUSES.has(status) ? status : 'unknown',
    startedAt,
    endedAt: epochMs(record.ended_at),
    durationSeconds: num(record.duration_seconds),
    messageCount: num(record.message_count) ?? 0,
    toolCallCount: num(record.tool_call_count) ?? 0,
    inputTokens: num(record.input_tokens) ?? 0,
    outputTokens: num(record.output_tokens) ?? 0,
    costUsd: num(record.cost_usd),
    lastActivity: str(record.last_activity),
    parent: toParent(record.parent),
    result: str(record.result),
  };
}

export function toAgentHistory(raw: unknown): AgentHistory {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const runs = Array.isArray(record.runs) ? record.runs.map(toAgentRun).filter((run): run is AgentRun => Boolean(run)) : [];
  return {
    runs,
    days: num(record.days),
    total: num(record.total) ?? runs.length,
    scannedAt: epochMs(record.scanned_at),
    error: str(record.error),
  };
}

export interface AgentRunDayGroup {
  /** Local midnight, epoch ms. */
  day: number;
  runs: AgentRun[];
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Newest day first; runs inside a day newest first. */
export function groupRunsByDay(runs: AgentRun[]): AgentRunDayGroup[] {
  const groups = new Map<number, AgentRun[]>();
  for (const run of [...runs].sort((a, b) => b.startedAt - a.startedAt)) {
    const day = startOfLocalDay(run.startedAt);
    const bucket = groups.get(day);
    if (bucket) bucket.push(run);
    else groups.set(day, [run]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([day, dayRuns]) => ({ day, runs: dayRuns }));
}
