/**
 * Dev-only preview wrapper — bypasses real auth/WS so you can inspect
 * all screens without a running Hermes backend.
 * Activated via ?preview in the URL (dev builds only).
 */
import { useEffect } from 'react';
import {
  HermesHttpError,
  makeRpcEvents,
  useConnectionStore,
  useSessionsStore,
  useActivityStore,
  useChatStore,
  useProjectsStore,
} from '@hermes-pwa/core';
import type { RpcClient, RestClient, Approval, Session } from '@hermes-pwa/core';
import type {
  Board,
  BoardDetail,
  Column,
  Task,
  TaskStatus,
  Profile,
  ProfileActive,
  SystemStats,
  CronJob,
  Artifact,
  EnvVar,
  McpServer,
  Skill,
} from '@hermes-pwa/core';
import { AppShell } from './AppShell';

const previewSessions = [
  {
    id: 'prev-1',
    title: 'Refactor WS gateway reconnect',
    cwd: '/home/stasstep/PWAHermesprototype',
    messageCount: 42,
    profile: undefined,
    source: 'cli',
    active: true,
    isActive: true,
    updatedAt: Date.now() - 12 * 60 * 1000,
  },
  {
    id: 'prev-2',
    title: 'Investigate web_server traceback',
    cwd: '/project',
    messageCount: 18,
    profile: undefined,
    source: 'cli',
    active: false,
    isActive: false,
    updatedAt: Date.now() - 60 * 60 * 1000,
  },
  {
    id: 'prev-3',
    title: 'OpenAPI → TypeScript pipeline',
    cwd: '/project',
    messageCount: 7,
    profile: 'career-content',
    source: 'tui',
    active: false,
    isActive: false,
    updatedAt: Date.now() - 3 * 60 * 60 * 1000,
  },
  {
    id: 'prev-4',
    title: 'Kanban dispatch flakiness',
    cwd: '/project',
    messageCount: 31,
    profile: undefined,
    source: 'cli',
    active: false,
    isActive: false,
    updatedAt: Date.now() - 24 * 60 * 60 * 1000,
  },
  {
    id: 'prev-5',
    title: 'Soul rewrite · career-content',
    cwd: '/project',
    messageCount: 12,
    profile: 'career-content',
    source: 'tui',
    active: false,
    isActive: false,
    updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'prev-6',
    title: 'Backup + checkpoint review',
    cwd: '/project',
    messageCount: 5,
    profile: undefined,
    source: 'cli',
    active: false,
    isActive: false,
    updatedAt: Date.now() - 5 * 60 * 60 * 1000,
  },
  {
    id: 'prev-7',
    title: 'Env secrets audit',
    cwd: '/project',
    messageCount: 9,
    profile: undefined,
    source: 'cli',
    active: false,
    isActive: false,
    updatedAt: Date.now() - 24 * 60 * 60 * 1000,
  },
];

const previewMessages = [
  {
    id: 'm-user-1',
    role: 'user' as const,
    text: 'WS gateway drops connections after ~30s idle. The ticket TTL is 30s — fix reconnect so mobile stays live. Keep it reversible.',
    createdAt: Date.now() - 120_000,
  },
  {
    id: 'm-assistant-1',
    role: 'assistant' as const,
    text: 'Found it. The WS ticket TTL is 30s and the client never refreshes it, so the socket dies on the first idle gap.\n\nPlan: add a 20s heartbeat ping, silently refresh the ws-ticket before expiry, and give the server a 10s grace window. All behind a `ws.reconnect` flag — fully reversible.',
    toolCalls: [
      { id: 't1', name: 'read_file', input: { path: 'tui_gateway/ws.py' }, output: '142 lines' },
      { id: 't2', name: 'read_file', input: { path: 'web/src/lib/api.ts' }, output: 'done' },
      { id: 't3', name: 'shell.exec', input: { command: 'pytest -k reconnect' }, output: '2 passed' },
    ],
    createdAt: Date.now() - 90_000,
  },
];

const noopRpc: RpcClient = {
  request: (method, params) => {
    if (method === 'session.list') {
      return Promise.resolve(previewSessions as unknown as never);
    }
    if (method === 'session.most_recent') {
      return Promise.resolve({ session_id: 'prev-1' } as unknown as never);
    }
    if (method === 'session.resume') {
      const id =
        typeof params === 'object' && params !== null
          ? (params as Record<string, unknown>).session_id
          : undefined;
      return Promise.resolve({
        session_id: `live-${id ?? 'prev-1'}`,
        stored_session_id: id ?? 'prev-1',
        messages: previewMessages,
      } as unknown as never);
    }
    if (method === 'session.history') {
      return Promise.resolve(previewMessages as unknown as never);
    }
    if (method === 'approval.respond' || method === 'clarify.respond') {
      return Promise.resolve({ ok: true } as unknown as never);
    }
    return Promise.resolve(undefined as never);
  },
  onFrame: () => () => {},
  disconnect: () => {},
  events: makeRpcEvents(),
  lastSeq: () => 0,
  replayEvent: () => undefined,
  replayEpoch: () => undefined,
  onServerRequest: () => () => undefined,
  respond: () => true,
  respondError: () => true,
  replayServerRequests: () => undefined,
};

const PREVIEW_STATUSES: TaskStatus[] = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'backlog',
  'in_progress',
  'review',
  'done',
  'blocked',
];

const previewProfiles: Profile[] = [
  { name: 'default',        model: 'GPT-5.5 · Med',    displayName: 'default',        description: 'General engineering copilot · reversible-first', isActive: true  },
  { name: 'career-content', model: 'Claude Sonnet',     displayName: 'career-content', description: 'Long-form content & posts',                      isActive: false },
  { name: 'ops',            model: 'GPT-5.5 · High',   displayName: 'ops',            description: 'Infra, deploys & incident response',             isActive: false },
  { name: 'research',       model: 'o-series · High',  displayName: 'research',       description: 'Deep research, keeps things reversible',         isActive: false },
];

const previewTasks: Task[] = [
  { id: 't1', title: 'Type WS JSON-RPC contract', status: 'backlog', priority: 5, assignee: 'default', createdAt: Date.now() },
  { id: 't2', title: 'Map Projects → Kanban boards', status: 'backlog', priority: 2, assignee: 'unassigned', createdAt: Date.now() },
  { id: 't3', title: 'openapi-typescript in CI', status: 'backlog', priority: 2, assignee: 'ops', createdAt: Date.now() },
  { id: 't4', title: 'Refactor WS reconnect', status: 'in_progress', priority: 5, assignee: 'default', run: 'run-7f3 · live', createdAt: Date.now() },
  { id: 't5', title: 'Soul rewrite', status: 'in_progress', priority: 10, assignee: 'career-content', run: 'run-7e1 · live', createdAt: Date.now() },
  { id: 't6', title: 'Backup to S3', status: 'blocked', priority: 5, assignee: 'ops', block: 'missing AWS creds', createdAt: Date.now() },
  { id: 't7', title: 'Status endpoint shape', status: 'done', priority: 5, assignee: 'default', createdAt: Date.now() },
  { id: 't8', title: 'WS ticket TTL audit', status: 'done', priority: 2, assignee: 'default', createdAt: Date.now() },
];

const previewColumns: Column[] = PREVIEW_STATUSES
  .map((status) => ({ status, tasks: previewTasks.filter((t) => t.status === status) }))
  .filter((col) => col.tasks.length > 0 || col.status !== 'blocked');

const noopRest: RestClient = {
  status:              () => Promise.resolve({ authRequired: false, authProviders: [] }),
  providers:           () => Promise.resolve([]),
  passwordLogin:       () => Promise.reject(new Error('preview')),
  me:                  () => Promise.reject(new Error('preview')),
  wsTicket:            () => Promise.reject(new Error('preview')),
  logout:              () => Promise.resolve(),
  setActiveProfile:    () => undefined,
  profileList:         () => Promise.resolve(previewProfiles),
  profileActive:       () => Promise.resolve({ current: 'default' } as ProfileActive),
  profileActivate:     () => Promise.resolve(),
  profileCreate:       () => Promise.resolve({ ok: true, name: 'preview' }),
  profileRename:       () => Promise.resolve(),
  profileDelete:       () => Promise.resolve(),
  profileUpdateModel:  () => Promise.resolve({ ok: true }),
  kanbanBoards:        () => Promise.resolve([
    { id: 'b1', name: 'Sprint 2026-06', slug: 'sprint-2606', taskCount: previewTasks.length },
  ] as Board[]),
  kanbanBoard:         () => Promise.resolve({
    slug: 'sprint-2606',
    name: 'Sprint 2026-06',
    columns: previewColumns,
  } as BoardDetail),
  kanbanCreateBoard:   () => Promise.reject(new Error('preview')),
  kanbanDeleteBoard:   () => Promise.reject(new Error('preview')),
  kanbanSwitchBoard:   () => Promise.reject(new Error('preview')),
  kanbanCreateTask:    () => Promise.reject(new Error('preview')),
  kanbanUpdateTask:    () => Promise.reject(new Error('preview')),
  kanbanTaskDetail:    () => Promise.reject(new Error('preview')),
  kanbanComment:       () => Promise.resolve(),
  profileSessions:     () => Promise.resolve(previewSessions),
  latestSession:       (profile: string) => Promise.resolve(
    profile === 'default' ? previewSessions[0] as unknown as Session
      : profile === 'ops' ? { ...previewSessions[1], updatedAt: Date.now() - 26 * 60 * 60 * 1000 } as unknown as Session
        : undefined,
  ),
  botGraph:            () => Promise.resolve(undefined),
  saveBotGraph:        (map) => Promise.resolve({ ...map, version: 1 }),
  sessionMessages:     () => Promise.resolve({ messages: [] }),
  sessionUpdate:       () => Promise.resolve({ ok: true }),
  sessionDelete:       () => Promise.resolve({ ok: true }),
  sessionBulkDelete:   () => Promise.resolve({ ok: true }),
  systemStats:         () => Promise.resolve({
    version: 'v0.16.0',
    uptimeSeconds: 22320,
    hostUptimeSeconds: 864000,
    activeSessions: 1,
    cpuPercent: 18,
    memoryUsedMb: 2100,
    memoryTotalMb: 8192,
    memoryPercent: 25.6,
    diskUsedMb: 58 * 1024,
    diskTotalMb: 100 * 1024,
    diskFreeMb: 42 * 1024,
    diskPercent: 58,
  } as SystemStats),
  opsRun:              (op) => Promise.resolve({ ok: true, name: op, pid: 4321, status: 'started', message: `${op} started` }),
  gatewayAction:       (action) => Promise.resolve({ ok: true, name: `gateway-${action}`, pid: 4322, status: 'started' }),
  actionStatus:        (name) => Promise.resolve({ name, running: false, exitCode: 0, pid: 4321, lines: [`=== ${name} started ===`, 'preview output', 'done'] }),
  pendingActions:      () => Promise.resolve([]),
  pushStatus:          () => Promise.resolve({ available: false, enabled: false, reason: 'preview', subscriptions: [] }),
  pushSubscribe:       () => Promise.reject(new Error('preview')),
  pushUnsubscribe:     () => Promise.resolve({ ok: true }),
  pushTest:            () => Promise.resolve({ ok: true }),
  updateCheck:         () => Promise.resolve({ ok: true, current: '0.1.0', latest: '0.1.0', source: 'npm', updateAvailable: false, canApply: false, manualRequired: false, installMethod: 'preview', instructions: [] }),
  opsCheckpoints:      () => Promise.resolve([]),
  opsBackups:          () => Promise.resolve([
    { id: 'backup-0419', name: 'hermes-pwa-state-20260611T184500Z', createdAt: Date.now() - 3600000, sizeMb: 31.1, kind: 'directory' },
    { id: 'backup-0418', name: 'before-hermes-pwa-20260611T055109Z.zip', createdAt: Date.now() - 24 * 3600000, sizeMb: 143.3, kind: 'archive' },
  ]),

  cronJobs:            () => Promise.resolve([
    { id: 'j1', name: 'Nightly backup',      expression: '0 3 * * *',    enabled: true,  nextRun: Date.now() + 3600000 * 1,  lastStatus: 'ok' },
    { id: 'j2', name: 'Security audit',      expression: '0 */6 * * *',  enabled: true,  nextRun: Date.now() + 3600000 * 7,  lastStatus: 'ok' },
    { id: 'j3', name: 'Session prune',       expression: '0 4 * * 0',    enabled: false, nextRun: Date.now() + 3600000 * 24, lastStatus: undefined },
    { id: 'j4', name: 'Doctor health check', expression: '*/15 * * * *', enabled: true,  nextRun: Date.now() + 120000,        lastStatus: 'warn' },
  ] as CronJob[]),
  cronJobDetail:       () => Promise.reject(new Error('preview')),
  cronJobRuns:         () => Promise.resolve({ runs: [], limit: 20 }),
  cronCreateJob:       () => Promise.reject(new Error('preview')),
  cronUpdateJob:       () => Promise.reject(new Error('preview')),
  cronPauseJob:        () => Promise.reject(new Error('preview')),
  cronResumeJob:       () => Promise.reject(new Error('preview')),
  cronTriggerJob:      () => Promise.reject(new Error('preview')),
  cronDeleteJob:       () => Promise.reject(new Error('preview')),
  cronDeliveryTargets: () => Promise.resolve([{ id: 'local', name: 'Local', homeTargetSet: true, homeEnvVar: null }]),
  sessionArtifacts:   () => Promise.resolve([
    { id: 'a1', name: 'architecture.png', type: 'image/png', path: '#', createdAt: Date.now() },
    { id: 'a2', name: 'output.txt',       type: 'text/plain', path: '#', createdAt: Date.now() },
    { id: 'a3', name: 'https://anthropic.com/docs', type: 'link', path: 'https://anthropic.com/docs', createdAt: Date.now() },
  ] as Artifact[]),
  envList:             () => Promise.resolve([
    { key: 'OPENAI_API_KEY',        value: '', sensitive: true },
    { key: 'TELEGRAM_BOT_TOKEN',    value: '', sensitive: true },
    { key: 'AWS_SECRET_ACCESS_KEY', value: '', sensitive: false },
  ] as EnvVar[]),
  config:              () => Promise.resolve({}),
  setConfig:           () => Promise.resolve({ ok: true }),
  modelOptions:        () => Promise.resolve({ providers: [] }),
  modelInfo:           () => Promise.resolve({ model: 'gpt-5.5', provider: 'openai-codex', capabilities: {} }),
  modelAuxiliary:      () => Promise.resolve({ main: { provider: '', model: '' }, tasks: [] }),
  modelSet:            () => Promise.resolve({ ok: true }),
  mcpServers:          () => Promise.resolve([
    { name: 'filesystem', enabled: true,  type: 'stdio',    tools: 12 },
    { name: 'github',     enabled: true,  type: 'sse',      tools: 31 },
    { name: 'postgres',   enabled: false, type: 'readonly', tools: 8  },
  ] as McpServer[]),
  mcpToggle:           () => Promise.resolve(),
  skillsList:          () => Promise.resolve([
    { id: 's1', name: 'read_file',       description: 'Read project files',                  enabled: true  },
    { id: 's2', name: 'shell.exec',      description: 'Run shell commands · needs approval', enabled: true  },
    { id: 's3', name: 'web.search',      description: 'Search the web',                      enabled: true  },
    { id: 's4', name: 'kanban.dispatch', description: 'Spawn worker runs',                   enabled: true  },
    { id: 's5', name: 'cron.manage',     description: 'Schedule recurring jobs',             enabled: true  },
    { id: 's6', name: 'backup.run',      description: 'Snapshot & restore state',            enabled: false },
  ] as Skill[]),
  audioTranscribe:     () => Promise.resolve(''),
  audioSpeak:          () => Promise.resolve({ dataUrl: 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==', mimeType: 'audio/wav' }),
  speechVoices:        () => Promise.resolve({
    available: true,
    defaultVoice: 'Samantha',
    voices: [
      { id: 'Ava (Premium)', name: 'Ava', lang: 'en-US', quality: 'premium' },
      { id: 'Samantha', name: 'Samantha', lang: 'en-US', quality: 'standard' },
      { id: 'Daniel', name: 'Daniel', lang: 'en-GB', quality: 'standard' },
    ],
  }),
  // No Mac in the preview: read-aloud falls back to the browser's own voice.
  speechAudio:         () => Promise.reject(new HermesHttpError(501, 'Not Implemented', 'preview')),
  fileUpload:          () => Promise.resolve({ path: 'preview.txt' }),
  localFileInfo:       () => Promise.resolve({ name: 'preview.png', size: 1024, mime: 'image/png', inline: true, image: true }),
  obsidianActivity:    () => Promise.resolve({
    available: true,
    vaults: [{ name: 'General', path: '/Users/preview/Desktop/General', phoneName: 'Vault 1', open: true }],
    notes: [
      { path: 'Clients/Ann Lee/Ann Lee.md', name: 'Ann Lee', folder: 'Clients/Ann Lee', vault: 'General', phoneVault: 'Vault 1', action: 'created' as const, at: Date.now() - 3_600_000, createdAt: Date.now() - 3_600_000, editedAt: undefined, profile: 'default', size: 2400 },
      { path: 'Business & Ops/Orders/Orders — MOC.md', name: 'Orders — MOC', folder: 'Business & Ops/Orders', vault: 'General', phoneVault: 'Vault 1', action: 'edited' as const, at: Date.now() - 90_000_000, createdAt: undefined, editedAt: Date.now() - 90_000_000, profile: 'obsidian-vault-manager', size: 800 },
    ],
    scannedAt: Date.now(),
    days: 60,
    total: 2,
    error: undefined,
  }),
  browseOnlySessions:  () => Promise.resolve([
    { id: 'sig-1', title: 'Weekly workout log chest legs back', updatedAt: Date.now() / 1000 - 1800, messageCount: 25, profile: 'default', source: 'signal', originSource: 'signal', currentSource: 'signal', profileName: 'default' },
    { id: 'cron-1', title: 'Nightly memory review · Oct 25 02:42', updatedAt: Date.now() / 1000 - 36_000, messageCount: 54, profile: 'default', source: 'cron', originSource: 'cron', currentSource: 'cron', profileName: 'default' },
    { id: 'sub-1', title: "Subagent: Check Sean's Google Calendar for today", updatedAt: Date.now() / 1000 - 90_000, messageCount: 13, profile: 'default', source: 'subagent', originSource: 'subagent', currentSource: 'subagent', profileName: 'google-calander', parentSessionId: 'p-1' },
  ] as Session[]),
  agentHistory:        () => Promise.resolve({
    runs: [
      { id: 'sub1', bot: 'google-calander', ownerProfile: 'default', goal: "Check Sean's Google Calendar for today", model: 'claude-sonnet-5', status: 'completed' as const, startedAt: Date.now() - 3_600_000, endedAt: Date.now() - 3_540_000, durationSeconds: 63, messageCount: 13, toolCallCount: 6, inputTokens: 12, outputTokens: 5492, costUsd: undefined, lastActivity: undefined, parent: { id: 'p', title: 'Check Google Calendar via delegate_task', source: 'oneshot', profile: 'default' }, result: '## Summary\n\nTwo events today.' },
    ],
    days: 30,
    total: 1,
    scannedAt: Date.now(),
    error: undefined,
  }),
  obsidianNote:        () => Promise.resolve({ vault: 'General', phoneVault: 'Vault 1', path: 'Clients/Ann Lee/Ann Lee.md', name: 'Ann Lee', text: '---\ntype: note\ntags: [client]\n---\n\n# Ann Lee\n\nCheck-in prep for Friday.', size: 80, modifiedAt: Date.now() - 3_600_000 }),
  messagingPlatforms:  () => Promise.resolve({
    gatewayRunning: true,
    platforms: [
      { id: 'signal', name: 'Signal', description: 'Connect through a signal-cli REST bridge.', docsUrl: undefined, enabled: true, configured: true, state: 'connected' as const, rawState: 'connected', errorMessage: undefined, updatedAt: Date.now() - 3_600_000, homeChannel: 'Home', requiredSet: 2, requiredTotal: 2 },
      { id: 'telegram', name: 'Telegram', description: 'Run Hermes from Telegram DMs, groups, and topics.', docsUrl: undefined, enabled: false, configured: false, state: 'disabled' as const, rawState: 'disabled', errorMessage: undefined, updatedAt: undefined, homeChannel: undefined, requiredSet: 0, requiredTotal: 1 },
    ],
  }),
};

export function AppPreview() {
  useEffect(() => {
    useConnectionStore.setState({ state: 'connected', error: undefined });
    useSessionsStore.setState({ sessions: previewSessions, loading: false, error: undefined });
    useActivityStore.setState({
      items: [
        {
          id: 'a1',
          kind: 'approval',
          status: 'needs_you',
          title: 'shell.exec',
          summary: 'git commit -am "ws: heartbeat + ticket refresh"',
          highImpact: false,
          visibility: 'private',
          createdAt: Date.now(),
        } as Approval,
        {
          id: 'a2',
          kind: 'approval',
          status: 'needs_you',
          title: 'fs.write',
          summary: '.hermes/.env · writes 3 secret keys',
          highImpact: true,
          visibility: 'private',
          createdAt: Date.now() - 120_000,
        } as Approval,
      ],
      loading: false,
      error: undefined,
    });
    useChatStore.setState({
      sessionId: 'live-prev-1',
      storedSessionId: 'prev-1',
      messages: previewMessages,
      streaming: false,
      error: undefined,
    });
    useProjectsStore.setState({
      boards: [{ id: 'b1', name: 'Sprint 2026-06', slug: 'sprint-2606', taskCount: 8 }],
      activeBoardSlug: 'sprint-2606',
      workers: [
        { name: 'worker-1', task: 'Refactor WS reconnect', active: true },
        { name: 'worker-2', task: 'Soul rewrite', active: true },
        { name: 'worker-3', task: 'Idle', active: false },
      ] as unknown as import('@hermes-pwa/core').Worker[],
      tasks: [
        { id: 't1', title: 'Type WS JSON-RPC contract', status: 'backlog', priority: 'P1', assignee: 'default' },
        { id: 't2', title: 'Map Projects → Kanban boards', status: 'backlog', priority: 'P2', assignee: 'unassigned' },
        { id: 't3', title: 'openapi-typescript in CI', status: 'backlog', priority: 'P2', assignee: 'ops' },
        { id: 't4', title: 'Refactor WS reconnect', status: 'in_progress', priority: 'P1', assignee: 'default', run: 'run-7f3 · live' },
        { id: 't5', title: 'Soul rewrite', status: 'in_progress', priority: 'P0', assignee: 'career-content', run: 'run-7e1 · live' },
        { id: 't6', title: 'Backup to S3', status: 'blocked', priority: 'P1', assignee: 'ops', block: 'missing AWS creds' },
        { id: 't7', title: 'Status endpoint shape', status: 'done', priority: 'P1', assignee: 'default' },
        { id: 't8', title: 'WS ticket TTL audit', status: 'done', priority: 'P2', assignee: 'default' },
      ] as unknown as import('@hermes-pwa/core').Task[],
      loading: false,
      error: undefined,
    });
  }, []);

  return <AppShell connectionState="connected" rpc={noopRpc} rest={noopRest} />;
}
