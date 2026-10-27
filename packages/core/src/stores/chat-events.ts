/**
 * The live chat stream, applied to the chat store from the shell level.
 *
 * The gateway streams a turn as event frames (message.delta, tool.*, ...),
 * whatever screen is open. Handling them here, bound once by the app shell
 * instead of by the Chat screen, means leaving the chat for the approvals
 * screen no longer drops the deltas of a running turn.
 */
import type { ToolCall } from '../domain/session';
import type { RpcClient, RpcEvent } from '../transport/jsonrpc';
import type { RestClient } from '../transport/rest';
import { boundRpcClient, useChatStore } from './chat';
import { useSessionsStore } from './sessions';

export interface ChatEventOptions {
  /** The bot in use on this phone; unscoped events are accepted for it only. */
  getProfile(): string | undefined;
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
// eslint-disable-next-line no-control-regex -- strips C0/DEL bytes from legacy gateway status frames.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]+/gu;
const NON_CHAT_STATUS_KINDS = new Set(['lifecycle', 'compress', 'compressing', 'compression']);
const NON_CHAT_STATUS_TEXT = /\b(compacting context|summarizing earlier conversation|compression summary|preflight compression)\b/i;
/**
 * `tool.generating` arrives before Hermes has a tool id: the model is still
 * writing the call. It shows as a pending row under a placeholder id, and the
 * real `tool.start` takes that row over instead of adding a second one that
 * would never complete.
 */
const GENERATING_PREFIX = 'generating:';

export type EventPayload = Record<string, unknown> | undefined;

function eventPayload(event: RpcEvent): EventPayload {
  return event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : undefined;
}

/** An object as it is, a JSON object string parsed, anything else an empty record. */
export function parseMaybeObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function latestStatusSegment(value: unknown): string {
  if (typeof value !== 'string') return '';
  const withoutAnsi = value.replace(ANSI_ESCAPE_PATTERN, '');
  return withoutAnsi
    .split(/[\r\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1) ?? '';
}

/**
 * The last line of a status frame, with terminal decoration stripped: legacy
 * gateways send carriage-return animations and ANSI colours in one payload.
 */
export function cleanLiveStatus(value: unknown): string {
  return latestStatusSegment(value).replace(CONTROL_CHAR_PATTERN, ' ').replace(/\s+/gu, ' ').trim();
}

/** The reply text a message.complete payload carries, in any of the shapes gateways have used. */
export function extractMessageText(payload: EventPayload): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.rendered === 'string') return payload.rendered;
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message === 'string') return payload.message;
  if (payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)) {
    const message = payload.message as Record<string, unknown>;
    if (typeof message.text === 'string') return message.text;
    if (typeof message.content === 'string') return message.content;
    if (typeof message.rendered === 'string') return message.rendered;
  }
  return undefined;
}

/** Status frames about the session's housekeeping (compaction), not about the reply. */
export function isNonChatStatus(kind: string, payload: EventPayload): boolean {
  if (NON_CHAT_STATUS_KINDS.has(kind)) return true;
  const rawText = typeof payload?.text === 'string' ? payload.text : '';
  return NON_CHAT_STATUS_TEXT.test(rawText);
}

/** The arguments of a tool call as a tool.start payload carries them, plus its context and preview lines. */
export function extractToolInput(payload: EventPayload): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const base: Record<string, unknown> = {};
  if (typeof payload.context === 'string' && payload.context.trim()) base.context = payload.context.trim();
  if (typeof payload.preview === 'string' && payload.preview.trim()) base.preview = payload.preview.trim();
  const direct = parseMaybeObject(payload.args ?? payload.arguments);
  if (Object.keys(direct).length > 0) return { ...base, ...direct };
  const input = parseMaybeObject(payload.input);
  const fn = input.function as Record<string, unknown> | undefined;
  const nested = parseMaybeObject(input.args ?? input.arguments ?? input.parameters ?? input.input ?? fn?.arguments ?? fn?.args);
  if (Object.keys(nested).length > 0) return { ...base, ...nested };
  if (Object.keys(input).length > 0) return { ...base, ...input };
  return Object.keys(base).length > 0 ? base : undefined;
}

/**
 * Whether a frame is about the chat that is open. A frame tagged with a
 * session must name the live or stored id; an untagged one is taken only
 * while a turn is running for the bot in use.
 */
export function eventBelongsToActiveChat(event: RpcEvent, activeProfile: string | undefined): boolean {
  const { sessionId, storedSessionId, streaming, cacheProfile } = useChatStore.getState();
  if (!event.sessionId) {
    const profileMatches = !activeProfile || !cacheProfile || cacheProfile === activeProfile;
    return streaming && profileMatches && Boolean(sessionId || storedSessionId);
  }
  return event.sessionId === sessionId || event.sessionId === storedSessionId;
}

function toolExists(id: string): boolean {
  const { messages } = useChatStore.getState();
  const last = messages[messages.length - 1];
  return last?.role === 'assistant' && (last.toolCalls ?? []).some((t) => t.id === id);
}

function pendingPlaceholderId(name: string): string | undefined {
  const { messages } = useChatStore.getState();
  const last = messages[messages.length - 1];
  if (last?.role !== 'assistant') return undefined;
  return (last.toolCalls ?? []).find((t) => t.id.startsWith(`${GENERATING_PREFIX}${name}:`) && t.output === undefined)?.id;
}

function toolIdFromPayload(payload: EventPayload): string | undefined {
  return typeof payload?.tool_id === 'string' || typeof payload?.tool_id === 'number' ? String(payload.tool_id) : undefined;
}

/**
 * Apply the gateway's chat events to the chat store for as long as the shell
 * is up. Binds the transport to the store (queued prompts drain on it) and
 * returns the detach.
 */
export function attachChatEvents(rpc: RpcClient, rest: RestClient, options: ChatEventOptions): () => void {
  const chat = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState();
  const owns = (event: RpcEvent): boolean => eventBelongsToActiveChat(event, options.getProfile());

  chat().bindRpc(rpc, () => options.getProfile());
  chat().bindRest(rest);

  const refreshActiveHistory = async (): Promise<void> => {
    await useSessionsStore.getState().load(rest);
    await chat().refreshHistory(rest, options.getProfile());
  };

  const setCleanLiveStatus = (payload: EventPayload): void => {
    const text = cleanLiveStatus(payload?.text);
    if (!text) return;
    chat().setLiveStatus(text);
  };

  const onMessageStart = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
  };

  const onDelta = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const payload = eventPayload(event);
    if (payload?.text === null) {
      // Segment boundary: commentary before a tool call ends here, the final
      // answer starts a new paragraph instead of running into it.
      chat().sealSegment();
      return;
    }
    chat().appendDelta(typeof payload?.text === 'string' ? payload.text : '');
  };

  const onInterim = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const payload = eventPayload(event);
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (text && payload?.already_streamed !== true) {
      chat().appendDelta(text);
    }
    chat().sealSegment();
  };

  const onDone = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const finalText = extractMessageText(eventPayload(event));
    // finishAssistant ends the turn: the status clears and a queued prompt drains.
    chat().finishAssistant(finalText);
    chat().setLiveStatus('');
    void refreshActiveHistory();
  };

  const onToolStart = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const payload = eventPayload(event);
    const name = String(payload?.name ?? 'unknown');
    const realId = toolIdFromPayload(payload);
    const input = extractToolInput(payload);
    if (!realId) {
      if (pendingPlaceholderId(name)) return;
      const tool: ToolCall = { id: `${GENERATING_PREFIX}${name}:${Date.now()}`, name };
      if (input) tool.input = input;
      chat().appendToolCall(tool);
      return;
    }
    const tool: ToolCall = { id: realId, name };
    if (input) tool.input = input;
    const placeholder = pendingPlaceholderId(name);
    if (toolExists(realId)) {
      chat().updateToolCall(realId, tool);
    } else if (placeholder) {
      chat().updateToolCall(placeholder, tool);
    } else {
      chat().appendToolCall(tool);
    }
  };

  const onToolComplete = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const payload = eventPayload(event);
    const name = String(payload?.name ?? 'unknown');
    const id = toolIdFromPayload(payload) ?? pendingPlaceholderId(name) ?? String(Date.now());
    const result = payload?.result;
    // A todo tool's own list is the record; the result echo may lag it.
    const authoritativeTodos = Array.isArray(payload?.todos) ? { todos: payload.todos } : undefined;
    const output = authoritativeTodos
      ? JSON.stringify(authoritativeTodos)
      : typeof result === 'string'
        ? result
        : typeof result === 'object' && result !== null
          ? JSON.stringify(result)
          : undefined;
    const patch: ToolCall = { id, name };
    if (output) patch.output = output;
    if (toolExists(id)) {
      chat().updateToolCall(id, patch);
    } else {
      chat().appendToolCall(patch);
    }
  };

  const onThinkingDelta = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    setCleanLiveStatus(eventPayload(event));
  };

  const onStatusUpdate = (event: RpcEvent): void => {
    if (!owns(event)) return;
    const payload = eventPayload(event);
    const kind = typeof payload?.kind === 'string' ? payload.kind : 'status';
    if (kind === 'ready') {
      chat().setLiveStatus('');
      return;
    }
    if (isNonChatStatus(kind, payload)) return;
    const { messages, streaming } = chat();
    const last = messages[messages.length - 1];
    if (!streaming || last?.role !== 'assistant') return;
    chat().noteLiveEvent();
    setCleanLiveStatus(payload);
  };

  const onReasoningDelta = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const payload = eventPayload(event);
    chat().appendThinking(typeof payload?.text === 'string' ? payload.text : '');
  };

  const onReasoningAvailable = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const payload = eventPayload(event);
    chat().appendThinking(typeof payload?.text === 'string' ? payload.text : '', true);
  };

  const onError = (event: RpcEvent): void => {
    if (!owns(event)) return;
    chat().beginAssistant();
    const payload = eventPayload(event);
    const message = typeof payload?.message === 'string' ? payload.message : 'Hermes reported an error.';
    chat().failAssistant(message);
    chat().setLiveStatus('');
    void useSessionsStore.getState().load(rest);
  };

  const onSessionInfo = (event: RpcEvent): void => {
    if (!owns(event)) return;
    const payload = eventPayload(event);
    if (payload?.running === false) {
      chat().markIdle();
      chat().setLiveStatus('');
      void refreshActiveHistory();
    }
  };

  const listeners: [string, (event: RpcEvent) => void][] = [
    ['message.start', onMessageStart],
    ['message.delta', onDelta],
    ['message.interim', onInterim],
    ['message.complete', onDone],
    ['tool.start', onToolStart],
    ['tool.progress', onToolStart],
    ['tool.generating', onToolStart],
    ['tool.complete', onToolComplete],
    ['thinking.delta', onThinkingDelta],
    ['status.update', onStatusUpdate],
    ['reasoning.delta', onReasoningDelta],
    ['reasoning.available', onReasoningAvailable],
    ['error', onError],
    ['session.info', onSessionInfo],
  ];
  for (const [type, handler] of listeners) rpc.events.addEventListener(type, handler);

  return () => {
    for (const [type, handler] of listeners) rpc.events.removeEventListener(type, handler);
    // A later attach may already have bound a newer transport; leave that one alone.
    if (boundRpcClient() === rpc) {
      chat().bindRpc(undefined);
      chat().bindRest(undefined);
    }
  };
}
