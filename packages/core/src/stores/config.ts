import { create } from 'zustand';
import type { HermesConfig } from '../domain/config';
import type { RestClient } from '../transport/rest';

export interface ConfigStore {
  config: HermesConfig | undefined;
  loading: boolean;
  saving: boolean;
  error: string | undefined;

  load(rest: RestClient): Promise<void>;
  /** Update a single dotted path and persist the full config. */
  update(rest: RestClient, path: string, value: unknown): Promise<void>;
  /** Merge a partial patch and persist the full config. */
  save(rest: RestClient, patch: Partial<HermesConfig>): Promise<void>;
  /** Local-only setter (does not persist). */
  setLocal(path: string, value: unknown): void;
  clear(): void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const next = clone(obj);
  const parts = path.split('.');
  let current: Record<string, unknown> = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
  return next;
}

function mergeDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const next = clone(target);
  for (const [key, value] of Object.entries(source)) {
    // null is a value (clear this setting), not a branch to recurse into.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const current = next[key];
      const existing = current !== null && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
      next[key] = mergeDeep(existing, value as Record<string, unknown>);
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: undefined,
  loading: false,
  saving: false,
  error: undefined,

  async load(rest) {
    set({ loading: true, error: undefined });
    try {
      const config = await rest.config();
      set({ config, loading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load settings';
      set({ loading: false, error: msg });
    }
  },

  async update(rest, path, value) {
    const previous = get().config;
    const current = (previous ?? {}) as Record<string, unknown>;
    const next = setPath(current, path, value);
    set({ config: next as HermesConfig });
    try {
      await get().save(rest, next as Partial<HermesConfig>);
    } catch (err) {
      // The toggle shows what the gateway has, not what it refused.
      set({ config: previous });
      throw err;
    }
  },

  async save(rest, patch) {
    const current = (get().config ?? {}) as Record<string, unknown>;
    const next = mergeDeep(current, patch as Record<string, unknown>);
    set({ saving: true, error: undefined });
    try {
      await rest.setConfig(next as HermesConfig);
      set({ config: next as HermesConfig, saving: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings';
      set({ saving: false, error: msg });
      throw err;
    }
  },

  setLocal(path, value) {
    const current = (get().config ?? {}) as Record<string, unknown>;
    const next = setPath(current, path, value);
    set({ config: next as HermesConfig });
  },

  clear() {
    set({ config: undefined, loading: false, saving: false, error: undefined });
  },
}));
