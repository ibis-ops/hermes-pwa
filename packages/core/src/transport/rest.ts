import type { Http } from './http';
import {
  PWA_BROWSE_ONLY_SESSION_SOURCES,
  PWA_NON_LOCAL_SESSION_SOURCES,
  mergeBrowseOnlySessions,
  mergeSessionsByLineage,
  sessionsFromResult,
  type Session,
} from '../domain/session';
import type { GatewayStatus } from '../domain/status';
import type { AuthProvider, HermesUser, LoginBody, LoginResult, WsTicket } from '../domain/auth';
import type { Artifact } from '../domain/artifact';
import { toArtifact } from '../domain/artifact';
import type { Board, BoardDetail, Task, TaskDetail, TaskStatus } from '../domain/project';
import { toBoard, toBoardDetail, toTask, toTaskDetail } from '../domain/project';
import type { Profile, ProfileActive, ProfileCreateBody, ProfileCreateResult, ReasoningEffort } from '../domain/profile';
import { toProfile, toProfileActive, toProfileCreateResult } from '../domain/profile';
import type { CronDeliveryTarget, CronJob, CronJobRun } from '../domain/cron';
import { toCronDeliveryTarget, toCronJob, toCronJobRun } from '../domain/cron';
import type { McpServer } from '../domain/mcp';
import { toMcpServer } from '../domain/mcp';
import type { EnvVar } from '../domain/env';
import { toEnvVar } from '../domain/env';
import type { MessagingOverview } from '../domain/messaging';
import { toMessagingOverview } from '../domain/messaging';
import { toObsidianActivity, toObsidianNoteContent, type ObsidianActivity, type ObsidianNoteContent } from '../domain/obsidian';
import { toAgentHistory, type AgentHistory } from '../domain/agent-history';
import type {
  AuxiliaryModels,
  ModelAssignment,
  ModelAssignmentResult,
  ModelInfo,
  ModelOptions,
} from '../domain/model';
import {
  toAuxiliaryModels,
  toModelAssignmentResult,
  toModelInfo,
  toModelOptions,
} from '../domain/model';
import type { Skill } from '../domain/skills';
import { toSkill } from '../domain/skills';
import type { HermesConfig } from '../domain/config';
import { toHermesConfig } from '../domain/config';
import type { UpdateCheck } from '../domain/update';
import { toUpdateCheck } from '../domain/update';
import type { Checkpoint, OpsRunResult, SystemActionStatus, SystemStats } from '../domain/system';
import { toActionStatus, toCheckpoint, toOpsRunResult, toSystemStats } from '../domain/system';
import type { ActionItem } from '../domain/activity';
import { toActionItem } from '../domain/activity';

const AUDIO_HTTP_TIMEOUT_MS = 2 * 60_000;

interface RawStatus {
  auth_required?: boolean;
  auth_providers?: string[];
  gateway_state?: string;
  version?: string;
  release_date?: string;
  gateway_running?: boolean;
  active_sessions?: number;
}

interface RawProviders {
  providers?: Array<{
    name?: string;
    display_name?: string;
    supports_password?: boolean;
  }>;
}

interface RawUser {
  user_id?: string;
  email?: string;
  display_name?: string;
  org_id?: string;
  provider?: string;
  expires_at?: number;
}

interface RawTicket {
  ticket?: string;
  ttl_seconds?: number;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function profileSessionsPath(profile: string, excludeSources: readonly string[]): string {
  const params = new URLSearchParams({
    limit: '100',
    offset: '0',
    min_messages: '1',
    archived: 'exclude',
    order: 'recent',
    profile,
    exclude_sources: excludeSources.join(','),
  });
  return `/api/profiles/sessions?${params.toString()}`;
}


function toStatus(raw: RawStatus): GatewayStatus {
  const status: GatewayStatus = {
    authRequired: raw.auth_required === true,
    authProviders: Array.isArray(raw.auth_providers) ? raw.auth_providers : [],
  };
  if (raw.gateway_state !== undefined) status.gatewayState = raw.gateway_state;
  if (raw.version !== undefined) status.version = raw.version;
  if (raw.release_date !== undefined) status.releaseDate = raw.release_date;
  if (raw.gateway_running !== undefined) status.gatewayRunning = raw.gateway_running;
  if (raw.active_sessions !== undefined) status.activeSessions = raw.active_sessions;
  return status;
}

function toProviders(raw: RawProviders): AuthProvider[] {
  if (!Array.isArray(raw.providers)) return [];
  return raw.providers.map((p) => ({
    name: String(p.name ?? 'unknown'),
    displayName: String(p.display_name ?? p.name ?? 'Unknown'),
    supportsPassword: p.supports_password === true,
  }));
}

function toUser(raw: RawUser): HermesUser {
  const user: HermesUser = {
    userId: raw.user_id ?? 'unknown',
    displayName: raw.display_name ?? raw.email ?? 'Hermes user',
    provider: raw.provider ?? 'unknown',
    expiresAt: typeof raw.expires_at === 'number' ? raw.expires_at : 0,
  };
  if (raw.email !== undefined) user.email = raw.email;
  if (raw.org_id !== undefined) user.orgId = raw.org_id;
  return user;
}

function toTicket(raw: RawTicket): WsTicket {
  return {
    ticket: String(raw.ticket ?? ''),
    ttlSeconds: typeof raw.ttl_seconds === 'number' ? raw.ttl_seconds : 30,
  };
}

export type ProfileModelSettingsUpdate = {
  provider: string;
  model: string;
  reasoning_effort?: ReasoningEffort;
  show_reasoning?: boolean;
};

export interface PushSubscriptionSafe {
  id: string;
  profile?: string;
  label?: string;
  userAgentHint?: string;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastSuccessAt?: number | null;
  lastError?: string | null;
}

export interface PushStatus {
  available: boolean;
  enabled: boolean;
  reason?: string;
  vapidPublicKey?: string;
  subscriptions: PushSubscriptionSafe[];
}

export interface PushSubscribeBody {
  subscription: unknown;
  label?: string;
}

function toPushSubscription(raw: Record<string, unknown>): PushSubscriptionSafe {
  const sub: PushSubscriptionSafe = {
    id: String(raw.id ?? ''),
    enabled: raw.enabled !== false,
  };
  if (raw.profile !== undefined) sub.profile = String(raw.profile);
  if (raw.label !== undefined) sub.label = String(raw.label);
  if (raw.user_agent_hint !== undefined) sub.userAgentHint = String(raw.user_agent_hint);
  if (typeof raw.created_at === 'number') sub.createdAt = raw.created_at;
  if (typeof raw.updated_at === 'number') sub.updatedAt = raw.updated_at;
  if (typeof raw.last_success_at === 'number' || raw.last_success_at === null) sub.lastSuccessAt = raw.last_success_at;
  if (typeof raw.last_error === 'string' || raw.last_error === null) sub.lastError = raw.last_error;
  return sub;
}

function toPushStatus(raw: Record<string, unknown>): PushStatus {
  const status: PushStatus = {
    available: raw.available === true,
    enabled: raw.enabled === true,
    subscriptions: asArray<Record<string, unknown>>(raw.subscriptions).map(toPushSubscription),
  };
  if (typeof raw.reason === 'string') status.reason = raw.reason;
  if (typeof raw.vapid_public_key === 'string') status.vapidPublicKey = raw.vapid_public_key;
  return status;
}

export interface LocalFileInfo {
  name: string;
  size: number | undefined;
  mime: string | undefined;
  inline: boolean;
  image: boolean;
}

export interface RestClient {
  status(): Promise<GatewayStatus>;
  providers(): Promise<AuthProvider[]>;
  passwordLogin(body: LoginBody): Promise<LoginResult>;
  me(): Promise<HermesUser>;
  wsTicket(): Promise<WsTicket>;
  logout(): Promise<void>;
  setActiveProfile(name: string | undefined): void;

  kanbanBoards(): Promise<Board[]>;
  kanbanCreateBoard(body: { slug: string; name?: string; switch?: boolean }): Promise<Board>;
  kanbanDeleteBoard(slug: string): Promise<unknown>;
  kanbanSwitchBoard(slug: string): Promise<unknown>;
  kanbanBoard(slug: string): Promise<BoardDetail>;
  kanbanCreateTask(
    board: string,
    body: {
      title: string;
      body?: string;
      assignee?: string;
      tenant?: string;
      priority?: number;
      workspace_kind?: 'scratch' | 'dir';
      workspace_path?: string;
      parents?: string[];
      triage?: boolean;
      max_runtime_seconds?: number;
      skills?: string[];
      goal_mode?: boolean;
      goal_max_turns?: number;
    },
  ): Promise<Task>;
  kanbanUpdateTask(
    board: string,
    taskId: string,
    patch: {
      status?: TaskStatus;
      assignee?: string;
      priority?: number;
      title?: string;
      body?: string;
    },
  ): Promise<Task>;
  kanbanTaskDetail(board: string, taskId: string): Promise<TaskDetail>;
  kanbanComment(taskId: string, body: { body: string; author: string }): Promise<unknown>;

  profileList(): Promise<Profile[]>;
  profileActive(): Promise<ProfileActive>;
  profileActivate(name: string): Promise<void>;
  profileCreate(body: ProfileCreateBody): Promise<ProfileCreateResult>;
  profileRename(name: string, newName: string): Promise<void>;
  profileDelete(name: string): Promise<void>;
  profileUpdateModel(name: string, body: ProfileModelSettingsUpdate): Promise<ModelAssignmentResult>;

  systemStats(): Promise<SystemStats>;
  opsRun(op: 'doctor' | 'security-audit' | 'backup'): Promise<OpsRunResult>;
  opsCheckpoints(): Promise<Checkpoint[]>;
  opsBackups(): Promise<Checkpoint[]>;
  gatewayAction(action: 'start' | 'restart' | 'stop'): Promise<OpsRunResult>;
  actionStatus(name: string, lines?: number): Promise<SystemActionStatus>;
  pendingActions(profile?: string): Promise<ActionItem[]>;

  pushStatus(profile?: string): Promise<PushStatus>;
  pushSubscribe(body: PushSubscribeBody, profile?: string): Promise<PushSubscriptionSafe>;
  pushUnsubscribe(body: { id?: string; endpoint?: string }, profile?: string): Promise<{ ok: boolean }>;
  pushTest(id: string, profile?: string): Promise<{ ok: boolean }>;
  updateCheck(): Promise<UpdateCheck>;

  cronJobs(profile?: string): Promise<CronJob[]>;
  cronJobDetail(jobId: string, profile?: string): Promise<CronJob>;
  cronJobRuns(jobId: string, profile?: string, limit?: number): Promise<{ runs: CronJobRun[]; limit: number }>;
  cronCreateJob(
    body: { prompt: string; schedule: string; name?: string | undefined; deliver?: string | undefined },
    profile?: string,
  ): Promise<CronJob>;
  cronUpdateJob(
    jobId: string,
    updates: { prompt?: string | undefined; schedule?: string | undefined; name?: string | undefined; deliver?: string | undefined },
    profile?: string,
  ): Promise<CronJob>;
  cronPauseJob(jobId: string, profile?: string): Promise<CronJob>;
  cronResumeJob(jobId: string, profile?: string): Promise<CronJob>;
  cronTriggerJob(jobId: string, profile?: string): Promise<CronJob>;
  cronDeleteJob(jobId: string, profile?: string): Promise<{ ok: boolean }>;
  cronDeliveryTargets(): Promise<CronDeliveryTarget[]>;

  profileSessions(): Promise<Session[]>;
  sessionMessages(sessionId: string, profile?: string): Promise<unknown>;
  /** Signal, scheduled and delegated sessions across profiles, for read-only browsing. */
  browseOnlySessions(): Promise<Session[]>;
  sessionArtifacts(sessionId: string): Promise<Artifact[]>;
  sessionUpdate(sessionId: string, updates: { title?: string | null; archived?: boolean; profile?: string }): Promise<unknown>;
  sessionDelete(sessionId: string, profile?: string): Promise<unknown>;
  sessionBulkDelete(ids: string[]): Promise<unknown>;

  envList(): Promise<EnvVar[]>;
  config(): Promise<HermesConfig>;
  setConfig(config: HermesConfig): Promise<{ ok: boolean }>;
  mcpServers(): Promise<McpServer[]>;
  mcpToggle(name: string, enabled: boolean): Promise<void>;
  skillsList(): Promise<Skill[]>;

  modelOptions(): Promise<ModelOptions>;
  modelInfo(): Promise<ModelInfo>;
  modelAuxiliary(): Promise<AuxiliaryModels>;
  modelSet(body: ModelAssignment): Promise<ModelAssignmentResult>;

  audioTranscribe(dataUrl: string, mimeType?: string): Promise<string>;
  audioSpeak(text: string): Promise<{ dataUrl: string; mimeType?: string | undefined; provider?: string | undefined }>;
  fileUpload(path: string, dataUrl: string, overwrite?: boolean): Promise<unknown>;
  /** Name, size and type of a file on the Hermes host, via the plugin's allowlisted file route. */
  localFileInfo(path: string): Promise<LocalFileInfo>;
  /** The chat services the gateway can run a bot on, with connection state only (no secrets). */
  messagingPlatforms(): Promise<MessagingOverview>;
  /** Obsidian notes the agent created or edited on the Mac, newest first. */
  obsidianActivity(days?: number): Promise<ObsidianActivity>;
  /** One note's text, read from the vault on the Mac. */
  obsidianNote(vault: string, path: string): Promise<ObsidianNoteContent>;
  /** Every delegated agent run across profiles, newest first. */
  agentHistory(days?: number): Promise<AgentHistory>;
}

/** How far back the browse-only Sessions list reaches for delegated runs. */
const BROWSE_ONLY_DELEGATED_DAYS = 30;

export function makeRestClient(http: Http): RestClient {
  let activeProfile: string | undefined;

  async function agentHistoryRequest(days: number): Promise<AgentHistory> {
    return toAgentHistory(await http<unknown>(`/api/plugins/hermes-pwa/agents/history?days=${encodeURIComponent(String(days))}`));
  }

  return {
    async status(): Promise<GatewayStatus> {
      return toStatus(await http<RawStatus>('/api/status'));
    },

    async providers(): Promise<AuthProvider[]> {
      return toProviders(await http<RawProviders>('/api/auth/providers'));
    },

    async passwordLogin(body: LoginBody): Promise<LoginResult> {
      return await http<LoginResult>('/auth/password-login', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async me(): Promise<HermesUser> {
      return toUser(await http<RawUser>('/api/auth/me'));
    },

    async wsTicket(): Promise<WsTicket> {
      return toTicket(await http<RawTicket>('/api/auth/ws-ticket', { method: 'POST' }));
    },

    async logout(): Promise<void> {
      await http<unknown>('/auth/logout', { method: 'POST' });
    },

    setActiveProfile(name: string | undefined): void {
      activeProfile = name;
      http.setProfile(name);
    },

    async kanbanBoards(): Promise<Board[]> {
      const raw = await http<Record<string, unknown>>('/api/plugins/kanban/boards');
      return asArray<Record<string, unknown>>(raw.boards ?? raw).map(toBoard);
    },

    async kanbanCreateBoard(body: { slug: string; name?: string; switch?: boolean }): Promise<Board> {
      const raw = await http<Record<string, unknown>>('/api/plugins/kanban/boards', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return toBoard((raw.board ?? raw) as Record<string, unknown>);
    },

    async kanbanDeleteBoard(slug: string): Promise<unknown> {
      return await http<unknown>(`/api/plugins/kanban/boards/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      });
    },

    async kanbanSwitchBoard(slug: string): Promise<unknown> {
      return await http<unknown>(`/api/plugins/kanban/boards/${encodeURIComponent(slug)}/switch`, {
        method: 'POST',
      });
    },

    async kanbanBoard(slug: string): Promise<BoardDetail> {
      const raw = await http<Record<string, unknown>>(
        `/api/plugins/kanban/board?board=${encodeURIComponent(slug)}`,
      );
      return toBoardDetail(raw);
    },

    async kanbanCreateTask(board: string, body: Parameters<RestClient['kanbanCreateTask']>[1]): Promise<Task> {
      const raw = await http<Record<string, unknown>>(
        `/api/plugins/kanban/tasks?board=${encodeURIComponent(board)}`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      return toTask((raw.task ?? raw) as Record<string, unknown>);
    },

    async kanbanUpdateTask(
      board: string,
      taskId: string,
      patch: { status?: TaskStatus; assignee?: string; priority?: number; title?: string; body?: string },
    ): Promise<Task> {
      const raw = await http<Record<string, unknown>>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}?board=${encodeURIComponent(board)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
      );
      return toTask((raw.task ?? raw) as Record<string, unknown>);
    },

    async kanbanTaskDetail(board: string, taskId: string): Promise<TaskDetail> {
      const raw = await http<Record<string, unknown>>(
        `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}?board=${encodeURIComponent(board)}`,
      );
      return toTaskDetail(raw);
    },

    async kanbanComment(taskId: string, body: { body: string; author: string }): Promise<unknown> {
      return await http<unknown>(`/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async profileList(): Promise<Profile[]> {
      const raw = await http<Record<string, unknown>>('/api/profiles');
      return asArray<Record<string, unknown>>(raw.profiles ?? raw).map((r) => toProfile(r, ''));
    },

    async profileActive(): Promise<ProfileActive> {
      const raw = await http<Record<string, unknown>>('/api/profiles/active');
      return toProfileActive(raw);
    },

    async profileActivate(name: string): Promise<void> {
      await http<unknown>('/api/profiles/active', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    },

    async profileCreate(body: ProfileCreateBody): Promise<ProfileCreateResult> {
      const raw = await http<Record<string, unknown>>('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return toProfileCreateResult(raw);
    },

    async profileRename(name: string, newName: string): Promise<void> {
      await http<unknown>(`/api/profiles/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ new_name: newName }),
      });
    },

    async profileDelete(name: string): Promise<void> {
      await http<unknown>(`/api/profiles/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    },

    async profileUpdateModel(name: string, body: ProfileModelSettingsUpdate): Promise<ModelAssignmentResult> {
      return toModelAssignmentResult(
        await http<Record<string, unknown>>(`/api/profiles/${encodeURIComponent(name)}/model`, {
          method: 'PUT',
          body: JSON.stringify(body),
          skipProfile: true,
        }),
      );
    },

    async systemStats(): Promise<SystemStats> {
      const raw = await http<Record<string, unknown>>('/api/system/stats');
      return toSystemStats(raw);
    },

    async opsRun(op): Promise<OpsRunResult> {
      return toOpsRunResult(await http<Record<string, unknown>>(`/api/ops/${op}`, {
        method: 'POST',
        ...(op === 'backup' ? { body: JSON.stringify({}) } : {}),
      }));
    },

    async opsCheckpoints(): Promise<Checkpoint[]> {
      const raw = await http<Record<string, unknown>>('/api/ops/checkpoints');
      return asArray<Record<string, unknown>>(raw.sessions ?? raw).map(toCheckpoint);
    },

    async opsBackups(): Promise<Checkpoint[]> {
      const raw = await http<Record<string, unknown>>('/api/plugins/hermes-pwa/backups');
      return asArray<Record<string, unknown>>(raw.backups ?? raw).map(toCheckpoint);
    },

    async gatewayAction(action): Promise<OpsRunResult> {
      return toOpsRunResult(await http<Record<string, unknown>>(`/api/gateway/${action}`, { method: 'POST' }));
    },

    async actionStatus(name: string, lines = 400): Promise<SystemActionStatus> {
      const raw = await http<Record<string, unknown>>(
        `/api/actions/${encodeURIComponent(name)}/status?lines=${encodeURIComponent(String(lines))}`,
      );
      return toActionStatus(raw);
    },

    async pendingActions(profile = activeProfile ?? 'default'): Promise<ActionItem[]> {
      const raw = await http<Record<string, unknown>>(
        `/api/plugins/hermes-pwa/actions/pending?profile=${encodeURIComponent(profile)}`,
      );
      return asArray<Record<string, unknown>>(raw.items ?? raw).map(toActionItem);
    },

    async pushStatus(profile = activeProfile ?? 'default'): Promise<PushStatus> {
      return toPushStatus(
        await http<Record<string, unknown>>(
          `/api/plugins/hermes-pwa/push/status?profile=${encodeURIComponent(profile)}`,
        ),
      );
    },

    async pushSubscribe(body: PushSubscribeBody, profile = activeProfile ?? 'default'): Promise<PushSubscriptionSafe> {
      const raw = await http<Record<string, unknown>>(
        `/api/plugins/hermes-pwa/push/subscribe?profile=${encodeURIComponent(profile)}`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      return toPushSubscription((raw.subscription ?? raw) as Record<string, unknown>);
    },

    async pushUnsubscribe(body: { id?: string; endpoint?: string }, profile = activeProfile ?? 'default'): Promise<{ ok: boolean }> {
      return await http<{ ok: boolean }>(`/api/plugins/hermes-pwa/push/unsubscribe?profile=${encodeURIComponent(profile)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async pushTest(id: string, profile = activeProfile ?? 'default'): Promise<{ ok: boolean }> {
      return await http<{ ok: boolean }>(`/api/plugins/hermes-pwa/push/test?profile=${encodeURIComponent(profile)}`, {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
    },

    async updateCheck(): Promise<UpdateCheck> {
      return toUpdateCheck(await http<Record<string, unknown>>('/api/plugins/hermes-pwa/update/check'));
    },

    async cronJobs(profile = 'all'): Promise<CronJob[]> {
      const raw = await http<Record<string, unknown>[]>(
        `/api/cron/jobs?profile=${encodeURIComponent(profile)}`,
      );
      return asArray<Record<string, unknown>>(raw).map(toCronJob);
    },

    async cronJobDetail(jobId: string, profile?: string): Promise<CronJob> {
      const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      const raw = await http<Record<string, unknown>>(`/api/cron/jobs/${encodeURIComponent(jobId)}${qs}`);
      return toCronJob(raw);
    },

    async cronJobRuns(
      jobId: string,
      profile?: string,
      limit = 20,
    ): Promise<{ runs: CronJobRun[]; limit: number }> {
      const params = new URLSearchParams({ limit: String(limit) });
      if (profile) params.set('profile', profile);
      const raw = await http<Record<string, unknown>>(
        `/api/cron/jobs/${encodeURIComponent(jobId)}/runs?${params.toString()}`,
      );
      return {
        runs: asArray<Record<string, unknown>>(raw.runs).map(toCronJobRun),
        limit: typeof raw.limit === 'number' ? raw.limit : limit,
      };
    },

    async cronCreateJob(
      body: { prompt: string; schedule: string; name?: string; deliver?: string },
      profile = 'default',
    ): Promise<CronJob> {
      const raw = await http<Record<string, unknown>>(
        `/api/cron/jobs?profile=${encodeURIComponent(profile)}`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      return toCronJob(raw);
    },

    async cronUpdateJob(
      jobId: string,
      updates: { prompt?: string; schedule?: string; name?: string; deliver?: string },
      profile?: string,
    ): Promise<CronJob> {
      const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      const raw = await http<Record<string, unknown>>(
        `/api/cron/jobs/${encodeURIComponent(jobId)}${qs}`,
        {
          method: 'PUT',
          body: JSON.stringify({ updates }),
        },
      );
      return toCronJob(raw);
    },

    async cronPauseJob(jobId: string, profile?: string): Promise<CronJob> {
      const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      const raw = await http<Record<string, unknown>>(
        `/api/cron/jobs/${encodeURIComponent(jobId)}/pause${qs}`,
        { method: 'POST' },
      );
      return toCronJob(raw);
    },

    async cronResumeJob(jobId: string, profile?: string): Promise<CronJob> {
      const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      const raw = await http<Record<string, unknown>>(
        `/api/cron/jobs/${encodeURIComponent(jobId)}/resume${qs}`,
        { method: 'POST' },
      );
      return toCronJob(raw);
    },

    async cronTriggerJob(jobId: string, profile?: string): Promise<CronJob> {
      const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      const raw = await http<Record<string, unknown>>(
        `/api/cron/jobs/${encodeURIComponent(jobId)}/trigger${qs}`,
        { method: 'POST' },
      );
      return toCronJob(raw);
    },

    async cronDeleteJob(jobId: string, profile?: string): Promise<{ ok: boolean }> {
      const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      return await http<{ ok: boolean }>(
        `/api/cron/jobs/${encodeURIComponent(jobId)}${qs}`,
        { method: 'DELETE' },
      );
    },

    async cronDeliveryTargets(): Promise<CronDeliveryTarget[]> {
      const raw = await http<Record<string, unknown>>('/api/cron/delivery-targets');
      return asArray<Record<string, unknown>>(raw.targets).map(toCronDeliveryTarget);
    },

    async browseOnlySessions(): Promise<Session[]> {
      // Signal and scheduled sessions come from every profile's store. Delegated
      // runs never do: Hermes hides sub-agent sessions from any source-scoped
      // listing, so those come from the plugin's own agent history, which reads
      // them straight from each profile's database. The history is optional;
      // the listing is not.
      const params = new URLSearchParams({
        limit: '100',
        offset: '0',
        min_messages: '1',
        archived: 'exclude',
        order: 'recent',
        profile: 'all',
        sources: PWA_BROWSE_ONLY_SESSION_SOURCES.filter((source) => source !== 'subagent').join(','),
      });
      const [listed, history] = await Promise.allSettled([
        http<Record<string, unknown>>(`/api/profiles/sessions?${params.toString()}`),
        agentHistoryRequest(BROWSE_ONLY_DELEGATED_DAYS),
      ]);
      if (listed.status === 'rejected') throw listed.reason;
      return mergeBrowseOnlySessions(
        sessionsFromResult(listed.value),
        history.status === 'fulfilled' ? history.value.runs : [],
      );
    },

    async profileSessions(): Promise<Session[]> {
      // Current release-scope PWA shows local TUI/CLI/Desktop-style sessions only.
      // Messaging sources stay out of ordinary PWA session UX until a later product decision.
      const profile = activeProfile || 'default';
      const localRaw = await http<Record<string, unknown>>(profileSessionsPath(profile, PWA_NON_LOCAL_SESSION_SOURCES));
      return mergeSessionsByLineage([], sessionsFromResult(localRaw));
    },

    async sessionMessages(sessionId, profile): Promise<unknown> {
      // Hermes folds old turns away when it compacts a long session and leaves
      // them out of the default page; the phone wants the whole transcript
      // (latest 500 rows), so ask for the folded turns too.
      const params = new URLSearchParams({ include_compacted: 'true' });
      if (profile) params.set('profile', profile);
      return await http<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`);
    },

    async sessionArtifacts(sessionId): Promise<Artifact[]> {
      const raw = await http<Record<string, unknown>[]>(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`);
      return asArray<Record<string, unknown>>(raw).map(toArtifact);
    },

    async sessionUpdate(sessionId, updates): Promise<unknown> {
      return await http<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    },

    async sessionDelete(sessionId, profile): Promise<unknown> {
      const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
      return await http<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}${qs}`, {
        method: 'DELETE',
      });
    },

    async sessionBulkDelete(ids): Promise<unknown> {
      return await http<unknown>('/api/sessions/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
    },

    async envList(): Promise<EnvVar[]> {
      const raw = await http<Record<string, unknown>[]>('/api/env');
      return asArray<Record<string, unknown>>(raw).map(toEnvVar);
    },

    async config(): Promise<HermesConfig> {
      return toHermesConfig(await http<Record<string, unknown>>('/api/config'));
    },

    async setConfig(config: HermesConfig): Promise<{ ok: boolean }> {
      return await http<{ ok: boolean }>('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ config }),
      });
    },

    async mcpServers(): Promise<McpServer[]> {
      const raw = await http<Record<string, unknown>[]>('/api/mcp/servers');
      return asArray<Record<string, unknown>>(raw).map(toMcpServer);
    },

    async mcpToggle(name, enabled): Promise<void> {
      await http<unknown>(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
    },

    async skillsList(): Promise<Skill[]> {
      const raw = await http<Record<string, unknown>[]>('/api/skills');
      return asArray<Record<string, unknown>>(raw).map(toSkill);
    },

    async modelOptions(): Promise<ModelOptions> {
      return toModelOptions(await http<Record<string, unknown>>('/api/model/options'));
    },

    async modelInfo(): Promise<ModelInfo> {
      return toModelInfo(await http<Record<string, unknown>>('/api/model/info'));
    },

    async modelAuxiliary(): Promise<AuxiliaryModels> {
      return toAuxiliaryModels(await http<Record<string, unknown>>('/api/model/auxiliary'));
    },

    async modelSet(body: ModelAssignment): Promise<ModelAssignmentResult> {
      return toModelAssignmentResult(
        await http<Record<string, unknown>>('/api/model/set', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    },

    async audioTranscribe(dataUrl: string, mimeType?: string): Promise<string> {
      const raw = await http<Record<string, unknown> | string>('/api/audio/transcribe', {
        method: 'POST',
        body: JSON.stringify({ data_url: dataUrl, mime_type: mimeType ?? null }),
        timeoutMs: AUDIO_HTTP_TIMEOUT_MS,
      });
      if (typeof raw === 'string') return raw.trim();
      const text =
        typeof raw.text === 'string'
          ? raw.text
          : typeof raw.transcript === 'string'
            ? raw.transcript
            : typeof raw.result === 'string'
              ? raw.result
              : '';
      return text.trim();
    },

    async audioSpeak(text: string): Promise<{ dataUrl: string; mimeType?: string | undefined; provider?: string | undefined }> {
      const raw = await http<Record<string, unknown>>('/api/audio/speak', {
        method: 'POST',
        body: JSON.stringify({ text }),
        timeoutMs: AUDIO_HTTP_TIMEOUT_MS,
      });
      const dataUrl = typeof raw.data_url === 'string' ? raw.data_url : '';
      if (!dataUrl) throw new Error('Speech response did not include audio.');
      return {
        dataUrl,
        mimeType: typeof raw.mime_type === 'string' ? raw.mime_type : undefined,
        provider: typeof raw.provider === 'string' ? raw.provider : undefined,
      };
    },

    async fileUpload(path: string, dataUrl: string, overwrite = true): Promise<unknown> {
      return await http<unknown>('/api/files/upload', {
        method: 'POST',
        body: JSON.stringify({ path, data_url: dataUrl, overwrite }),
      });
    },

    async localFileInfo(path: string): Promise<LocalFileInfo> {
      const raw = await http<Record<string, unknown>>(`/api/plugins/hermes-pwa/file/info?path=${encodeURIComponent(path)}`);
      return {
        name: typeof raw.name === 'string' ? raw.name : path.split('/').pop() ?? path,
        size: typeof raw.size === 'number' ? raw.size : undefined,
        mime: typeof raw.mime === 'string' ? raw.mime : undefined,
        inline: raw.inline === true,
        image: raw.image === true,
      };
    },

    async messagingPlatforms(): Promise<MessagingOverview> {
      return toMessagingOverview(await http<unknown>('/api/messaging/platforms'));
    },

    async obsidianActivity(days = 60): Promise<ObsidianActivity> {
      return toObsidianActivity(
        await http<unknown>(`/api/plugins/hermes-pwa/obsidian/activity?days=${encodeURIComponent(String(days))}`),
      );
    },

    async agentHistory(days = 30): Promise<AgentHistory> {
      return agentHistoryRequest(days);
    },

    async obsidianNote(vault: string, path: string): Promise<ObsidianNoteContent> {
      return toObsidianNoteContent(
        await http<unknown>(
          `/api/plugins/hermes-pwa/obsidian/note?vault=${encodeURIComponent(vault)}&path=${encodeURIComponent(path)}`,
        ),
      );
    },
  };
}
