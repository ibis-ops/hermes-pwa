// Public surface of @hermes-pwa/core
// Framework-agnostic: transport, domain, stores, platform interface.

export type { Platform } from './platform';
export { HermesHttpError, makeHttp, type Http } from './transport/http';
export { makeAuthClient } from './transport/auth';
export type { AuthState, HermesStatus, HermesUser } from './transport/auth';
export { makeRestClient, type RestClient } from './transport/rest';
export type { PushStatus, PushSubscribeBody, PushSubscriptionSafe } from './transport/rest';
export type { UpdateCheck, UpdateInstruction } from './domain/update';
export { makeRpcClient, makeRpcEvents, METHOD_NOT_FOUND, type RpcClient, type RpcEvents, type RpcEvent, type ServerRequest, type ServerRequestHandler } from './transport/jsonrpc';
export { makeWsConnection, type WsConnection } from './transport/ws';
export { useConnectionStore, type ConnectionState, type ConnectionStore } from './stores/connection';
export { useSessionsStore, type SessionsStore } from './stores/sessions';
export {
  useChatStore,
  stabilizeMessages,
  projectHistoryMessages,
  LIVE_STREAM_QUIET_MS,
  LIVE_STREAM_STALE_MS,
  MAX_PERSISTED_TRANSCRIPT_CHARS,
  __setLiveEventAge,
  type ChatStore,
  type SubmitOptions,
  type SubmitResult,
  type EnqueueOptions,
  type InterruptOptions,
} from './stores/chat';
export {
  attachChatEvents,
  cleanLiveStatus,
  extractMessageText,
  extractToolInput,
  isNonChatStatus,
  parseMaybeObject,
  eventBelongsToActiveChat,
  type ChatEventOptions,
} from './stores/chat-events';
export { SELECTED_PROFILE_STORAGE_KEY } from './stores/selected-profile';
export { describeSkillInvocation, skillInvocationText, isSkillScaffold, type SkillInvocation } from './domain/skill-invocation';
export { useActivityStore, type ActivityStore } from './stores/activity';
export { useCronStore, type CronStore } from './stores/cron';
export { useConfigStore, type ConfigStore } from './stores/config';
export { useModelStore, type ModelStore } from './stores/model';
export { useProjectsStore, type ProjectsStore } from './stores/projects';
export { useAgentsStore, type AgentsStore } from './stores/agents';
export { useProfilesStore, type ProfilesStore } from './stores/profiles';
export { useSpawnStore, SPAWN_EVENT_TYPES, type SpawnStore } from './stores/spawnStore';
export { explainConnectionError, connectionStateLabel, type ConnectionDiagnostics } from './diagnostics';

// Domain types
export type { GatewayStatus } from './domain/status';
export type { AuthProvider, LoginBody, LoginResult, WsTicket } from './domain/auth';
export type { Session, Message, MessageRole, ToolCall } from './domain/session';
export {
  normalizeSessionSource,
  sessionPinId,
  sessionCurrentSourceId,
  sessionHasDifferentCurrentSource,
  sessionSourceId,
  sessionSourceLabel,
  sessionSourceSearchTerms,
  sessionFromAgentRun,
  mergeBrowseOnlySessions,
  PWA_BROWSE_ONLY_SESSION_SOURCES,
} from './domain/session';
export type { ActionItem, ActionKind, ActionStatus, Approval, ApprovalChoice, Clarify, ClarifyQuestion } from './domain/activity';
export { approvalFromServerRequest, clarifyFromServerRequest } from './domain/activity';
export type { Board, BoardDetail, Column, Task, TaskStatus, Worker } from './domain/project';
export type { AgentProfile } from './domain/agent';
export type { Profile, ProfileActive, ProfileCreateBody, ProfileCreateResult, ReasoningEffort } from './domain/profile';
export type { SpawnedAgent, SpawnNode, StreamEntry, SpawnStatus, StreamKind } from './domain/spawn';
export { buildSpawnTree } from './domain/spawn';
export type { CronDeliveryTarget, CronJob, CronJobRun, CronSchedule } from './domain/cron';
export {
  DEFAULT_SCHEDULE_STATE,
  ENGLISH_SCHEDULE_STRINGS,
  WEEKDAY_INDEXES,
  buildScheduleString,
  describeSchedule,
  englishOrdinal,
  toCronDeliveryTarget,
  toCronJob,
  toCronJobRun,
} from './domain/cron';
export type { IntervalUnit, ScheduleBuilderState, ScheduleDescribeStrings, ScheduleMode, Weekday } from './domain/cron';
export type { McpServer } from './domain/mcp';
export type { EnvVar } from './domain/env';
export type { Skill } from './domain/skills';
export { skillCommandSlug } from './domain/skills';
export type {
  AuxiliaryModels,
  ModelAssignment,
  ModelAssignmentResult,
  ModelInfo,
  ModelOptions,
  ModelProvider,
} from './domain/model';
export type { SystemStats, Checkpoint, OpsRunResult, SystemActionStatus } from './domain/system';
export type { MessagingPlatform, MessagingPlatformState, MessagingOverview } from './domain/messaging';
export { sortMessagingPlatforms, messagingStateLabel, toMessagingOverview } from './domain/messaging';
export type { ObsidianActivity, ObsidianNote, ObsidianVault, ObsidianNoteAction, ObsidianDayGroup, ObsidianNoteContent, ParsedNote } from './domain/obsidian';
export { toObsidianActivity, toObsidianNoteContent, obsidianOpenUrl, resolveLinkVault, groupNotesByDay, parseObsidianNote, obsidianToMarkdown } from './domain/obsidian';
export type { AgentHistory, AgentRun, AgentRunParent, AgentRunStatus, AgentRunDayGroup } from './domain/agent-history';
export { toAgentHistory, toAgentRun, groupRunsByDay } from './domain/agent-history';
export type { BotActivity, BotActivityReport, BotWork, BotWorkKind } from './domain/bot-activity';
export { toBotActivityReport, toBotWork, describeActivity, workingBots } from './domain/bot-activity';
export type { Artifact } from './domain/artifact';
export type { HermesConfig } from './domain/config';
export { extractFileRefs, stripAttachmentRefs, attachmentRefs, localFileUrl, localFileInfoUrl, MAX_FILE_REFS_PER_MESSAGE, type FileRef, type FileRefKind } from './domain/file-refs';
export type { LocalFileInfo, SpeechAudio, SpeechVoice, SpeechVoices, VaultSyncResult } from './transport/rest';
export {
  TEAM_ROLE_MAX_CHARS,
  addToMap,
  botLabel,
  defaultTeamMap,
  descendantsOf,
  possibleBosses,
  removeFromMap,
  sameTeamMap,
  teamTree,
  toTeamMap,
  topBot,
  updateNode,
  withBots,
  withRouterOnTop,
  type TeamMap,
  type TeamNode,
  type TeamTreeNode,
} from './domain/teamMap';
export {
  ROUTER_KEY_NAME,
  ROUTER_ROLE,
  ROUTER_SELF,
  routerTextKey,
  toProfileRoutes,
  toRouterDecision,
  toRouterSettings,
  toRouterStatus,
  toRouterTry,
  withProfileRoute,
  type ProfileRoute,
  type ProfileRoutes,
  type RouterDecision,
  type RouterSettings,
  type RouterStatus,
  type RouterTry,
  type UnreachableBot,
} from './domain/router';
