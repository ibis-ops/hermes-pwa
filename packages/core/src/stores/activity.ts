import { create } from 'zustand';
import { approvalFromServerRequest, clarifyFromServerRequest, type ActionItem, type Approval, type Clarify } from '../domain/activity';
import type { RpcClient, RpcEvent, ServerRequest } from '../transport/jsonrpc';
import type { RestClient } from '../transport/rest';

export interface ActivityStore {
  items: ActionItem[];
  loading: boolean;
  error: string | undefined;

  load(rest: RestClient, profile?: string): Promise<void>;
  respondApproval(
    rpc: RpcClient,
    id: string,
    decision: 'approve' | 'reject',
    sessionId?: string,
    choiceOverride?: 'once' | 'session' | 'always' | 'deny',
  ): Promise<void>;
  respondClarify(rpc: RpcClient, id: string, answer: string | Record<string, string | string[] | null>): Promise<void>;
  /**
   * Take the gateway's `approval` and `clarify` questions (server→client
   * requests) and their `request.cancel` withdrawals. Returns the detach.
   */
  attachServerRequests(rpc: RpcClient): () => void;
  dismiss(id: string): void;
  addItem(item: ActionItem): void;
  updateItem(id: string, patch: Partial<ActionItem>): void;
  /**
   * Drop the "running" cards (a gateway process status) for one session, or
   * all of them; the chat calls this when its turn ends.
   */
  clearRunItems(sessionId?: string): void;
  clear(): void;
}

function updateInPlace(items: ActionItem[], id: string, patch: Partial<ActionItem>): ActionItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i));
}

function removeById(items: ActionItem[], id: string): ActionItem[] {
  return items.filter((i) => i.id !== id);
}

/** A session reports one running process at a time; this many across sessions is plenty for the list. */
const MAX_RUN_ITEMS = 20;

/**
 * The fields a live card carries that a REST recovery record (or a repeated
 * event) may lack. When an equivalent item replaces an existing one, these
 * follow it, otherwise answering the card would lose its way back to the
 * waiting request.
 */
const CARRIED_ITEM_FIELDS = ['serverRequestId', 'requestId', 'command', 'commandComplete', 'choices', 'smartDenied', 'questions', 'sourceSessionId'] as const;

function mergeItemFields(existing: ActionItem, incoming: ActionItem): ActionItem {
  const merged: Record<string, unknown> = { ...incoming };
  const previous: Record<string, unknown> = { ...existing };
  for (const field of CARRIED_ITEM_FIELDS) {
    if (merged[field] === undefined && previous[field] !== undefined) merged[field] = previous[field];
  }
  return merged as unknown as ActionItem;
}

function sameRunItem(a: ActionItem, b: ActionItem): boolean {
  return a.kind === 'run' && b.kind === 'run' && a.sessionId === b.sessionId;
}

/** Keep the newest run items only; items are newest-first, so the oldest are at the end. */
function capRunItems(items: ActionItem[]): ActionItem[] {
  let seen = 0;
  return items.filter((item) => {
    if (item.kind !== 'run') return true;
    seen += 1;
    return seen <= MAX_RUN_ITEMS;
  });
}

const EQUIVALENT_APPROVAL_WINDOW_MS = 2 * 60_000;

function toMillis(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  // Backend pending records use epoch seconds; UI-created realtime cards use ms.
  return value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : value;
}

function approvalIds(item: ActionItem): string[] {
  return [item.sessionId, item.sourceSessionId].filter((value): value is string => Boolean(value));
}

function sameApproval(a: ActionItem, b: ActionItem): boolean {
  if (a.kind !== 'approval' || b.kind !== 'approval') return false;
  if (!a.summary || !b.summary || a.summary !== b.summary) return false;

  // The same backend approval can reach the UI twice:
  // - realtime WS event, sometimes keyed by the live UI session id;
  // - REST recovery record, keyed by the gateway approval session_key.
  // Prefer exact/source id overlap when available, but tolerate a short timing
  // window so an already-open PWA can collapse old-bundle realtime cards whose
  // id shape differs from the REST recovery record.
  const aIds = approvalIds(a);
  const bIds = approvalIds(b);
  if (aIds.some((id) => bIds.includes(id))) return true;

  const aTime = toMillis(a.createdAt);
  const bTime = toMillis(b.createdAt);
  return Boolean(aTime !== undefined && bTime !== undefined && Math.abs(aTime - bTime) <= EQUIVALENT_APPROVAL_WINDOW_MS);
}

const REALTIME_APPROVAL_REFRESH_GRACE_MS = 5_000;
const approvalResponsesInFlight = new Set<string>();

function isEquivalentItem(a: ActionItem, b: ActionItem): boolean {
  return a.id === b.id || sameApproval(a, b);
}

function mergeIncomingItems(existing: ActionItem[], incoming: ActionItem[]): ActionItem[] {
  const now = Date.now();
  const rest = existing.filter((current) => {
    const replacedByIncoming = incoming.some((item) => isEquivalentItem(item, current));
    if (replacedByIncoming) return false;

    // /actions/pending is the backend source of truth for approval cards, but
    // a websocket approval.request can arrive a moment before the REST recovery
    // file is visible to the next refresh. Keep very fresh realtime approvals
    // briefly; after that, if REST doesn't list it, the gateway queue has
    // resolved/timed out and the local card is stale.
    if (current.kind === 'approval') {
      return now - current.createdAt < REALTIME_APPROVAL_REFRESH_GRACE_MS;
    }

    return true;
  });
  // The REST record wins, but the live card's answer path survives on it.
  const merged = incoming.map((item) => {
    const replaced = existing.find((current) => isEquivalentItem(item, current));
    return replaced ? mergeItemFields(replaced, item) : item;
  });
  return [...merged, ...rest];
}

function upsertActivityItem(existing: ActionItem[], item: ActionItem): ActionItem[] {
  const replaced = existing.find((current) => isEquivalentItem(item, current) || sameRunItem(item, current));
  const next = replaced ? mergeItemFields(replaced, item) : item;
  const kept = existing.filter((current) => !isEquivalentItem(item, current) && !sameRunItem(item, current));
  return capRunItems([next, ...kept]);
}

/** A server→client answer that could not be written (the socket is down) must not lose the card. */
function respondFailedError(): string {
  return 'Could not reach Hermes to send the answer. Check the connection and try again.';
}

function isStaleApprovalError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /no pending approval for session|no pending approval/i.test(message);
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  items: [],
  loading: false,
  error: undefined,

  async load(rest, profile) {
    set({ loading: true, error: undefined });
    try {
      const items = await rest.pendingActions(profile);
      set((s) => ({
        items: mergeIncomingItems(s.items, items),
        loading: false,
      }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load pending actions.' });
    }
  },

  async respondApproval(rpc, id, decision, sessionId, choiceOverride) {
    if (approvalResponsesInFlight.has(id)) return;
    approvalResponsesInFlight.add(id);
    try {
      const item = get().items.find((i) => i.id === id);
      const choice = choiceOverride ?? (decision === 'approve' ? 'once' : 'deny');
      const approval = item && item.kind === 'approval' ? (item as Approval) : undefined;
      if (approval?.serverRequestId) {
        // The live question: the answer goes back on the socket it arrived on.
        // An answer that never left keeps the card up so it can be tried again.
        if (rpc.respond(approval.serverRequestId, { choice }) === false) {
          set({ error: respondFailedError() });
          return;
        }
        set((s) => ({ items: removeById(s.items, id) }));
        return;
      }
      const resolvedSessionId = sessionId ?? item?.sessionId;
      if (!resolvedSessionId) {
        throw new Error('Approval response requires session_id.');
      }
      await rpc.request('approval.respond', {
        choice,
        session_id: resolvedSessionId,
        ...(approval?.requestId ? { request_id: approval.requestId } : {}),
      });
      set((s) => ({ items: removeById(s.items, id) }));
    } catch (err) {
      if (isStaleApprovalError(err)) {
        const msg = 'Approval expired or was already handled.';
        set((s) => ({ items: removeById(s.items, id), error: msg }));
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to respond.';
      set({ error: msg });
      throw err;
    } finally {
      approvalResponsesInFlight.delete(id);
    }
  },

  async respondClarify(rpc, id, answer) {
    try {
      const item = get().items.find((i) => i.id === id);
      const clarify = item && item.kind === 'clarify' ? (item as Clarify) : undefined;
      if (clarify?.serverRequestId) {
        const answers =
          typeof answer === 'string'
            ? Object.fromEntries((clarify.questions ?? []).map((question, index) => [question.qid, index === 0 ? answer : null]))
            : answer;
        if (rpc.respond(clarify.serverRequestId, { answers }) === false) {
          set({ error: respondFailedError() });
          return;
        }
        set((s) => ({ items: removeById(s.items, id) }));
        return;
      }
      await rpc.request('clarify.respond', { id, answer: typeof answer === 'string' ? answer : JSON.stringify(answer) });
      set((s) => ({ items: removeById(s.items, id) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to respond.';
      set({ error: msg });
      throw err;
    }
  },

  attachServerRequests(rpc) {
    const onApproval = (request: ServerRequest) => {
      const item = approvalFromServerRequest(request.id, request.params, request.sessionId);
      set((s) => ({ items: upsertActivityItem(s.items, item) }));
      if (item.requestId && request.sessionId) {
        // Tells the gateway a client holds the prompt; best effort, the answer is what matters.
        rpc.request('approval.received', { request_id: item.requestId, session_id: request.sessionId }).catch(() => undefined);
      }
    };
    const onClarify = (request: ServerRequest) => {
      const item = clarifyFromServerRequest(request.id, request.params, request.sessionId);
      if (item.questions && item.questions.length === 0) {
        rpc.respond(request.id, { answers: {} });
        return;
      }
      set((s) => ({ items: upsertActivityItem(s.items, item) }));
    };
    const onCancel = (event: RpcEvent) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const requestId = typeof payload.id === 'string' ? payload.id : undefined;
      if (!requestId) return;
      set((s) => ({
        items: s.items.filter((item) => {
          const serverRequestId = (item as Approval | Clarify).serverRequestId;
          return serverRequestId !== requestId;
        }),
      }));
    };
    const detachApproval = rpc.onServerRequest('approval', onApproval);
    const detachClarify = rpc.onServerRequest('clarify', onClarify);
    rpc.events.addEventListener('request.cancel', onCancel);
    return () => {
      detachApproval();
      detachClarify();
      rpc.events.removeEventListener('request.cancel', onCancel);
    };
  },

  dismiss(id) {
    set((s) => ({ items: removeById(s.items, id) }));
  },

  addItem(item) {
    set((s) => ({
      items: upsertActivityItem(s.items, item),
    }));
  },

  updateItem(id, patch) {
    set((s) => ({ items: updateInPlace(s.items, id, patch) }));
  },

  clearRunItems(sessionId) {
    set((s) => {
      const items = s.items.filter((item) => item.kind !== 'run' || (sessionId !== undefined && item.sessionId !== sessionId));
      return items.length === s.items.length ? s : { items };
    });
  },

  clear() {
    set({ items: [], loading: false, error: undefined });
  },
}));
