import { create } from 'zustand';
import {
  findSessionByAlias,
  sessionLineageKey,
  type Message,
  type ToolCall,
} from '../domain/session';
import { useSessionsStore } from './sessions';
import { useActivityStore } from './activity';
import { readSelectedProfile } from './selected-profile';
import { JsonRpcError, type RpcClient } from '../transport/jsonrpc';
import { HermesHttpError } from '../transport/http';
import type { RestClient } from '../transport/rest';
import { LONG_RPC_TIMEOUT_MS } from '../transport/timeouts';
import { describeSkillInvocation, skillInvocationText } from '../domain/skill-invocation';

const LEGACY_ACTIVE_SESSION_STORAGE_KEYS = ['hermes-pwa.activeSession.v1', 'hermes-pwa.activeSession.v2'] as const;
const ACTIVE_SESSION_STORAGE_KEY = 'hermes-pwa.activeSession.v3';
const PROFILED_ACTIVE_SESSION_STORAGE_KEY_PREFIX = 'hermes-pwa.activeSession.v4';
/**
 * The cached transcript is a cold-start convenience, not the record (Hermes
 * state.db is). Past this many characters of JSON the oldest rows are left out
 * of the snapshot so a long session never fails to persist at all.
 */
export const MAX_PERSISTED_TRANSCRIPT_CHARS = 1_500_000;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const PWA_UNSUPPORTED_SLASH_COMMANDS = new Set(['/whoami']);
const MAX_ALIAS_DISPATCH_DEPTH = 8;
const PROMPT_SUBMIT_TIMEOUT_MS = 90_000;
/**
 * While live events keep arriving, the local transcript is authoritative and a
 * REST snapshot would only lag it. The periodic refresh waits this long after
 * the last event before it reconciles a turn that is still marked streaming.
 */
export const LIVE_STREAM_QUIET_MS = 20_000;
/**
 * Past this much silence the turn is treated as possibly lost (the WebSocket
 * died, the gateway restarted) and the REST snapshot decides `streaming` on its
 * own, as it did before the quiet guard existed.
 */
export const LIVE_STREAM_STALE_MS = 120_000;
let assistantMessageSequence = 0;
let systemMessageSequence = 0;
let lastLiveEventAt = 0;
const submitInFlightKeys = new Set<string>();
const interruptInFlightKeys = new Set<string>();
const aliasDispatchStack: string[] = [];

function touchLiveEvent(): void {
  lastLiveEventAt = Date.now();
}

/** Test seam: how long ago the last live chat event arrived. */
export function liveEventAgeMs(now = Date.now()): number {
  return lastLiveEventAt === 0 ? Number.POSITIVE_INFINITY : now - lastLiveEventAt;
}

/** Test seam: pretend the last live event arrived `ageMs` ago. */
export function __setLiveEventAge(ageMs: number | undefined): void {
  lastLiveEventAt = ageMs === undefined ? 0 : Date.now() - ageMs;
}

/** The live stream is known to be stale (socket was down): let the next refresh reconcile freely. */
function markLiveStreamStale(): void {
  lastLiveEventAt = 0;
}

function nextAssistantMessageId(): string {
  assistantMessageSequence += 1;
  return `a-${Date.now()}-${assistantMessageSequence}`;
}

function nextSystemMessageId(): string {
  systemMessageSequence += 1;
  return `sys-${Date.now()}-${systemMessageSequence}`;
}

interface ActiveSessionCache {
  sessionId: string | undefined;
  storedSessionId: string | undefined;
  messages: Message[];
  streaming: boolean;
  profile: string | undefined;
  /** Prompts still waiting to be sent when the page went away. */
  queuedPrompts: string[];
}

const ACTIVE_SESSION_PERSIST_THROTTLE_MS = 1000;

export type SubmitResult = 'submitted' | 'busy' | 'failed';

export interface InterruptOptions {
  keepStreaming?: boolean;
}

export interface EnqueueOptions {
  /** Put the prompt ahead of everything already waiting (interrupt and send). */
  front?: boolean;
}

export interface SubmitOptions {
  /**
   * What the user bubble shows when the sent text is a scaffold the person did
   * not type (a /skill expansion): the invocation as typed.
   */
  displayText?: string | undefined;
}

interface SlashExecResponse {
  output?: string | undefined;
  warning?: string | undefined;
}

interface ExecCommandDispatchResponse {
  type: 'exec';
  output?: string | undefined;
}

interface PluginCommandDispatchResponse {
  type: 'plugin';
  output?: string | undefined;
}

interface AliasCommandDispatchResponse {
  type: 'alias';
  target: string;
}

interface SkillCommandDispatchResponse {
  type: 'skill';
  name: string;
  message?: string | undefined;
}

interface SendCommandDispatchResponse {
  type: 'send';
  message: string;
  notice?: string | undefined;
}

type CommandDispatchResponse =
  | ExecCommandDispatchResponse
  | PluginCommandDispatchResponse
  | AliasCommandDispatchResponse
  | SkillCommandDispatchResponse
  | SendCommandDispatchResponse;

export interface ChatStore {
  /** Live runtime session id used for prompt.submit/history/interrupt. */
  sessionId: string | undefined;
  /** Durable stored session id used for session.resume and drawer selection. */
  storedSessionId: string | undefined;
  messages: Message[];
  streaming: boolean;
  error: string | undefined;
  /**
   * The status line of the turn in progress (a thinking or tool status frame),
   * shown on the active bubble. Cleared whenever the turn ends. Not persisted.
   */
  liveStatus: string;
  /**
   * Prompts waiting for the running turn to finish, in send order. They are
   * persisted with the active session so a reload or a profile switch does
   * not lose them, and sent one at a time whenever the chat goes idle.
   */
  queuedPrompts: string[];
  /**
   * The text of the last prompt that could not be sent (not a busy answer),
   * so the composer can hand it back. Cleared by the next submit.
   */
  lastFailedText: string | undefined;

  /** Internal cache scope; not shown in UI. */
  cacheProfile: string | undefined;

  /**
   * Give the store the socket it drains the queue on; the shell binds it once
   * (attachChatEvents does) and passes a getter for the bot in use so queued
   * prompts go to the right one. Pass undefined to unbind.
   */
  bindRpc(rpc: RpcClient | undefined, getProfile?: () => string | undefined): void;
  /**
   * The REST client the shell talks to, bound and unbound with the socket by
   * attachChatEvents (boundRestClient() reads it); nothing in the store sends
   * on it by itself yet.
   */
  bindRest(rest: RestClient | undefined): void;
  setLiveStatus(text: string): void;
  enqueuePrompt(text: string, options?: EnqueueOptions): void;
  cancelQueuedPrompt(index: number): void;
  /** Send the next queued prompt; a busy answer puts it back at the front. */
  drainQueuedPrompt(rpc: RpcClient, profile?: string): Promise<void>;
  /**
   * Another bot was picked: bring up its own cached chat (or an empty one) at
   * once, before anything async runs, so no refresh, send or queue drain in
   * between can file the previous bot's session under the new bot. The
   * previous bot's chat is written to its own cache first.
   */
  switchCacheProfile(profile: string | undefined): void;
  /** A profile was renamed on the gateway: the cached session follows it. */
  renameCacheProfile(from: string, to: string): void;
  /** A profile was deleted: drop its cached session (and the chat, when it was the one open). */
  forgetCacheProfile(name: string): void;

  setSessionId(id: string | undefined, storedSessionId?: string | undefined): void;
  loadHistory(rest: RestClient, sessionId: string): Promise<void>;
  refreshHistory(rest: RestClient, profile?: string): Promise<void>;
  restore(rest: RestClient, rpc: RpcClient, profile?: string): Promise<void>;
  /**
   * After the WebSocket comes back (every return from the background on iOS):
   * re-attach to the parked live session, replay the events missed meanwhile
   * (or refetch when the replay ring no longer holds them), and take the
   * running flag from the gateway so a turn still in progress shows as such.
   */
  resyncLiveSession(rest: RestClient, rpc: RpcClient, profile?: string): Promise<'attached' | 'lost' | 'skipped'>;
  resumeSessionIntoChat(rest: RestClient, rpc: RpcClient, storedSessionId: string, profile?: string): Promise<void>;
  startNewSession(profile?: string): void;
  ensureLiveSession(rpc: RpcClient, profile?: string): Promise<{ sessionId: string; storedSessionId?: string | undefined }>;
  submit(rpc: RpcClient, text: string, profile?: string, options?: SubmitOptions): Promise<SubmitResult>;
  executeSlashCommand(rpc: RpcClient, text: string, profile?: string): Promise<SubmitResult>;
  steer(rpc: RpcClient, text: string): Promise<boolean>;
  /**
   * Show a message that was steered into the running turn: a user bubble at
   * the end of the transcript, followed by a fresh assistant row that the rest
   * of the stream lands in (Hermes stores a steer the same way: the reply
   * continues in a new row after it).
   */
  addSteeredMessage(text: string): void;
  interrupt(rpc: RpcClient, options?: InterruptOptions): Promise<void>;
  appendDelta(text: string): void;
  finishAssistant(finalText?: string | undefined): void;
  failAssistant(error: string): void;
  markIdle(): void;
  appendToolCall(tool: ToolCall): void;
  updateToolCall(id: string, patch: Partial<ToolCall>): void;
  appendThinking(text: string, replace?: boolean): void;
  /** Hermes closed a reply segment (interim commentary before tool calls). */
  sealSegment(): void;
  beginAssistant(): void;
  /** A live event arrived that carries no transcript change (a status line). */
  noteLiveEvent(): void;
  clear(profile?: string): void;
}

interface InternalMessage extends Message {
  /** Populated for raw tool messages so we can attach their output to the matching assistant tool call. */
  toolCallId?: string | undefined;
  toolName?: string | undefined;
}

type ActiveSessionPersistState = Pick<ChatStore, 'sessionId' | 'storedSessionId' | 'messages' | 'streaming'> & {
  cacheProfile?: string | undefined;
  queuedPrompts?: string[];
};

let pendingActiveSessionPersist: ActiveSessionPersistState | undefined;
let activeSessionPersistTimer: ReturnType<typeof setTimeout> | undefined;
let visibilityFlushListenerInstalled = false;

/**
 * The transport the shell bound (attachChatEvents): what a store-internal
 * queue drain sends on. Unbound until the shell attaches, so a bare store (a
 * test, a native shell that drains by hand) never sends on its own.
 */
let boundRpc: RpcClient | undefined;
let boundRest: RestClient | undefined;
let boundProfileGetter: (() => string | undefined) | undefined;
let queuedPromptDrainTimer: ReturnType<typeof setTimeout> | undefined;

/** The socket the shell bound, if any (attachChatEvents unbinds only its own). */
export function boundRpcClient(): RpcClient | undefined {
  return boundRpc;
}

/** The REST client the shell bound, if any. */
export function boundRestClient(): RestClient | undefined {
  return boundRest;
}

function toolMessageText(raw: Record<string, unknown>): string {
  const content = raw.content ?? raw.text ?? raw.context;
  return messageContentText(content);
}

function messageContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          return messageContentText(record.text ?? record.content ?? record.value ?? record.input ?? record.output);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nested = messageContentText(record.text ?? record.content ?? record.value ?? record.message);
    if (nested) return nested;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseToolInput(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return { raw: value };
  }
}

function normalizeToolCall(raw: unknown, index: number): ToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const fn = record.function && typeof record.function === 'object' ? (record.function as Record<string, unknown>) : undefined;
  const name =
    (typeof record.name === 'string' && record.name) ||
    (typeof fn?.name === 'string' && fn.name) ||
    (typeof record.tool_name === 'string' && record.tool_name) ||
    'tool';
  const tool: ToolCall = {
    id: String(record.id ?? record.tool_call_id ?? `tool-${index}`),
    name,
  };
  const input = parseToolInput(record.input ?? record.args ?? record.arguments ?? fn?.arguments ?? fn?.args);
  if (input) tool.input = input;
  const output = record.output ?? record.result;
  if (typeof output === 'string') tool.output = output;
  else if (output !== undefined) {
    try {
      tool.output = JSON.stringify(output);
    } catch {
      tool.output = String(output);
    }
  }
  return tool;
}

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return normalizeToolCalls(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(raw)) return undefined;
  const tools = raw.map(normalizeToolCall).filter((tool): tool is ToolCall => tool !== null);
  return tools.length > 0 ? tools : undefined;
}

function normalizeMessageRole(value: unknown): Message['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool' ? value : 'assistant';
}

function messageCreatedAt(raw: Record<string, unknown>): number | undefined {
  const value = raw.created_at ?? raw.createdAt ?? raw.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : undefined;
  }
  return undefined;
}

function toInternalMessage(raw: Record<string, unknown>, index = 0): InternalMessage {
  const role = normalizeMessageRole(raw.role);
  // `display_content` is Hermes's display-only projection (compaction
  // summaries, mid-turn steers): what its own clients show instead of the
  // model-facing content.
  let text =
    typeof raw.display_content === 'string'
      ? raw.display_content
      : typeof raw.text === 'string'
        ? raw.text
        : role === 'tool'
          ? toolMessageText(raw)
          : messageContentText(raw.content ?? raw.message ?? raw.rendered);
  let displayKind = typeof raw.display_kind === 'string' && raw.display_kind ? raw.display_kind : undefined;
  if (role === 'user' && typeof raw.display_content !== 'string') {
    // A /skill turn is stored as the expanded scaffold; show it as typed.
    const invocation = describeSkillInvocation(text);
    if (invocation) {
      text = skillInvocationText(invocation);
      displayKind = 'skill_invocation';
    }
  }
  const msg: InternalMessage = {
    id: String(raw.id ?? `m-${index}`),
    role,
    text,
    createdAt: messageCreatedAt(raw),
  };
  if (displayKind) msg.displayKind = displayKind;
  if (role === 'tool') {
    msg.toolCallId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined;
    msg.toolName = typeof raw.tool_name === 'string' ? raw.tool_name : typeof raw.name === 'string' ? raw.name : undefined;
  }
  const toolCalls = normalizeToolCalls(raw.tool_calls ?? raw.toolCalls);
  if (toolCalls) msg.toolCalls = toolCalls;
  const thinking = messageContentText(raw.thinking ?? raw.reasoning ?? raw.reasoning_content ?? raw.reasoningContent);
  if (thinking) msg.thinking = thinking;
  return msg;
}

function toPublicMessage(m: InternalMessage): Message {
  const msg: Message = {
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
  };
  if (m.toolCalls) msg.toolCalls = m.toolCalls;
  if (m.thinking) msg.thinking = m.thinking;
  if (m.displayKind) msg.displayKind = m.displayKind;
  // Hermes writes an assistant row when that segment is done, so a stored
  // row's timestamp is when it finished; a collapsed run keeps the last one.
  if (m.role === 'assistant' && m.createdAt !== undefined) msg.completedAt = m.createdAt;
  return msg;
}

function mergeToolMessages(messages: InternalMessage[]): InternalMessage[] {
  const out: InternalMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') {
      out.push(m);
      continue;
    }

    const toolCallId = m.toolCallId;
    const toolName = m.toolName;
    let attached = false;

    for (let i = out.length - 1; i >= 0; i -= 1) {
      const candidate = out[i];
      if (!candidate || candidate.role !== 'assistant' || !candidate.toolCalls || candidate.toolCalls.length === 0) {
        continue;
      }

      const matchIndex = candidate.toolCalls.findIndex(
        (t) =>
          (toolCallId && t.id === toolCallId) ||
          (toolName && t.name === toolName && t.output === undefined),
      );

      if (matchIndex >= 0) {
        const matched = candidate.toolCalls[matchIndex];
        if (!matched) continue;
        const nextTools = [...candidate.toolCalls];
        nextTools[matchIndex] = { ...matched, output: m.text };
        out[i] = { ...candidate, toolCalls: nextTools };
        attached = true;
        break;
      }
    }

    if (!attached) {
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const assistant = out[i];
        if (!assistant || assistant.role !== 'assistant') {
          continue;
        }
        const existing = assistant.toolCalls ?? [];
        out[i] = {
          ...assistant,
          toolCalls: [...existing, { id: m.id, name: toolName || 'tool', output: m.text }],
        };
        attached = true;
        break;
      }
    }
  }

  return out;
}

/**
 * The handoff row Hermes writes when it compacts a long session: a summary of
 * the turns it folded away, addressed to the model. History is requested with
 * the folded turns included, so the summary would only repeat them.
 */
const COMPACTION_SUMMARY_PREFIXES = ['[PRIOR CONTEXT', '[CONTEXT COMPACTION', '[CONTEXT SUMMARY'];

export function isCompactionSummaryRow(row: Record<string, unknown>): boolean {
  if (row._compressed_summary === true) return true;
  const content = typeof row.content === 'string' ? row.content.trimStart() : '';
  return COMPACTION_SUMMARY_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/** The transcript rows a REST history payload holds, projected the way the chat shows them. */
export function projectHistoryMessages(raw: unknown): Message[] {
  return messagesFromResult(raw);
}

function messagesFromResult(raw: unknown): Message[] {
  let maybeMessages: unknown[] = [];
  if (Array.isArray(raw)) {
    maybeMessages = raw;
  } else if (raw && typeof raw === 'object') {
    const candidate = (raw as Record<string, unknown>).messages;
    if (Array.isArray(candidate)) maybeMessages = candidate;
  }
  const internal = maybeMessages
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => !isCompactionSummaryRow(item))
    .map(toInternalMessage)
    // Rows Hermes types as hidden are scaffolding (recovery nudges, widget
    // intents); its own clients never draw a bubble for them.
    .filter((m) => m.displayKind !== 'hidden');
  return collapseAssistantRuns(mergeToolMessages(internal).map(toPublicMessage));
}

/**
 * Hermes stores one reply as several assistant rows when tools are involved
 * (a row holding the tool calls with empty text, then the answer). The live
 * stream shows a single bubble with the tools above the answer, so fold
 * consecutive assistant rows into one message to match.
 */
function collapseAssistantRuns(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (!last || last.role !== 'assistant' || message.role !== 'assistant') {
      out.push(message);
      continue;
    }
    const text = [last.text, message.text].filter((t) => t.trim() !== '').join('\n\n');
    const toolCalls = [...(last.toolCalls ?? []), ...(message.toolCalls ?? [])];
    const thinking = [last.thinking, message.thinking].filter((t): t is string => Boolean(t && t.trim())).join('\n\n');
    const merged: Message = { ...last, text };
    if (toolCalls.length > 0) merged.toolCalls = toolCalls;
    if (thinking) merged.thinking = thinking;
    const completedAt = message.completedAt ?? message.createdAt;
    if (completedAt !== undefined && (merged.completedAt === undefined || completedAt > merged.completedAt)) {
      merged.completedAt = completedAt;
    }
    out[out.length - 1] = merged;
  }
  return out;
}

function liveSessionIdFromResult(raw: unknown): string {
  if (!raw || typeof raw !== 'object') {
    throw new Error('session.create/resume returned an invalid response.');
  }
  const record = raw as Record<string, unknown>;
  const id = record.session_id ?? record.id;
  if (typeof id !== 'string' || !id) {
    throw new Error('session.create/resume returned no session_id.');
  }
  return id;
}

function durableSessionIdFromResult(raw: unknown, fallback: string | undefined): string | undefined {
  if (!raw || typeof raw !== 'object') return fallback;
  const record = raw as Record<string, unknown>;
  const id = record.stored_session_id ?? record.storedSessionId ?? record.session_key ?? record.stored_session_key ?? record.resumed;
  return typeof id === 'string' && id ? id : fallback;
}

function storedSessionIdFromMessagesResult(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== 'object') return fallback;
  const record = raw as Record<string, unknown>;
  const id = record.session_id ?? record.sessionId;
  return typeof id === 'string' && id ? id : fallback;
}


function isSessionNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 4001) return true;
  if (typeof record.message === 'string' && /session not found/i.test(record.message)) return true;
  const rpcError = record.rpcError;
  if (rpcError && typeof rpcError === 'object') {
    const rpcRecord = rpcError as Record<string, unknown>;
    if (rpcRecord.code === 4001) return true;
    if (typeof rpcRecord.message === 'string' && /session not found/i.test(rpcRecord.message)) return true;
  }
  if (err instanceof Error) {
    return /4001|session not found/i.test(err.message);
  }
  return false;
}

function normalizeReasoningComparable(text: string): string {
  return text
    .replace(/[`*_>#-]/g, ' ')
    .replace(/[\u2022\u25e6]/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isDuplicateReasoning(reasoning: string | undefined, answer: string | undefined): boolean {
  if (!reasoning || !answer) return false;
  const r = normalizeReasoningComparable(reasoning);
  const a = normalizeReasoningComparable(answer);
  if (!r || !a) return false;
  if (r === a) return true;
  if (a.length >= 40 && r.includes(a)) return true;
  if (r.length < 80 || a.length < 80) return false;
  return r.startsWith(a) || a.startsWith(r);
}

function toolCallKey(tool: ToolCall): string {
  return tool.id || `${tool.name}:${JSON.stringify(tool.input ?? {})}`;
}

function mergeToolCallsPreservingLocalPending(historyTools: ToolCall[] | undefined, localTools: ToolCall[] | undefined): ToolCall[] | undefined {
  const pendingLocal = (localTools ?? []).filter((tool) => tool.output === undefined);
  if (pendingLocal.length === 0) return historyTools;
  const merged = [...(historyTools ?? [])];
  const keys = new Set(merged.map(toolCallKey));
  for (const tool of pendingLocal) {
    const key = toolCallKey(tool);
    if (keys.has(key)) continue;
    merged.push(tool);
    keys.add(key);
  }
  return merged;
}

function isEmptyAssistantPlaceholder(message: Message): boolean {
  return message.role === 'assistant' && message.text.trim() === '' && (message.thinking ?? '').trim() === '';
}

function hasCompletedAssistant(turn: Message[]): boolean {
  return turn.some((m) => m.role === 'assistant' && m.text.trim() !== '');
}

/**
 * Split a transcript into turns: an optional leading run of non-user messages,
 * then one slice per user message (the user message and whatever followed it).
 */
function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (current.length > 0 || turns.length === 0) turns.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }
  turns.push(current);
  // The first slot is the pre-user lead; keep it even when empty so indexes
  // line up between history and local.
  return turns;
}

function userCount(turns: Message[][]): number {
  return turns.filter((turn) => turn[0]?.role === 'user').length;
}

/**
 * How many turns at the end of a transcript have no finished answer yet: the
 * prompt just sent and its reply still streaming (or a tool call still
 * running). Counting stops at the first turn with a completed assistant.
 */
function pendingTailCount(userTurns: Message[][]): number {
  let count = 0;
  for (let i = userTurns.length - 1; i >= 0; i -= 1) {
    const turn = userTurns[i];
    if (!turn || hasCompletedAssistant(turn)) break;
    count += 1;
  }
  return count;
}

/** A stored row's id from the database, not the index-based one given to rows without an id. */
function isStoredMessageId(id: string): boolean {
  return !/^m-\d+$/.test(id) && !/^u-/.test(id);
}

/**
 * The newest user turn both transcripts hold, matched by stored id: its index
 * in each. Undefined when they share none (then the counts decide).
 */
function sharedUserAnchor(historyUserTurns: Message[][], localUserTurns: Message[][]): { history: number; local: number } | undefined {
  const historyIndex = new Map<string, number>();
  historyUserTurns.forEach((turn, index) => {
    const id = turn[0]?.id;
    if (id && isStoredMessageId(id)) historyIndex.set(id, index);
  });
  if (historyIndex.size === 0) return undefined;
  for (let local = localUserTurns.length - 1; local >= 0; local -= 1) {
    const id = localUserTurns[local]?.[0]?.id;
    const history = id ? historyIndex.get(id) : undefined;
    if (history !== undefined) return { history, local };
  }
  return undefined;
}

function pendingToolCalls(turn: Message[]): ToolCall[] {
  return turn.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).filter((t) => t.output === undefined) : []));
}

function attachPendingToolCalls(turn: Message[], pending: ToolCall[]): Message[] {
  if (pending.length === 0) return turn;
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const message = turn[i];
    if (!message || message.role !== 'assistant') continue;
    const toolCalls = mergeToolCallsPreservingLocalPending(message.toolCalls, pending);
    if (!toolCalls || toolCalls === message.toolCalls) return turn;
    const next = [...turn];
    next[i] = { ...message, toolCalls };
    return next;
  }
  return turn;
}

/**
 * Reconcile the REST transcript (source of truth for every finished turn) with
 * the local, live transcript.
 *
 * Turns are matched by position, not by text: Hermes rewrites prompts (it
 * expands `@file:` references), stores a tool-using reply as several rows and
 * drops reasoning, so text fingerprints never line up reliably and used to
 * leave duplicates behind. Positional rules:
 *
 * - Every turn the REST transcript has is taken from REST. If REST has no
 *   completed answer yet for its last turn (tool calls still running, or the
 *   answer not persisted yet), the local assistant for that turn is kept so an
 *   in-flight reply never disappears.
 * - Local tool calls still waiting for output (approval prompts) are merged
 *   onto the matching REST assistant so inline approval UI survives a refresh.
 * - Local turns newer than anything REST knows (the prompt just sent and its
 *   streaming reply) are preserved as the tail.
 * - REST returns the newest rows only (a long session is capped), so when the
 *   local transcript holds more finished turns than REST, the alignment is
 *   anchored at the end: the oldest local turns are the ones REST dropped,
 *   not newer ones. Matching them from the front used to append every turn
 *   past the cap a second time.
 *
 * Exported as a test seam; the stores call it through refresh/load/restore.
 */
export function mergeHistoryWithLocal(history: Message[], local: Message[]): { messages: Message[]; preservedLocalTail: Message[] } {
  if (local.length === 0) {
    return { messages: history, preservedLocalTail: [] };
  }
  if (history.length === 0) {
    return { messages: local, preservedLocalTail: local };
  }

  const historyTurns = splitTurns(history);
  const localTurns = splitTurns(local);
  const covered = userCount(historyTurns);
  let localUserTurns = localTurns.filter((turn) => turn[0]?.role === 'user');
  let localLead = localTurns[0]?.[0]?.role === 'user' ? [] : localTurns[0] ?? [];
  const historyUserTurns = historyTurns.filter((turn) => turn[0]?.role === 'user');

  // How many local turns REST does not have yet. Anchored on the newest user
  // row both sides share by its stored id (a refresh gives every turn REST
  // holds its database id; a row sent since keeps its local id): local turns
  // after the anchor beyond what REST has after it are newer than REST, and
  // local turns before the anchor that REST lacks are the ones a capped REST
  // transcript dropped. A finished reply REST has not stored yet stays, which
  // a count of unfinished turns alone could not tell from a capped transcript.
  const anchor = sharedUserAnchor(historyUserTurns, localUserTurns);
  const newerThanHistory = anchor
    ? Math.max(0, localUserTurns.length - 1 - anchor.local - (historyUserTurns.length - 1 - anchor.history))
    : Math.max(0, pendingTailCount(localUserTurns) - pendingTailCount(historyUserTurns));
  const alignedLocalTurns = covered + newerThanHistory;
  let trimmed = 0;
  if (localUserTurns.length > alignedLocalTurns) {
    trimmed = localUserTurns.length - alignedLocalTurns;
    localUserTurns = localUserTurns.slice(trimmed);
    localLead = [];
  }
  // Local index of a REST turn: the anchor pins it; without one, by position.
  const offset = anchor ? anchor.local - trimmed - anchor.history : 0;

  const merged: Message[] = [];
  const preservedLocalTail: Message[] = [];

  historyTurns.forEach((turn, index) => {
    const isLast = index === historyTurns.length - 1;
    const isLead = turn[0]?.role !== 'user';
    const localTurn = isLead ? localLead : localUserTurns[index - (historyTurns[0]?.[0]?.role === 'user' ? 0 : 1) + offset] ?? [];
    let next = attachPendingToolCalls(turn, pendingToolCalls(localTurn));
    if (isLast && !hasCompletedAssistant(turn)) {
      // REST lags the live stream: keep the local assistant for this turn.
      const localAssistant = localTurn.filter((m) => m.role === 'assistant');
      const restHasAssistant = turn.some((m) => m.role === 'assistant');
      if (localAssistant.length > 0 && !restHasAssistant) {
        next = [...next, ...localAssistant];
        preservedLocalTail.push(...localAssistant);
      } else if (localAssistant.length > 0 && restHasAssistant) {
        const liveText = localAssistant.find((m) => !isEmptyAssistantPlaceholder(m));
        if (liveText) {
          // REST has the placeholder row only; the live text is newer.
          next = next.map((m) => (m.role === 'assistant' && m === next[next.length - 1] ? { ...m, text: liveText.text, ...(liveText.thinking ? { thinking: liveText.thinking } : {}) } : m));
          preservedLocalTail.push(liveText);
        }
      }
    }
    merged.push(...next);
  });

  // Local turns REST has not caught up with yet.
  const newer = localUserTurns.slice(Math.max(0, covered + offset));
  for (const turn of newer) {
    merged.push(...turn);
    preservedLocalTail.push(...turn);
  }

  return { messages: merged, preservedLocalTail };
}

function sameInput(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function sameToolCalls(a: ToolCall[] | undefined, b: ToolCall[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((tool, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      tool.id === other.id &&
      tool.name === other.name &&
      tool.output === other.output &&
      sameInput(tool.input, other.input)
    );
  });
}

function sameMessage(a: Message, b: Message): boolean {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.text === b.text &&
    a.thinking === b.thinking &&
    a.createdAt === b.createdAt &&
    a.completedAt === b.completedAt &&
    a.displayKind === b.displayKind &&
    sameToolCalls(a.toolCalls, b.toolCalls)
  );
}

/**
 * A REST refresh rebuilds every row. Hand back the previous object for each row
 * it left unchanged (and the previous array when nothing changed at all) so the
 * memoised bubbles skip re-rendering and nothing in the list remounts.
 */
export function stabilizeMessages(previous: Message[], next: Message[]): Message[] {
  if (previous === next) return next;
  const byId = new Map(previous.map((message) => [message.id, message]));
  let identical = previous.length === next.length;
  const out = next.map((message, index) => {
    const candidate = byId.get(message.id) ?? previous[index];
    if (candidate && sameMessage(candidate, message)) {
      if (candidate !== previous[index]) identical = false;
      return candidate;
    }
    identical = false;
    return message;
  });
  return identical ? previous : out;
}

function dropPendingOptimisticTail(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  if (last?.role === 'assistant' && last.text.trim() === '' && prev?.role === 'user') {
    return messages.slice(0, -2);
  }
  return messages;
}

function userFacingChatError(err: unknown, fallback: string): string {
  if (err instanceof HermesHttpError) {
    console.debug('Hermes chat request failed', err);
    if (err.status === 401 || err.status === 403) return 'Your dashboard session expired. Sign in again.';
    if (err.status === 408 || /timeout|timed out/i.test(err.message)) return 'Hermes took too long to respond. Try again.';
    if (err.status === 429) return 'Hermes is busy or rate-limited. Try again in a moment.';
    if (err.status >= 500) return 'Hermes server returned an error. Check the server logs, then try again.';
    return fallback;
  }

  if (err instanceof JsonRpcError) {
    console.debug('Hermes JSON-RPC chat request failed', err);
    if (isSessionBusyError(err)) return 'Hermes is still working on the current response. Try again in a moment.';
    if (isSessionNotFoundError(err)) return 'The chat session is no longer available. Start a new session or pick another.';
    if (/unauthorized|forbidden|401|403/i.test(err.message)) return 'Your dashboard session expired. Sign in again.';
    if (/timeout|timed out/i.test(err.message)) return 'Hermes took too long to respond. Try again.';
    return fallback;
  }

  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/failed to fetch|network|disconnected|websocket|offline/i.test(message)) {
    return 'Hermes is unreachable. Check the connection and try again.';
  }
  if (/timeout|timed out/i.test(message)) {
    return 'Hermes took too long to respond. Try again.';
  }
  return message.trim() ? message : fallback;
}

function isSessionBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  const rpcError = record.rpcError;
  if (rpcError && typeof rpcError === 'object') {
    const rpcRecord = rpcError as Record<string, unknown>;
    if (rpcRecord.code === 4009) return true;
    if (typeof rpcRecord.message === 'string' && /session busy|waiting for model response/i.test(rpcRecord.message)) {
      return true;
    }
  }
  if (err instanceof Error) {
    return /4009|session busy|waiting for model response/i.test(err.message);
  }
  return false;
}

function isSlashCommandInput(text: string): boolean {
  return /^\/\S/u.test(text.trim());
}

function parseSlashCommand(text: string): { name: string; arg: string; command: string } {
  const command = text.trim();
  const match = command.match(/^\/+([^\s]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return { name: '', arg: '', command };
  return {
    name: match[1]?.toLowerCase() ?? '',
    arg: match[2]?.trim() ?? '',
    command,
  };
}

function slashCommandBase(command: string): string {
  const trimmed = command.trim();
  const base = (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  return base;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '').trim();
}

function pwaSlashUnavailableMessage(command: string): string | null {
  const base = slashCommandBase(command);
  if (PWA_UNSUPPORTED_SLASH_COMMANDS.has(base)) {
    return `${base} is not available in PWA chat. PWA is already authenticated through the dashboard session.`;
  }
  return null;
}

function isPwaSlashSuggestion(command: string): boolean {
  return !PWA_UNSUPPORTED_SLASH_COMMANDS.has(slashCommandBase(command));
}

function slashStatusText(command: string, output: string | undefined): string {
  const body = stripAnsi(output ?? '') || '(no output)';
  return `**${command}**\n\n${body}`;
}

function renderPwaCommandsCatalog(raw: unknown): string {
  const catalog = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const lines: string[] = ['## Available commands'];
  const seen = new Set<string>();

  const formatPair = (commandValue: unknown, descriptionValue: unknown): string | null => {
    const command = typeof commandValue === 'string' ? commandValue : '';
    const base = slashCommandBase(command);
    if (!command || !isPwaSlashSuggestion(command) || seen.has(base)) return null;
    seen.add(base);
    const description = typeof descriptionValue === 'string' ? stripAnsi(descriptionValue) : '';
    return `- \`${command}\`${description ? ` — ${description}` : ''}`;
  };

  if (Array.isArray(catalog.categories)) {
    for (const category of catalog.categories) {
      if (!category || typeof category !== 'object') continue;
      const record = category as Record<string, unknown>;
      const pairs = Array.isArray(record.pairs) ? record.pairs : [];
      const entries = pairs.flatMap((pair) => {
        if (!Array.isArray(pair)) return [];
        const entry = formatPair(pair[0], pair[1]);
        return entry ? [entry] : [];
      });
      if (entries.length === 0) continue;
      const title = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Commands';
      lines.push('', `### ${title}`, ...entries);
    }
  }

  if (Array.isArray(catalog.pairs)) {
    const entries = catalog.pairs.flatMap((pair) => {
      if (!Array.isArray(pair)) return [];
      const entry = formatPair(pair[0], pair[1]);
      return entry ? [entry] : [];
    });
    if (entries.length > 0) lines.push('', '### Skills & quick commands', ...entries);
  }

  return lines.join('\n').trim();
}

function parseCommandDispatch(raw: unknown): CommandDispatchResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (type === 'exec') {
    return { type, output: typeof record.output === 'string' ? record.output : undefined };
  }
  if (type === 'plugin') {
    return { type, output: typeof record.output === 'string' ? record.output : undefined };
  }
  if (type === 'alias' && typeof record.target === 'string') {
    return { type, target: record.target };
  }
  if (type === 'skill') {
    return {
      type,
      name: typeof record.name === 'string' ? record.name : 'skill',
      message: typeof record.message === 'string' ? record.message : undefined,
    };
  }
  if (type === 'send' && typeof record.message === 'string') {
    return {
      type,
      message: record.message,
      notice: typeof record.notice === 'string' ? record.notice : undefined,
    };
  }
  return null;
}

type ChatStateAnchor = Pick<ChatStore, 'sessionId' | 'storedSessionId' | 'messages' | 'streaming'>;

function isSameChatState(state: ChatStore, anchor: ChatStateAnchor): boolean {
  return (
    state.sessionId === anchor.sessionId &&
    state.storedSessionId === anchor.storedSessionId &&
    state.messages === anchor.messages &&
    state.streaming === anchor.streaming
  );
}

function emptyActiveSessionCache(profile?: string): ActiveSessionCache {
  return { sessionId: undefined, storedSessionId: undefined, messages: [], streaming: false, profile, queuedPrompts: [] };
}

function hasCachedData(cache: Pick<ActiveSessionCache, 'sessionId' | 'storedSessionId' | 'messages' | 'queuedPrompts'>): boolean {
  return Boolean(cache.sessionId || cache.storedSessionId || cache.messages.length > 0 || cache.queuedPrompts.length > 0);
}

function queuedPromptsFromCache(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

function normalizeCacheProfile(profile: string | undefined): string | undefined {
  const trimmed = profile?.trim();
  return trimmed || undefined;
}

function resolveCacheProfile(profile: string | undefined, fallback?: string | undefined): string | undefined {
  return normalizeCacheProfile(profile) ?? normalizeCacheProfile(fallback);
}

function inFlightScopeKey(profile: string | undefined, sessionId: string | undefined, storedSessionId: string | undefined): string {
  return `${normalizeCacheProfile(profile) ?? 'default'}:${sessionId ?? storedSessionId ?? 'new'}`;
}

function activeSessionStorageKey(profile: string): string {
  return `${PROFILED_ACTIVE_SESSION_STORAGE_KEY_PREFIX}:${encodeURIComponent(profile)}`;
}

function parseActiveSessionCache(raw: string, requestedProfile?: string): ActiveSessionCache {
  const parsed = JSON.parse(raw) as Partial<ActiveSessionCache>;
  const parsedProfile = normalizeCacheProfile(parsed.profile);
  const profile = normalizeCacheProfile(requestedProfile) ?? parsedProfile;
  if (requestedProfile && parsedProfile && parsedProfile !== requestedProfile) {
    return emptyActiveSessionCache(requestedProfile);
  }
  return {
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
    storedSessionId: typeof parsed.storedSessionId === 'string' ? parsed.storedSessionId : undefined,
    messages: Array.isArray(parsed.messages) ? messagesFromResult(parsed.messages) : [],
    // A page load can never be inside a live turn: there is no in-flight
    // prompt.submit and no event stream yet. Resurrecting a persisted
    // `streaming: true` would leave the store stuck busy forever — the
    // backend turn that clears it (message.complete / session.info) is gone
    // after a dashboard or gateway restart — which locks the Composer into
    // busy/queue mode and silently swallows every message ("dead chat").
    // Streaming is re-asserted by beginAssistant() when live message events
    // resume, so starting from `false` is both safe and self-healing.
    streaming: false,
    profile,
    queuedPrompts: queuedPromptsFromCache(parsed.queuedPrompts),
  };
}

function readProfiledActiveSessionCache(profile: string): ActiveSessionCache | undefined {
  const raw = window.localStorage.getItem(activeSessionStorageKey(profile));
  if (!raw) return undefined;
  const parsed = parseActiveSessionCache(raw, profile);
  return hasCachedData(parsed) ? parsed : undefined;
}

function readFirstProfiledActiveSessionCache(): ActiveSessionCache | undefined {
  if (typeof window === 'undefined') return undefined;
  const preferredDefault = readProfiledActiveSessionCache('default');
  if (preferredDefault) return preferredDefault;
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(`${PROFILED_ACTIVE_SESSION_STORAGE_KEY_PREFIX}:`)) continue;
    const profile = decodeURIComponent(key.slice(`${PROFILED_ACTIVE_SESSION_STORAGE_KEY_PREFIX}:`.length));
    if (profile === 'default') continue;
    const parsed = readProfiledActiveSessionCache(profile);
    if (parsed) return parsed;
  }
  return undefined;
}

function readActiveSessionCache(profile?: string): ActiveSessionCache {
  const normalizedProfile = normalizeCacheProfile(profile);
  if (typeof window === 'undefined') {
    return emptyActiveSessionCache(normalizedProfile);
  }
  try {
    for (const key of LEGACY_ACTIVE_SESSION_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
    if (normalizedProfile) {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      const profiledRaw = window.localStorage.getItem(activeSessionStorageKey(normalizedProfile));
      if (!profiledRaw) return emptyActiveSessionCache(normalizedProfile);
      return parseActiveSessionCache(profiledRaw, normalizedProfile);
    }
    // No profile named (a cold start before the profiles load): the bot chosen
    // on this phone decides whose session comes up, never another bot's.
    const selectedProfile = normalizeCacheProfile(readSelectedProfile());
    if (selectedProfile) {
      return readProfiledActiveSessionCache(selectedProfile) ?? emptyActiveSessionCache(selectedProfile);
    }
    const raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (raw) return parseActiveSessionCache(raw);
    return readFirstProfiledActiveSessionCache() ?? emptyActiveSessionCache();
  } catch {
    return emptyActiveSessionCache(normalizedProfile);
  }
}

/**
 * The snapshot as JSON, with the oldest rows left out when the whole
 * transcript would not fit the size budget. Only the newest rows are needed
 * for a fast cold start; the rest is refetched from Hermes.
 */
function serializeActiveSessionCache(payload: ActiveSessionCache): string {
  const whole = JSON.stringify(payload);
  if (whole.length <= MAX_PERSISTED_TRANSCRIPT_CHARS) return whole;
  const envelope = JSON.stringify({ ...payload, messages: [] }).length;
  let budget = MAX_PERSISTED_TRANSCRIPT_CHARS - envelope;
  let keepFrom = payload.messages.length;
  for (let i = payload.messages.length - 1; i >= 0; i -= 1) {
    const size = JSON.stringify(payload.messages[i]).length + 1;
    if (size > budget) break;
    budget -= size;
    keepFrom = i;
  }
  return JSON.stringify({ ...payload, messages: payload.messages.slice(keepFrom) });
}

/**
 * Write the snapshot under `key`. When storage refuses it (quota), a stale
 * older snapshot must not stay behind: keep the session binding without the
 * transcript, and when even that fails drop the key.
 */
function writeActiveSessionCache(key: string, payload: ActiveSessionCache): void {
  try {
    window.localStorage.setItem(key, serializeActiveSessionCache(payload));
    return;
  } catch {
    // Fall through to the smaller snapshot.
  }
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...payload, messages: [] }));
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage is unusable altogether; nothing stale can be left behind either.
    }
  }
}

function persistActiveSessionNow(state: ActiveSessionPersistState): void {
  if (typeof window === 'undefined') return;
  try {
    for (const key of LEGACY_ACTIVE_SESSION_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
    const profile = normalizeCacheProfile(state.cacheProfile);
    const queuedPrompts = state.queuedPrompts ?? [];
    const hasData = hasCachedData({ ...state, queuedPrompts });
    if (profile) {
      const key = activeSessionStorageKey(profile);
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      if (!hasData) {
        window.localStorage.removeItem(key);
        return;
      }
      writeActiveSessionCache(key, {
        sessionId: state.sessionId,
        storedSessionId: state.storedSessionId,
        messages: state.messages,
        streaming: state.streaming,
        profile,
        queuedPrompts,
      });
      return;
    }
    if (!hasData) {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      return;
    }
    writeActiveSessionCache(ACTIVE_SESSION_STORAGE_KEY, {
      sessionId: state.sessionId,
      storedSessionId: state.storedSessionId,
      messages: state.messages,
      streaming: state.streaming,
      profile: undefined,
      queuedPrompts,
    });
  } catch {
    // Best-effort cache only. Hermes state.db remains the source of truth.
  }
}

function clearPendingActiveSessionPersist(): void {
  pendingActiveSessionPersist = undefined;
  if (activeSessionPersistTimer) {
    clearTimeout(activeSessionPersistTimer);
    activeSessionPersistTimer = undefined;
  }
}

function flushPendingActiveSessionPersist(): void {
  const pending = pendingActiveSessionPersist;
  clearPendingActiveSessionPersist();
  if (pending) persistActiveSessionNow(pending);
}

function ensureVisibilityFlushListener(): void {
  if (visibilityFlushListenerInstalled || typeof document === 'undefined') return;
  visibilityFlushListenerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingActiveSessionPersist();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushPendingActiveSessionPersist);
  }
}

function persistActiveSession(state: ActiveSessionPersistState): void {
  clearPendingActiveSessionPersist();
  persistActiveSessionNow(state);
}

function persistActiveSessionThrottled(state: ActiveSessionPersistState): void {
  if (!state.streaming || typeof window === 'undefined') {
    persistActiveSession(state);
    return;
  }
  pendingActiveSessionPersist = state;
  ensureVisibilityFlushListener();
  if (!activeSessionPersistTimer) {
    activeSessionPersistTimer = setTimeout(flushPendingActiveSessionPersist, ACTIVE_SESSION_PERSIST_THROTTLE_MS);
  }
}

async function resumeDurableSession(rpc: RpcClient, durableSessionId: string, profile?: string) {
  const params: Record<string, unknown> = { session_id: durableSessionId };
  if (profile) params.profile = profile;
  const raw = await rpc.request('session.resume', params, { timeoutMs: LONG_RPC_TIMEOUT_MS });
  const sessionId = liveSessionIdFromResult(raw);
  const storedSessionId = durableSessionIdFromResult(raw, durableSessionId);
  const messages = messagesFromResult(raw);
  return { sessionId, storedSessionId, messages, streaming: false, error: undefined };
}

async function createLiveSession(rpc: RpcClient, profile?: string, durableFallback?: string) {
  const createParams: Record<string, unknown> = {};
  if (profile) createParams.profile = profile;
  const created = await rpc.request('session.create', createParams);
  return {
    sessionId: liveSessionIdFromResult(created),
    storedSessionId: durableSessionIdFromResult(created, durableFallback),
  };
}

async function replaceMissingLiveSession(
  rpc: RpcClient,
  durableSessionId: string | undefined,
  profile?: string,
) {
  if (durableSessionId) {
    try {
      const resumed = await resumeDurableSession(rpc, durableSessionId, profile);
      return {
        sessionId: resumed.sessionId,
        storedSessionId: resumed.storedSessionId,
      };
    } catch (err) {
      // Durable row may have been deleted or profile lookup may fail; fall back to a fresh live session.
      if (isSessionNotFoundError(err)) {
        // The stored row is gone: a fresh session must not carry its id on
        // as if it were a continuation (history refreshes would chase it).
        return createLiveSession(rpc, profile);
      }
    }
  }
  return createLiveSession(rpc, profile, durableSessionId);
}

/**
 * The turn ended (or the chat went idle another way): send the next queued
 * prompt on the next tick, once the state that ended it has settled. Nothing
 * happens unless the shell bound a socket and something is waiting, so a
 * bare store never sends on its own.
 */
/**
 * Set when a queued prompt could not be sent: the queue waits for the next
 * successful send (or a new socket) instead of sending the prompts behind it
 * out of order, or retrying in a loop against a gateway that is down.
 */
let queueDrainPaused = false;

/**
 * A send that failed after its frame may have gone out: the socket dropped or
 * the gateway did not answer in time. It may be running anyway, so it is
 * neither handed back to the composer nor sent again from the queue.
 */
function isAmbiguousSendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return message === 'JSON-RPC request timed out' || message === 'Disconnected';
}

function afterIdle(): void {
  if (queueDrainPaused) return;
  if (queuedPromptDrainTimer !== undefined) return;
  const rpc = boundRpc;
  if (!rpc || useChatStore.getState().queuedPrompts.length === 0) return;
  queuedPromptDrainTimer = setTimeout(() => {
    queuedPromptDrainTimer = undefined;
    const state = useChatStore.getState();
    if (state.streaming || state.queuedPrompts.length === 0) return;
    void state.drainQueuedPrompt(rpc, boundProfileGetter?.());
  }, 0);
}

/**
 * Drop the optimistic rows of a prompt that was not accepted, by id, from the
 * transcript as it is now (events for another turn may have landed meanwhile).
 * Output that reached the placeholder belongs to the turn that was running,
 * whose reply row sits right above the user row: it is folded back into that
 * row, so nothing streamed is lost and the reply stays one bubble.
 */
function rollbackOptimisticTurn(
  messages: Message[],
  userRowId: string,
  assistantRowId: string,
): { messages: Message[]; receivedContent: boolean } {
  const placeholder = messages.find((message) => message.id === assistantRowId);
  const untouched = !placeholder || (isEmptyAssistantPlaceholder(placeholder) && (placeholder.toolCalls ?? []).length === 0);
  const next = messages.filter((message) => message.id !== userRowId && message.id !== assistantRowId);
  if (!placeholder || untouched) return { messages: next, receivedContent: false };

  const userIndex = messages.findIndex((message) => message.id === userRowId);
  const previous = userIndex > 0 ? messages[userIndex - 1] : undefined;
  if (!previous || previous.role !== 'assistant') {
    // Nothing to fold into: the live row stays where the stream put it.
    const kept = messages.filter((message) => message.id !== userRowId);
    return { messages: kept, receivedContent: true };
  }
  const folded: Message = { ...previous, text: previous.text + placeholder.text };
  const thinking = [previous.thinking, placeholder.thinking].filter((t): t is string => Boolean(t)).join('');
  if (thinking) folded.thinking = thinking;
  const toolCalls = [...(previous.toolCalls ?? []), ...(placeholder.toolCalls ?? [])];
  if (toolCalls.length > 0) folded.toolCalls = toolCalls;
  if (placeholder.completedAt !== undefined) folded.completedAt = placeholder.completedAt;
  return {
    messages: next.map((message) => (message.id === previous.id ? folded : message)),
    receivedContent: true,
  };
}

function resolveOpenableStoredSessionId(sessionId: string): string {
  const match = findSessionByAlias(useSessionsStore.getState().sessions, sessionId);
  return match?.id ?? sessionId;
}

function sameKnownLineage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const sessions = useSessionsStore.getState().sessions;
  const aMatch = findSessionByAlias(sessions, a);
  const bMatch = findSessionByAlias(sessions, b);
  if (!aMatch || !bMatch) return false;
  return sessionLineageKey(aMatch) === sessionLineageKey(bMatch);
}

function preserveLineageTail(opened: Awaited<ReturnType<typeof openDurableSession>>, before: ChatStateAnchor) {
  if (!sameKnownLineage(before.storedSessionId, opened.storedSessionId)) return opened;
  const merged = mergeHistoryWithLocal(opened.messages, before.messages);
  const meaningfulTail = dropPendingOptimisticTail(merged.preservedLocalTail);
  return { ...opened, messages: [...opened.messages, ...meaningfulTail] };
}

async function openDurableSession(rest: RestClient, rpc: RpcClient, durableSessionId: string, profile?: string) {
  const openableSessionId = resolveOpenableStoredSessionId(durableSessionId);
  let snapshotMessages: Message[] | undefined;
  let snapshotError: unknown;
  try {
    snapshotMessages = messagesFromResult(await rest.sessionMessages(openableSessionId, profile));
  } catch (err) {
    snapshotError = err;
  }

  try {
    const resumed = await resumeDurableSession(rpc, openableSessionId, profile);
    return {
      sessionId: resumed.sessionId,
      storedSessionId: resumed.storedSessionId ?? openableSessionId,
      messages: snapshotMessages && snapshotMessages.length > 0 ? snapshotMessages : resumed.messages,
      streaming: false,
      error: undefined,
    };
  } catch (resumeError) {
    if (snapshotMessages) {
      return {
        sessionId: undefined,
        storedSessionId: openableSessionId,
        messages: snapshotMessages,
        streaming: false,
        error: userFacingChatError(resumeError, 'Failed to resume session runtime.'),
      };
    }
    throw snapshotError ?? resumeError;
  }
}

async function refreshDurableHistory(rest: RestClient, durableSessionId: string, localMessages: Message[], profile?: string) {
  const openableSessionId = resolveOpenableStoredSessionId(durableSessionId);
  const raw = await rest.sessionMessages(openableSessionId, profile);
  const storedSessionId = storedSessionIdFromMessagesResult(raw, openableSessionId);
  const history = messagesFromResult(raw);
  const merged = openableSessionId === durableSessionId
    ? mergeHistoryWithLocal(history, localMessages)
    : { messages: history, preservedLocalTail: [] };
  return { storedSessionId, messages: merged.messages, preservedLocalTail: merged.preservedLocalTail };
}

const initialCache = readActiveSessionCache();

export const useChatStore = create<ChatStore>((set, get) => ({
  sessionId: initialCache.sessionId,
  storedSessionId: initialCache.storedSessionId,
  messages: initialCache.messages,
  streaming: initialCache.streaming,
  error: undefined,
  liveStatus: '',
  queuedPrompts: initialCache.queuedPrompts,
  lastFailedText: undefined,
  cacheProfile: initialCache.profile,

  bindRpc(rpc, getProfile) {
    boundRpc = rpc;
    boundProfileGetter = rpc ? getProfile : undefined;
    if (rpc) queueDrainPaused = false;
    if (!rpc && queuedPromptDrainTimer !== undefined) {
      clearTimeout(queuedPromptDrainTimer);
      queuedPromptDrainTimer = undefined;
    }
  },

  bindRest(rest) {
    boundRest = rest;
  },

  setLiveStatus(text) {
    if (get().liveStatus === text) return;
    set({ liveStatus: text });
  },

  enqueuePrompt(text, options) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = get().queuedPrompts;
    const next = { queuedPrompts: options?.front ? [trimmed, ...current] : [...current, trimmed] };
    set(next);
    persistActiveSession({ ...get(), ...next });
    if (!get().streaming) afterIdle();
  },

  cancelQueuedPrompt(index) {
    const current = get().queuedPrompts;
    if (index < 0 || index >= current.length) return;
    const next = { queuedPrompts: current.filter((_, i) => i !== index) };
    set(next);
    persistActiveSession({ ...get(), ...next });
  },

  async drainQueuedPrompt(rpc, profile) {
    const [text, ...rest] = get().queuedPrompts;
    if (text === undefined) return;
    const next = { queuedPrompts: rest };
    set(next);
    persistActiveSession({ ...get(), ...next });
    const result = await get().submit(rpc, text, profile);
    if (result === 'busy') {
      // Still running: the prompt waits for the next idle, ahead of the rest.
      const current = get().queuedPrompts;
      const requeued = { queuedPrompts: [text, ...current] };
      set(requeued);
      persistActiveSession({ ...get(), ...requeued });
    } else if (result === 'failed' && get().lastFailedText !== undefined) {
      // Definitely not sent: it waits at the front, the queue pauses, and the
      // composer is not handed a copy of a prompt that is still queued.
      queueDrainPaused = true;
      const current = get().queuedPrompts;
      const requeued = { queuedPrompts: [text, ...current], lastFailedText: undefined };
      set(requeued);
      persistActiveSession({ ...get(), ...requeued });
    }
  },

  switchCacheProfile(profile) {
    const target = normalizeCacheProfile(profile);
    if (!target || target === get().cacheProfile) return;
    // The previous bot's latest rows land under its own key.
    flushPendingActiveSessionPersist();
    const cached = readActiveSessionCache(target);
    const next = hasCachedData(cached) && (cached.profile ?? target) === target
      ? {
          sessionId: cached.sessionId,
          storedSessionId: cached.storedSessionId,
          messages: cached.messages,
          streaming: false,
          error: undefined,
          liveStatus: '',
          queuedPrompts: cached.queuedPrompts,
          lastFailedText: undefined,
          cacheProfile: target,
        }
      : {
          sessionId: undefined,
          storedSessionId: undefined,
          messages: [] as Message[],
          streaming: false,
          error: undefined,
          liveStatus: '',
          queuedPrompts: [] as string[],
          lastFailedText: undefined,
          cacheProfile: target,
        };
    set(next);
  },

  renameCacheProfile(from, to) {
    const source = normalizeCacheProfile(from);
    const target = normalizeCacheProfile(to);
    if (!source || !target || source === target) return;
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(activeSessionStorageKey(source));
        window.localStorage.removeItem(activeSessionStorageKey(source));
        if (raw) {
          const cached = parseActiveSessionCache(raw, source);
          if (hasCachedData(cached)) {
            writeActiveSessionCache(activeSessionStorageKey(target), { ...cached, profile: target });
          }
        }
      } catch {
        // Best-effort cache move; the chat state below is what the session runs on.
      }
    }
    if (get().cacheProfile === source) {
      set({ cacheProfile: target });
      persistActiveSession(get());
    }
  },

  forgetCacheProfile(name) {
    const profile = normalizeCacheProfile(name);
    if (!profile) return;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(activeSessionStorageKey(profile));
      } catch {
        // Nothing cached to drop.
      }
    }
    if (get().cacheProfile !== profile) return;
    set({
      sessionId: undefined,
      storedSessionId: undefined,
      messages: [],
      streaming: false,
      error: undefined,
      liveStatus: '',
      queuedPrompts: [],
      cacheProfile: undefined,
    });
  },

  setSessionId(id, storedSessionId) {
    const next = { sessionId: id, storedSessionId, messages: [] as Message[], error: undefined, liveStatus: '' };
    set(next);
    persistActiveSession({ ...get(), ...next });
  },

  async loadHistory(rest, sessionId) {
    const before = get();
    set({ streaming: false, error: undefined });
    const anchor = get();
    try {
      const raw = await rest.sessionMessages(sessionId);
      if (!isSameChatState(get(), anchor)) return;
      const history = messagesFromResult(raw);
      const sameActiveSession = before.sessionId === sessionId || before.storedSessionId === sessionId;
      const merged = sameActiveSession
        ? mergeHistoryWithLocal(history, before.messages)
        : { messages: history, preservedLocalTail: [] };
      const keepStreaming =
        sameActiveSession && before.streaming && merged.preservedLocalTail.some((m) => m.role === 'assistant');
      const next = { messages: merged.messages, streaming: keepStreaming, sessionId };
      set(next);
      persistActiveSession({ ...get(), ...next });
      if (!keepStreaming) afterIdle();
    } catch (err) {
      if (isSameChatState(get(), anchor)) {
        set({ streaming: false, error: userFacingChatError(err, 'Failed to load history.') });
      }
      throw err;
    }
  },

  async refreshHistory(rest, profile) {
    const current = get();
    // A chat that already has a session refreshes under the bot it belongs
    // to (a chat resumed from another bot, or one a bot switch is replacing);
    // taking the caller's name would file that session under the wrong bot.
    const owned = Boolean(current.cacheProfile && (current.sessionId || current.storedSessionId));
    const cacheProfile = owned ? current.cacheProfile : resolveCacheProfile(profile, current.cacheProfile);
    if (cacheProfile !== current.cacheProfile) set({ cacheProfile });
    const before = get();
    const quietFor = liveEventAgeMs();
    if (before.streaming) {
      // A turn that is still producing events is authoritative here: the REST
      // snapshot lags it, and applying it would rebuild the rows and flip
      // `streaming` off until the next event flipped it back on (the thinking
      // card and composer visibly popping every few seconds).
      if (quietFor < LIVE_STREAM_QUIET_MS) return;
      // If the WebSocket died while the app was backgrounded, `streaming` can be
      // stuck true with no live deltas arriving. The REST snapshot is the only
      // way to recover the assistant response, so a visible app does refresh.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    }
    const durableSessionId = before.storedSessionId ?? before.sessionId;
    if (!durableSessionId) return;
    const anchor = get();
    try {
      const refreshed = await refreshDurableHistory(rest, durableSessionId, before.messages, cacheProfile);
      if (!isSameChatState(get(), anchor)) return;
      // A quiet but live turn (a long tool call) stays streaming while REST has
      // no finished answer for it; once the silence is long enough to suspect a
      // lost connection, the snapshot alone decides.
      const keepStreaming =
        before.streaming &&
        quietFor < LIVE_STREAM_STALE_MS &&
        refreshed.preservedLocalTail.some((m) => m.role === 'assistant');
      const next = {
        storedSessionId: refreshed.storedSessionId,
        messages: stabilizeMessages(before.messages, refreshed.messages),
        streaming: keepStreaming,
        error: undefined,
        liveStatus: keepStreaming ? get().liveStatus : '',
      };
      set(next);
      persistActiveSession({ ...get(), ...next });
      if (!keepStreaming) afterIdle();
    } catch {
      // Best-effort background reconciliation. The cached transcript remains a
      // valid offline fallback if the REST snapshot is temporarily unavailable.
    }
  },

  async resyncLiveSession(rest, rpc, profile) {
    const { sessionId } = get();
    if (!sessionId) return 'skipped';
    const cacheProfile = resolveCacheProfile(profile, get().cacheProfile);
    let running = false;
    let openRequests: unknown;
    try {
      const live = await rpc.request<Record<string, unknown>>(
        'session.activate',
        { session_id: sessionId, omit_messages: true },
        { timeoutMs: 15_000 },
      );
      if (!live || typeof live !== 'object' || live.session_id !== sessionId) {
        throw new Error('session.activate did not return the live session');
      }
      running = live.running === true;
      openRequests = live.open_requests;
    } catch {
      // The parked session was reaped while the app was away. Drop the dead
      // runtime id; the caller reopens the durable session (restore).
      if (get().sessionId === sessionId) {
        const next = { sessionId: undefined, streaming: false };
        set(next);
        persistActiveSession({ ...get(), ...next });
      }
      return 'lost';
    }
    if (get().sessionId !== sessionId) return 'skipped';

    const lastSeen = typeof rpc.lastSeq === 'function' ? rpc.lastSeq(sessionId) : 0;
    let replayed = false;
    if (lastSeen > 0 && typeof rpc.replayEvent === 'function') {
      try {
        const result = await rpc.request<{ events?: unknown[]; truncated?: boolean }>(
          'session.events.since',
          { session_id: sessionId, last_seen: lastSeen },
          { timeoutMs: 15_000 },
        );
        if (result?.truncated !== true && Array.isArray(result?.events)) {
          for (const event of result.events) rpc.replayEvent(event);
          replayed = true;
        }
      } catch {
        // Fall through to the REST snapshot.
      }
    }
    if (!replayed) {
      // No watermark (fresh app) or the ring moved on: the stored transcript is the record.
      markLiveStreamStale();
      await get().refreshHistory(rest, cacheProfile).catch(() => undefined);
    }
    if (get().sessionId !== sessionId) return 'skipped';
    // Questions the gateway asked while the socket was down (an approval it
    // is still waiting on) come back with the snapshot; hand them to the cards,
    // and drop the cards of questions it no longer has open.
    const openRequestList = Array.isArray(openRequests) ? openRequests : [];
    if (openRequestList.length > 0 && typeof rpc.replayServerRequests === 'function') {
      rpc.replayServerRequests(openRequestList);
    }
    const openRequestIds = openRequestList
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
    useActivityStore.getState().reconcileServerRequests(sessionId, openRequestIds);
    if (running) {
      get().beginAssistant();
    } else if (get().streaming) {
      get().markIdle();
    }
    return 'attached';
  },

  async restore(rest, rpc, profile) {
    const cacheProfile = normalizeCacheProfile(profile);
    const cached = readActiveSessionCache(cacheProfile);
    if (hasCachedData(cached)) {
      set({
        sessionId: cached.sessionId,
        storedSessionId: cached.storedSessionId,
        messages: cached.messages,
        streaming: cached.streaming,
        error: undefined,
        liveStatus: '',
        queuedPrompts: cached.queuedPrompts,
        cacheProfile: cached.profile ?? cacheProfile,
      });
    } else if (cacheProfile && get().cacheProfile !== cacheProfile) {
      // Switching to a bot with nothing cached: what is in memory belongs to
      // the previous bot and must not come up under this one.
      const reset = {
        sessionId: undefined,
        storedSessionId: undefined,
        messages: [] as Message[],
        streaming: false,
        error: undefined,
        liveStatus: '',
        queuedPrompts: [] as string[],
        cacheProfile,
      };
      set(reset);
      persistActiveSession(reset);
    } else if (cacheProfile) {
      set({ cacheProfile });
    }

    const state = get();
    if (state.streaming && state.sessionId) {
      // Chat can mount while an in-memory turn is already active (route changes,
      // tests, or app-shell remounts). Do not replace the live transcript with a
      // REST snapshot/rebind while tool approvals or deltas are pending.
      return;
    }
    const liveSessionId = state.sessionId ?? cached.sessionId;
    const durableSessionId = state.storedSessionId ?? cached.storedSessionId;
    const openableDurableSessionId = durableSessionId ? resolveOpenableStoredSessionId(durableSessionId) : undefined;
    const durableAliasChanged = Boolean(durableSessionId && openableDurableSessionId && openableDurableSessionId !== durableSessionId);

    if (
      durableSessionId &&
      liveSessionId &&
      state.messages.length > 0 &&
      !durableAliasChanged
    ) {
      // Re-attach to the cached live runtime: this also tells us whether a turn
      // is still running on the Mac (the app may have been closed mid-task).
      // A reaped runtime falls through to a full durable resume below.
      const outcome = await get().resyncLiveSession(rest, rpc, cacheProfile);
      if (outcome === 'attached') {
        set({ error: undefined });
        return;
      }
      if (outcome === 'skipped') return;
    }

    if (durableSessionId) {
      const beforeOpen = get();
      set({ streaming: false, error: undefined });
      const openAnchor = get();
      try {
        const opened = await openDurableSession(rest, rpc, durableSessionId, cacheProfile);
        if (!isSameChatState(get(), openAnchor)) return;
        const nextOpened = preserveLineageTail(opened, beforeOpen);
        set(nextOpened);
        persistActiveSession({ ...get(), ...nextOpened });
        return;
      } catch (err) {
        if (isSameChatState(get(), openAnchor)) {
          set({
            sessionId: undefined,
            storedSessionId: durableSessionId,
            streaming: false,
            error: userFacingChatError(err, 'Failed to restore session.'),
            messages: beforeOpen.messages,
          });
          persistActiveSession(get());
        }
        return;
      }
    }

    if (liveSessionId) {
      // Runtime-only IDs are gateway-local. Without a durable storedSessionId we
      // cannot reliably read state.db history or rebind after reload. Preserve
      // the current in-memory/cache view and avoid guessing session.most_recent.
      return;
    }

    // Do not blindly auto-resume session.most_recent here.
    // PWA chat is often opened from a mobile/home surface where the most recent
    // human-facing Hermes session may be an external/coding/debug branch with a
    // huge tool transcript. Silently attaching the composer to that branch makes
    // a normal prompt look like a dead chat: the backend spends minutes in
    // compression/tool work and the UI only shows the thinking dots. Explicit
    // session selection still goes through resumeSessionIntoChat(); an empty
    // chat submit creates a fresh live session.
  },

  async resumeSessionIntoChat(rest, rpc, storedSessionId, profile) {
    const cacheProfile = resolveCacheProfile(profile, get().cacheProfile);
    const beforeOpen = get();
    set({ streaming: false, error: undefined, liveStatus: '', cacheProfile });
    const anchor = get();
    try {
      const opened = await openDurableSession(rest, rpc, storedSessionId, cacheProfile);
      if (!isSameChatState(get(), anchor)) return;
      const nextOpened = preserveLineageTail(opened, beforeOpen);
      set(nextOpened);
      persistActiveSession({ ...get(), ...nextOpened });
    } catch (err) {
      if (isSameChatState(get(), anchor)) {
        set({
          sessionId: undefined,
          storedSessionId,
          streaming: false,
          error: userFacingChatError(err, 'Failed to open session.'),
        });
        persistActiveSession(get());
      }
      throw err;
    }
  },

  startNewSession(profile) {
    get().clear(profile);
  },

  async ensureLiveSession(rpc, profile) {
    const cacheProfile = resolveCacheProfile(profile, get().cacheProfile);
    if (cacheProfile !== get().cacheProfile) set({ cacheProfile });
    let { sessionId, storedSessionId } = get();

    if (sessionId) {
      try {
        await rpc.request('session.usage', { session_id: sessionId });
        return { sessionId, storedSessionId };
      } catch (err) {
        if (!isSessionNotFoundError(err)) throw err;
      }
    }

    const replacement = await replaceMissingLiveSession(rpc, storedSessionId, cacheProfile);
    sessionId = replacement.sessionId;
    storedSessionId = replacement.storedSessionId;
    const nextSession = { sessionId, storedSessionId, error: undefined };
    set(nextSession);
    persistActiveSession({ ...get(), ...nextSession });
    return { sessionId, storedSessionId };
  },

  async executeSlashCommand(rpc, text, profile) {
    const cacheProfile = resolveCacheProfile(profile, get().cacheProfile);
    if (cacheProfile !== get().cacheProfile) set({ cacheProfile });
    const parsed = parseSlashCommand(text);
    if (!parsed.name) {
      const message: Message = {
        id: nextSystemMessageId(),
        role: 'system',
        text: 'Empty slash command.',
        createdAt: undefined,
      };
      const next = { messages: [...get().messages, message], streaming: false, error: undefined };
      set(next);
      persistActiveSession({ ...get(), ...next });
      return 'submitted';
    }

    const renderSlashOutput = (command: string, output: string | undefined) => {
      const message: Message = {
        id: nextSystemMessageId(),
        role: 'system',
        text: slashStatusText(command, output),
        createdAt: undefined,
      };
      const next = { messages: [...get().messages, message], streaming: false, error: undefined };
      set(next);
      persistActiveSession({ ...get(), ...next });
    };

    if (parsed.name === 'new' || parsed.name === 'reset' || parsed.name === 'clear') {
      get().clear(cacheProfile);
      return 'submitted';
    }

    const unavailable = pwaSlashUnavailableMessage(parsed.command);
    if (unavailable) {
      renderSlashOutput(parsed.command, unavailable);
      return 'failed';
    }

    if (parsed.name === 'help' || parsed.name === 'commands') {
      try {
        const catalog = await rpc.request<unknown>('commands.catalog', {});
        renderSlashOutput(parsed.command, renderPwaCommandsCatalog(catalog));
        return 'submitted';
      } catch (err) {
        const detail = userFacingChatError(err, 'Could not load command catalog.');
        renderSlashOutput(parsed.command, `error: ${detail}`);
        return 'failed';
      }
    }

    try {
      let { sessionId, storedSessionId } = get();
      if (!sessionId) {
        const replacement = await replaceMissingLiveSession(rpc, storedSessionId, cacheProfile);
        sessionId = replacement.sessionId;
        storedSessionId = replacement.storedSessionId;
        const nextSession = { sessionId, storedSessionId, streaming: false, error: undefined };
        set(nextSession);
        persistActiveSession({ ...get(), ...nextSession });
      }

      try {
        const result = await rpc.request<SlashExecResponse>(
          'slash.exec',
          {
            session_id: sessionId,
            command: parsed.command.replace(/^\/+/, ''),
          },
          { timeoutMs: LONG_RPC_TIMEOUT_MS },
        );
        const output = result?.warning ? `warning: ${result.warning}\n${result.output ?? ''}` : result?.output;
        renderSlashOutput(parsed.command, output);
        return 'submitted';
      } catch {
        // slash.exec deliberately rejects skill/send/alias and some mutating commands.
        // Fall back to the Desktop-compatible dispatcher for those structured cases.
      }

      const dispatch = parseCommandDispatch(
        await rpc.request<unknown>(
          'command.dispatch',
          { session_id: sessionId, name: parsed.name, arg: parsed.arg },
          { timeoutMs: LONG_RPC_TIMEOUT_MS },
        ),
      );

      if (!dispatch) {
        renderSlashOutput(parsed.command, 'error: invalid response: command.dispatch');
        return 'failed';
      }

      if (dispatch.type === 'exec' || dispatch.type === 'plugin') {
        renderSlashOutput(parsed.command, dispatch.output ?? '(no output)');
        return 'submitted';
      }

      if (dispatch.type === 'alias') {
        const target = dispatch.target.trim();
        if (!target) {
          renderSlashOutput(parsed.command, 'error: alias target is empty');
          return 'failed';
        }
        const sourceBase = slashCommandBase(parsed.command);
        const targetCommand = `${target.startsWith('/') ? target : `/${target}`}${parsed.arg ? ` ${parsed.arg}` : ''}`;
        const targetBase = slashCommandBase(targetCommand);
        if (
          aliasDispatchStack.length >= MAX_ALIAS_DISPATCH_DEPTH ||
          targetBase === sourceBase ||
          aliasDispatchStack.includes(targetBase)
        ) {
          renderSlashOutput(parsed.command, 'error: alias dispatch cycle detected');
          return 'failed';
        }
        aliasDispatchStack.push(sourceBase);
        try {
          return await get().executeSlashCommand(rpc, targetCommand, cacheProfile);
        } finally {
          aliasDispatchStack.pop();
        }
      }

      if (dispatch.type === 'skill') {
        const message = dispatch.message?.trim() ?? '';
        if (!message) {
          renderSlashOutput(parsed.command, `/${parsed.name}: skill payload missing message`);
          return 'failed';
        }
        // The bubble shows the command as typed; the model gets the expansion.
        return get().submit(rpc, message, cacheProfile, { displayText: parsed.command });
      }

      if (dispatch.type === 'send') {
        if (dispatch.notice) {
          renderSlashOutput(parsed.command, dispatch.notice);
        }
        const message = dispatch.message.trim();
        if (!message) {
          renderSlashOutput(parsed.command, `/${parsed.name}: empty message`);
          return 'failed';
        }
        return get().submit(rpc, message, cacheProfile);
      }

      renderSlashOutput(parsed.command, 'error: unsupported command.dispatch response');
      return 'failed';
    } catch (err) {
      const detail = userFacingChatError(err, 'Slash command failed.');
      set({ streaming: false, error: detail });
      persistActiveSession(get());
      renderSlashOutput(parsed.command, `error: ${detail}`);
      return 'failed';
    }
  },

  async submit(rpc, text, profile, options) {
    const cacheProfile = resolveCacheProfile(profile, get().cacheProfile);
    if (cacheProfile !== get().cacheProfile) set({ cacheProfile });
    if (get().lastFailedText !== undefined) set({ lastFailedText: undefined });
    if (isSlashCommandInput(text) && !options?.displayText) {
      return get().executeSlashCommand(rpc, text, cacheProfile);
    }
    const initial = get();
    const submitKey = inFlightScopeKey(cacheProfile, initial.sessionId, initial.storedSessionId);
    if (submitInFlightKeys.has(submitKey)) return 'busy';
    submitInFlightKeys.add(submitKey);
    try {

      const { sessionId, storedSessionId, streaming } = get();
      let id = sessionId;
      let durableId = storedSessionId;
      // The optimistic rows, once added; a rollback removes exactly these by
      // id from whatever the transcript holds by then.
      let userRowId: string | undefined;
      let assistantRowId: string | undefined;

      const busyRollback = (): void => {
        const rolled = userRowId && assistantRowId ? rollbackOptimisticTurn(get().messages, userRowId, assistantRowId) : { messages: get().messages };
        // The gateway is still on the previous turn; its events keep landing here.
        const rollback = {
          sessionId: id,
          storedSessionId: durableId,
          streaming: true,
          error: undefined,
          messages: rolled.messages,
        };
        set(rollback);
        persistActiveSession({ ...get(), ...rollback });
      };

      try {
        if (!id) {
          const replacement = await replaceMissingLiveSession(rpc, durableId, cacheProfile);
          id = replacement.sessionId;
          durableId = replacement.storedSessionId;
        }

        const now = Date.now();
        const userRow: Message = { id: `u-${now}`, role: 'user', text: options?.displayText ?? text, createdAt: now / 1000 };
        if (options?.displayText) userRow.displayKind = 'skill_invocation';
        const assistantRow: Message = { id: nextAssistantMessageId(), role: 'assistant', text: '', createdAt: now / 1000 };
        userRowId = userRow.id;
        assistantRowId = assistantRow.id;
        const nextMessages = [...get().messages, userRow, assistantRow];

        const optimistic = {
          sessionId: id,
          storedSessionId: durableId,
          streaming: true,
          error: undefined,
          messages: nextMessages,
        };
        set(optimistic);
        persistActiveSession({ ...get(), ...optimistic });

        try {
          await rpc.request('prompt.submit', { session_id: id, text }, { timeoutMs: PROMPT_SUBMIT_TIMEOUT_MS });
        } catch (submitErr) {
          if (isSessionBusyError(submitErr)) {
            busyRollback();
            return 'busy';
          }
          if (!isSessionNotFoundError(submitErr)) {
            throw submitErr;
          }
          const replacement = await replaceMissingLiveSession(rpc, durableId, cacheProfile);
          id = replacement.sessionId;
          durableId = replacement.storedSessionId;
          const recovered = {
            sessionId: id,
            storedSessionId: durableId,
            streaming: true,
            error: undefined,
          };
          set(recovered);
          persistActiveSession({ ...get(), ...recovered });
          try {
            await rpc.request('prompt.submit', { session_id: id, text }, { timeoutMs: PROMPT_SUBMIT_TIMEOUT_MS });
          } catch (retryErr) {
            if (isSessionBusyError(retryErr)) {
              busyRollback();
              return 'busy';
            }
            throw retryErr;
          }
        }
        queueDrainPaused = false;
        return 'submitted';
      } catch (err) {
        // Not sent: take the optimistic rows back (events of another turn that
        // reached the placeholder meanwhile stay), and keep the text so the
        // composer can offer it back. A send that may have gone out anyway
        // (the socket dropped, no answer in time) is not handed back: sending
        // it again could run it twice. The next history refresh shows it if
        // Hermes got it.
        const ambiguous = isAmbiguousSendError(err);
        const rolled = userRowId && assistantRowId
          ? rollbackOptimisticTurn(get().messages, userRowId, assistantRowId)
          : { messages: get().messages, receivedContent: false };
        const failed = {
          messages: rolled.messages,
          streaming: rolled.receivedContent ? get().streaming : streaming,
          error: ambiguous
            ? 'The connection dropped while sending. Check whether Hermes got it before sending it again.'
            : userFacingChatError(err, 'Submit failed.'),
          lastFailedText: ambiguous ? undefined : options?.displayText ?? text,
        };
        set(failed);
        persistActiveSession({ ...get(), ...failed });
        return 'failed';
      }
    } finally {
      submitInFlightKeys.delete(submitKey);
    }
  },
  async steer(rpc, text) {
    const { sessionId } = get();
    if (!sessionId) {
      set({ error: 'No active session to steer.' });
      return false;
    }
    try {
      const raw = await rpc.request('session.steer', { session_id: sessionId, text });
      const status = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).status : undefined;
      const accepted = status === undefined || status === 'queued';
      set({ error: accepted ? undefined : 'Steer rejected — message queued for next turn.' });
      return accepted;
    } catch (err) {
      set({ error: userFacingChatError(err, 'Steer failed.') });
      return false;
    }
  },

  addSteeredMessage(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    touchLiveEvent();
    set((state) => {
      const now = Date.now();
      const steered: Message = { id: `u-steer-${now}`, role: 'user', text: trimmed, createdAt: now / 1000, displayKind: 'steer' };
      const msgs = [
        ...state.messages,
        steered,
        { id: nextAssistantMessageId(), role: 'assistant' as const, text: '', createdAt: now / 1000 },
      ];
      const next = { messages: msgs, streaming: true, error: undefined };
      persistActiveSession({ ...state, ...next });
      return next;
    });
  },

  async interrupt(rpc, options) {
    const { sessionId, storedSessionId, cacheProfile } = get();
    if (!sessionId) return;
    const interruptKey = inFlightScopeKey(cacheProfile, sessionId, storedSessionId);
    if (interruptInFlightKeys.has(interruptKey)) return;
    interruptInFlightKeys.add(interruptKey);
    try {
      await rpc.request('session.interrupt', { session_id: sessionId });
      const keepStreaming = options?.keepStreaming === true;
      set({ streaming: keepStreaming, error: undefined, liveStatus: keepStreaming ? get().liveStatus : '' });
      persistActiveSession(get());
      if (!keepStreaming) afterIdle();
    } catch (err) {
      set({ error: userFacingChatError(err, 'Interrupt failed.') });
    } finally {
      interruptInFlightKeys.delete(interruptKey);
    }
  },

  appendDelta(text) {
    touchLiveEvent();
    if (!text) return;
    set((state) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, text: last.text + text };
      }
      const next = { messages: msgs };
      persistActiveSessionThrottled({ ...state, ...next });
      return next;
    });
  },

  sealSegment() {
    touchLiveEvent();
    set((state) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant' || !last.text.trim() || /\n\s*\n\s*$/u.test(last.text)) {
        return { messages: state.messages };
      }
      msgs[msgs.length - 1] = { ...last, text: `${last.text.replace(/\s+$/u, '')}\n\n` };
      const next = { messages: msgs };
      persistActiveSessionThrottled({ ...state, ...next });
      return next;
    });
  },

  finishAssistant(finalText) {
    touchLiveEvent();
    set((state) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        const final = typeof finalText === 'string' ? finalText.trim() : '';
        // `message.complete` carries the final segment only. When the stream
        // already delivered it (after interim commentary), the streamed text is
        // the fuller record; otherwise the final text wins.
        const streamedCoversFinal = final.length > 0 && last.text.trimEnd().endsWith(final);
        const text = final && !streamedCoversFinal ? final : last.text.trimEnd();
        const nextLast: Message = { ...last, text, completedAt: Date.now() / 1000 };
        if (isDuplicateReasoning(nextLast.thinking, text)) {
          delete nextLast.thinking;
        }
        msgs[msgs.length - 1] = nextLast;
      }
      const next = { streaming: false, liveStatus: '', messages: msgs };
      persistActiveSession({ ...state, ...next });
      return next;
    });
    clearRunItemsForActiveSession();
    afterIdle();
  },

  failAssistant(error) {
    set((state) => {
      const message = error || 'Hermes reported an error.';
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...last,
          text: last.text.trim() ? last.text : `Error: ${message}`,
          completedAt: Date.now() / 1000,
        };
      }
      const next = { streaming: false, liveStatus: '', error: message, messages: msgs };
      persistActiveSession({ ...state, ...next });
      return next;
    });
    clearRunItemsForActiveSession();
    afterIdle();
  },

  markIdle() {
    set((state) => {
      const next = { streaming: false, liveStatus: '' };
      persistActiveSession({ ...state, ...next });
      return next;
    });
    clearRunItemsForActiveSession();
    afterIdle();
  },

  appendToolCall(tool) {
    touchLiveEvent();
    set((state) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        const existing = (last.toolCalls ?? []).find((t) => t.id === tool.id);
        if (existing) return { messages: msgs };
        const tools = [...(last.toolCalls ?? []), tool];
        msgs[msgs.length - 1] = { ...last, toolCalls: tools };
      }
      const next = { messages: msgs };
      persistActiveSession({ ...state, ...next });
      return next;
    });
  },

  updateToolCall(id, patch) {
    touchLiveEvent();
    set((state) => {
      const msgs = state.messages.map((m) => {
        if (m.role !== 'assistant' || !m.toolCalls) return m;
        const tools = m.toolCalls.map((t) => (t.id === id ? { ...t, ...patch } : t));
        return { ...m, toolCalls: tools };
      });
      const next = { messages: msgs };
      persistActiveSession({ ...state, ...next });
      return next;
    });
  },

  appendThinking(text, replace = false) {
    touchLiveEvent();
    if (!text) return;
    set((state) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return { messages: msgs };
      const nextThinking = replace ? text : (last.thinking ?? '') + text;
      if (isDuplicateReasoning(nextThinking, last.text)) {
        const nextLast = { ...last };
        delete nextLast.thinking;
        msgs[msgs.length - 1] = nextLast;
      } else {
        msgs[msgs.length - 1] = { ...last, thinking: nextThinking };
      }
      const next = { messages: msgs };
      persistActiveSessionThrottled({ ...state, ...next });
      return next;
    });
  },

  beginAssistant() {
    touchLiveEvent();
    const current = get();
    const currentLast = current.messages[current.messages.length - 1];
    if (currentLast?.role === 'assistant' && current.streaming && current.error === undefined) {
      // Already mid-reply: every delta calls this, and a store update plus a
      // cache write per token is what made long replies stutter.
      return;
    }
    set((state) => {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        const next = { streaming: true, error: undefined };
        persistActiveSession({ ...state, ...next });
        return next;
      }
      const next = {
        streaming: true,
        error: undefined,
        messages: [
          ...state.messages,
          { id: nextAssistantMessageId(), role: 'assistant' as const, text: '', createdAt: Date.now() / 1000 },
        ],
      };
      persistActiveSession({ ...state, ...next });
      return next;
    });
  },

  noteLiveEvent() {
    touchLiveEvent();
  },

  clear(profile) {
    const cacheProfile = resolveCacheProfile(profile, get().cacheProfile);
    const next = {
      sessionId: undefined,
      storedSessionId: undefined,
      messages: [] as Message[],
      streaming: false,
      error: undefined,
      liveStatus: '',
      queuedPrompts: [] as string[],
      lastFailedText: undefined,
      cacheProfile,
    };
    set(next);
    persistActiveSession(next);
  },
}));

/**
 * The turn is over: the "running" cards the gateway's process status frames
 * raised for this session are finished too.
 */
function clearRunItemsForActiveSession(): void {
  const { sessionId, storedSessionId } = useChatStore.getState();
  const activity = useActivityStore.getState();
  if (sessionId) activity.clearRunItems(sessionId);
  if (storedSessionId && storedSessionId !== sessionId) activity.clearRunItems(storedSessionId);
}
