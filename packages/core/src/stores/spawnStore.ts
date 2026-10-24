import { create } from 'zustand';
import {
  type SpawnedAgent,
  type SpawnNode,
  agentIdFromPayload,
  agentFromPayload,
  mergeAgent,
  buildSpawnTree,
} from '../domain/spawn';

/**
 * Every subagent frame the gateway relays on the parent session. The current
 * Hermes names are start / progress / thinking / tool / complete /
 * spawn_requested; the older started / update / finished / completed / failed
 * names stay accepted.
 */
export const SPAWN_EVENT_TYPES = [
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.started',
  'subagent.update',
  'subagent.progress',
  'subagent.thinking',
  'subagent.tool',
  'subagent.complete',
  'subagent.finished',
  'subagent.completed',
  'subagent.failed',
] as const;

export interface SpawnStore {
  sessionId: string | undefined;
  agents: SpawnedAgent[];
  tree: SpawnNode[];

  setSession(sessionId: string): void;
  handleEvent(type: string, payload: Record<string, unknown>): void;
  clear(): void;
}

export const useSpawnStore = create<SpawnStore>((set, get) => ({
  sessionId: undefined,
  agents: [],
  tree: [],

  setSession(sessionId) {
    if (get().sessionId === sessionId) return;
    set({ sessionId, agents: [], tree: [] });
  },

  handleEvent(type, payload) {
    const sessionId = get().sessionId;
    if (!sessionId) return;

    const payloadSession = typeof payload.session_id === 'string' ? payload.session_id : undefined;
    if (payloadSession && payloadSession !== sessionId) return;

    const id = agentIdFromPayload(payload);
    const current = get().agents;

    const upsert = (data: Record<string, unknown>): SpawnedAgent[] =>
      current.some((a) => a.id === id)
        ? current.map((a) => (a.id === id ? mergeAgent(a, data) : a))
        : [...current, agentFromPayload(data, sessionId)];

    let updated: SpawnedAgent[];
    if (type === 'subagent.spawn_requested') {
      updated = upsert({ ...payload, status: 'queued' });
    } else if (type === 'subagent.start' || type === 'subagent.started') {
      updated = upsert({ ...payload, status: 'running' });
    } else if (type === 'subagent.update' || type === 'subagent.progress' || type === 'subagent.tool' || type === 'subagent.thinking') {
      // A chunk of reasoning is not a progress line; keep the row alive without quoting it.
      updated = upsert(type === 'subagent.thinking' ? { ...payload, text: undefined, status: 'running' } : { ...payload, status: 'running' });
    } else if (type === 'subagent.complete' || type === 'subagent.finished' || type === 'subagent.completed') {
      const status = payload.status === 'failed' || payload.status === 'interrupted' ? payload.status : 'completed';
      updated = current.some((a) => a.id === id)
        ? current.map((a) => (a.id === id ? mergeAgent(a, { ...payload, status }) : a))
        : [...current, agentFromPayload({ ...payload, status }, sessionId)];
    } else if (type === 'subagent.failed') {
      updated = current.map((a) => (a.id === id ? mergeAgent(a, { ...payload, status: 'failed' }) : a));
    } else {
      return;
    }

    set({ agents: updated, tree: buildSpawnTree(updated) });
  },

  clear() {
    set({ sessionId: undefined, agents: [], tree: [] });
  },
}));
