/**
 * Typed subset of the Hermes JSON-RPC over WebSocket contract.
 * OpenAPI does not describe /api/ws, so these types are derived from
 * tui_gateway/server.py and verified at runtime by domain mappers.
 */

import type { RpcClient } from './jsonrpc';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface SessionCreateParams {
  cols?: number;
  title?: string;
  cwd?: string;
  profile?: string;
  messages?: unknown[];
  close_on_disconnect?: boolean;
}

export interface SessionIdParams {
  session_id: string;
}

export interface SessionListParams {
  limit?: number;
}

export interface PromptSubmitParams {
  session_id: string;
  text: string;
  truncate_before_user_ordinal?: number;
  /**
   * "Run after": if a turn is still running, Hermes queues the prompt behind
   * it instead of applying the busy-input mode, so it can never steer or
   * interrupt the live turn. The response's status says "queued" then.
   */
  queued?: boolean;
}

export interface SessionSteerParams extends SessionIdParams {
  text: string;
}

export interface ApprovalRespondParams {
  choice: 'once' | 'session' | 'always' | 'deny';
  session_id?: string;
}

export interface ClarifyRespondParams {
  id: string;
  answer: string;
}

export interface FileAttachParams extends SessionIdParams {
  path?: string;
  data_url?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface SessionCreateResult {
  session_id: string;
  stored_session_id?: string;
  message_count?: number;
  messages?: unknown[];
  info?: Record<string, unknown>;
}

export interface SessionListResult {
  sessions: Array<{
    id: string;
    title?: string;
    preview?: string;
    started_at?: number;
    message_count?: number;
    source?: string;
  }>;
}

export interface SessionHistoryResult {
  count: number;
  messages: unknown[];
}

export interface PromptSubmitResult {
  status: 'streaming';
}

export interface SessionMostRecentResult {
  session_id: string | null;
  title?: string;
  started_at?: number;
  source?: string;
}

export interface FileAttachResult {
  attached: boolean;
  name?: string;
  path?: string;
  ref_path?: string;
  ref_text?: string;
  uploaded?: boolean;
}

// ---------------------------------------------------------------------------
// Events (server pushes)
// ---------------------------------------------------------------------------

export interface GatewayReadyPayload {
  skin?: string;
}

export interface MessageDeltaPayload {
  text?: string;
}

export interface MessageCompletePayload {
  text?: string;
  [key: string]: unknown;
}

export interface ToolStartPayload {
  name?: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolCompletePayload {
  name?: string;
  output?: unknown;
  [key: string]: unknown;
}

export interface ApprovalRequestPayload {
  id: string;
  summary?: string;
  visibility?: string;
  highImpact?: boolean;
  [key: string]: unknown;
}

export interface ClarifyRequestPayload {
  id: string;
  question?: string;
  choices?: string[];
  [key: string]: unknown;
}

export interface StatusUpdatePayload {
  kind?: string;
  text?: string;
}

export interface ErrorPayload {
  message: string;
}

export interface NoticePayload {
  level?: string;
  message?: string;
  key?: string;
  [key: string]: unknown;
}

export interface SessionInfoPayload {
  model?: string;
  cwd?: string;
  branch?: string;
  profile_name?: string;
  [key: string]: unknown;
}

export type JsonRpcEventType =
  | 'gateway.ready'
  | 'session.info'
  | 'message.start'
  | 'message.delta'
  | 'message.complete'
  | 'tool.start'
  | 'tool.complete'
  | 'tool.generating'
  | 'thinking.delta'
  | 'reasoning.delta'
  | 'reasoning.available'
  | 'approval.request'
  | 'clarify.request'
  | 'status.update'
  | 'notice'
  | 'notice.clear'
  | 'error'
  | 'skin.changed';

// ---------------------------------------------------------------------------
// Typed RPC contract
// ---------------------------------------------------------------------------

export interface RpcContract {
  request<T>(method: string, params?: unknown): Promise<T>;

  'session.create'(params?: SessionCreateParams): Promise<SessionCreateResult>;
  'session.list'(params?: SessionListParams): Promise<SessionListResult>;
  'session.resume'(params: SessionIdParams): Promise<SessionCreateResult>;
  'session.history'(params: SessionIdParams): Promise<SessionHistoryResult>;
  'session.status'(params: SessionIdParams): Promise<Record<string, unknown>>;
  'session.interrupt'(params: SessionIdParams): Promise<Record<string, unknown>>;
  'session.steer'(params: SessionSteerParams): Promise<Record<string, unknown>>;
  'session.most_recent'(params?: Record<string, never>): Promise<SessionMostRecentResult>;

  'prompt.submit'(params: PromptSubmitParams): Promise<PromptSubmitResult>;
  'file.attach'(params: FileAttachParams): Promise<FileAttachResult>;

  'approval.respond'(params: ApprovalRespondParams): Promise<Record<string, unknown>>;
  'clarify.respond'(params: ClarifyRespondParams): Promise<Record<string, unknown>>;

  'model.options'(params?: Record<string, never>): Promise<unknown>;
  'agents.list'(params?: Record<string, never>): Promise<unknown[]>;
}

/**
 * Narrow `RpcClient` to the typed mobile subset.
 * The underlying transport still accepts any method; this is compile-time sugar.
 */
export function typedRpc(rpc: RpcClient): {
  call<K extends keyof RpcContract>(method: K, ...args: Parameters<RpcContract[K]> extends [infer P] ? [P?] : never): ReturnType<RpcContract[K]>;
} {
  return {
    call<K extends keyof RpcContract>(method: K, params?: unknown): ReturnType<RpcContract[K]> {
      return rpc.request(method as string, params) as ReturnType<RpcContract[K]>;
    },
  } as {
    call<K extends keyof RpcContract>(method: K, ...args: Parameters<RpcContract[K]> extends [infer P] ? [P?] : never): ReturnType<RpcContract[K]>;
  };
}
