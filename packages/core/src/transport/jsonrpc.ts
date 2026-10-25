/**
 * JSON-RPC 2.0 over WebSocket — newline-delimited.
 * Request/response correlation by id + event frame dispatch.
 * No DOM APIs (EventTarget/CustomEvent) — works in any JS runtime.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string;
  result?: unknown;
  error?: unknown;
}

function formatRpcError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const code = record.code !== undefined ? `${String(record.code)} ` : '';
    const message = typeof record.message === 'string' ? record.message : JSON.stringify(record);
    return `${code}${message}`.trim();
  }
  return 'JSON-RPC request failed';
}

export class JsonRpcError extends Error {
  readonly rpcError: unknown;

  constructor(error: unknown) {
    super(formatRpcError(error));
    this.name = 'JsonRpcError';
    this.rpcError = error;
  }
}

export interface JsonRpcEvent {
  jsonrpc: '2.0';
  method: 'event';
  params: {
    type: string;
    session_id?: string;
    payload?: unknown;
    /** Server-owned per-session sequence number; the replay ring is keyed on it. */
    seq?: number;
  };
}

export type RpcSend = (message: string) => void;

export interface RpcEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
  seq?: number;
}

export type RpcEventHandler = (event: RpcEvent) => void;

const KNOWN_GATEWAY_EVENT_TYPES = new Set([
  'gateway.ready',
  'session.info',
  'message.start',
  'message.delta',
  'message.complete',
  'tool.start',
  'tool.complete',
  'tool.generating',
  'tool.progress',
  'thinking.delta',
  'reasoning.delta',
  'reasoning.available',
  'approval.request',
  'clarify.request',
  'request.cancel',
  'status.update',
  'notice',
  'notice.clear',
  'error',
  'skin.changed',
]);

function isKnownGatewayEventType(type: string): boolean {
  return KNOWN_GATEWAY_EVENT_TYPES.has(type);
}

export interface RpcEvents {
  addEventListener(type: string, handler: RpcEventHandler): void;
  removeEventListener(type: string, handler: RpcEventHandler): void;
  dispatchEvent(event: RpcEvent): void;
}

export interface RpcRequestOptions {
  /** Override the client's default response timeout for one long/short request. */
  timeoutMs?: number;
}

/**
 * A question the gateway asks this client (JSON-RPC is peer to peer): an
 * approval to grant, a clarify to answer. The frame carries the server's own
 * id (`srq-…`); the answer is a response frame with that id. A request the
 * client does not handle is answered -32601 at once so the agent fails fast
 * instead of waiting out its deadline.
 */
export interface ServerRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  sessionId: string | undefined;
  /** Re-delivered from a reconnect snapshot (`open_requests`), not freshly asked. */
  replayed: boolean;
}

export type ServerRequestHandler = (request: ServerRequest) => void;

export const METHOD_NOT_FOUND = -32601;

export interface RpcClient {
  request<T>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T>;
  onFrame(line: string): void;
  events: RpcEvents;
  disconnect(): void;
  /** Highest event sequence seen for a session (0 when none); the watermark for `session.events.since`. */
  lastSeq(sessionId: string): number;
  /** Feed one replayed event object (the frame's `params`) through the normal event path. */
  replayEvent(raw: unknown): void;
  /** `replay_epoch` from the last gateway.ready; a change means the gateway restarted and watermarks are void. */
  replayEpoch(): string | undefined;
  /** Handle one kind of server→client request (`approval`, `clarify`, ...). Returns the unsubscribe. */
  onServerRequest(method: string, handler: ServerRequestHandler): () => void;
  /** Answer a server→client request. */
  respond(requestId: string, result: Record<string, unknown>): void;
  /** Refuse a server→client request (`METHOD_NOT_FOUND` for one this client cannot answer). */
  respondError(requestId: string, code: number, message: string): void;
  /** Re-deliver the `open_requests` a reconnect snapshot carried, as if they had just arrived. */
  replayServerRequests(raw: unknown): void;
}

export function makeRpcEvents(): RpcEvents {
  const listeners = new Map<string, Set<RpcEventHandler>>();

  return {
    addEventListener(type, handler) {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.forEach((h) => h(event));
    },
  };
}

export interface RpcClientOptions {
  timeoutMs?: number;
}

export function makeRpcClient(send: RpcSend, options: RpcClientOptions = {}): RpcClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pending = new Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void; timeoutId?: ReturnType<typeof setTimeout> }>();
  const events = makeRpcEvents();
  let counter = 0;
  const lastSeqBySession = new Map<string, number>();
  let epoch: string | undefined;
  const serverRequestHandlers = new Map<string, Set<ServerRequestHandler>>();

  function writeFrame(frame: Record<string, unknown>): void {
    try {
      send(JSON.stringify(frame) + '\n');
    } catch (error) {
      console.warn('[Hermes PWA] could not answer a server request', error);
    }
  }

  function respond(requestId: string, result: Record<string, unknown>): void {
    writeFrame({ jsonrpc: '2.0', id: requestId, result });
  }

  function respondError(requestId: string, code: number, message: string): void {
    writeFrame({ jsonrpc: '2.0', id: requestId, error: { code, message } });
  }

  function deliverServerRequest(id: string, method: string, params: Record<string, unknown>, replayed: boolean): void {
    const handlers = serverRequestHandlers.get(method);
    if (!handlers || handlers.size === 0) {
      respondError(id, METHOD_NOT_FOUND, `This client does not answer ${method} requests.`);
      return;
    }
    const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
    const request: ServerRequest = { id, method, params, sessionId, replayed };
    handlers.forEach((handler) => {
      try {
        handler(request);
      } catch (error) {
        console.warn(`[Hermes PWA] server request handler for ${method} failed`, error);
      }
    });
  }

  function replayServerRequests(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : undefined;
      const method = typeof record.method === 'string' ? record.method : undefined;
      if (!id || !method) continue;
      const params = record.params && typeof record.params === 'object' ? (record.params as Record<string, unknown>) : {};
      deliverServerRequest(id, method, params, true);
    }
  }

  function dispatchEventParams(params: JsonRpcEvent['params']): void {
    if (!isKnownGatewayEventType(params.type)) {
      console.warn(`[Hermes PWA] Unknown gateway event type: ${params.type}`);
    }
    if (params.type === 'gateway.ready') {
      const next = (params.payload as { replay_epoch?: unknown } | undefined)?.replay_epoch;
      if (typeof next === 'string' && next !== epoch) {
        if (epoch !== undefined) lastSeqBySession.clear();
        epoch = next;
      }
    }
    const event: RpcEvent = { type: params.type, payload: params.payload };
    if (typeof params.session_id === 'string') {
      event.sessionId = params.session_id;
      if (typeof params.seq === 'number' && Number.isFinite(params.seq)) {
        event.seq = params.seq;
        if (params.seq > (lastSeqBySession.get(params.session_id) ?? 0)) lastSeqBySession.set(params.session_id, params.seq);
      }
    }
    events.dispatchEvent(event);
  }

  function settle(id: string, action: (entry: { resolve: (result: unknown) => void; reject: (err: Error) => void }) => void): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    action(entry);
  }

  function request<T>(method: string, params?: unknown, requestOptions: RpcRequestOptions = {}): Promise<T> {
    const id = String(++counter);
    return new Promise<T>((resolve, reject) => {
      const requestTimeoutMs = requestOptions.timeoutMs ?? timeoutMs;
      const timeoutId =
        requestTimeoutMs > 0
          ? setTimeout(() => {
              settle(id, ({ reject: rejectPending }) => rejectPending(new Error('JSON-RPC request timed out')));
            }, requestTimeoutMs)
          : undefined;
      const pendingEntry: { resolve: (result: unknown) => void; reject: (err: Error) => void; timeoutId?: ReturnType<typeof setTimeout> } = {
        resolve: resolve as (result: unknown) => void,
        reject,
      };
      if (timeoutId) {
        pendingEntry.timeoutId = timeoutId;
      }
      pending.set(id, pendingEntry);
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      try {
        send(JSON.stringify(req) + '\n');
      } catch (error) {
        settle(id, ({ reject: rejectPending }) => rejectPending(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  function onFrame(line: string): void {
    if (!line.trim()) return;
    let frame: JsonRpcResponse | JsonRpcEvent;
    try {
      frame = JSON.parse(line) as JsonRpcResponse | JsonRpcEvent;
    } catch {
      return;
    }

    if ('id' in frame && frame.id !== undefined && pending.has(frame.id)) {
      settle(frame.id, ({ resolve, reject }) => {
        if ('error' in frame && frame.error !== undefined) {
          reject(new JsonRpcError(frame.error));
        } else {
          resolve(frame.result);
        }
      });
      return;
    }

    if ('method' in frame && frame.method === 'event' && 'params' in frame) {
      const evt = frame as JsonRpcEvent;
      if (evt.params && typeof evt.params === 'object' && typeof evt.params.type === 'string') {
        dispatchEventParams(evt.params);
      }
      return;
    }

    // A frame with its own id and a method is the gateway asking us something.
    if ('method' in frame && typeof frame.method === 'string' && 'id' in frame && typeof frame.id === 'string') {
      const request = frame as unknown as { id: string; method: string; params?: unknown };
      const params = request.params && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
      deliverServerRequest(request.id, request.method, params, false);
    }
  }

  function replayEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const params = raw as JsonRpcEvent['params'];
    if (typeof params.type !== 'string') return;
    dispatchEventParams(params);
  }

  function disconnect(): void {
    for (const [id] of pending) {
      settle(id, ({ reject }) => reject(new Error('Disconnected')));
    }
  }

  return {
    request,
    onFrame,
    events,
    disconnect,
    lastSeq: (sessionId) => lastSeqBySession.get(sessionId) ?? 0,
    replayEvent,
    replayEpoch: () => epoch,
    onServerRequest(method, handler) {
      const set = serverRequestHandlers.get(method) ?? new Set<ServerRequestHandler>();
      set.add(handler);
      serverRequestHandlers.set(method, set);
      return () => {
        set.delete(handler);
      };
    },
    respond,
    respondError,
    replayServerRequests,
  };
}
