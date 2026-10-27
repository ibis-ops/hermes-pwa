import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useConfigStore } from './config';
import type { HermesConfig } from '../domain/config';

const makeRest = (overrides: Partial<{
  config: () => Promise<HermesConfig>;
  setConfig: (config: HermesConfig) => Promise<{ ok: boolean }>;
}> = {}) => ({
  status: vi.fn(),
  providers: vi.fn(),
  passwordLogin: vi.fn(),
  me: vi.fn(),
  wsTicket: vi.fn(),
  logout: vi.fn(),
  setActiveProfile: vi.fn(),
  kanbanBoards: vi.fn(),
  kanbanBoard: vi.fn(),
  kanbanComment: vi.fn(),
  profileList: vi.fn(),
  profileActive: vi.fn(),
  profileActivate: vi.fn(),
  systemStats: vi.fn(),
  opsRun: vi.fn(),
  opsCheckpoints: vi.fn(),
  cronJobs: vi.fn(),
  cronJobDetail: vi.fn(),
  cronJobRuns: vi.fn(),
  cronCreateJob: vi.fn(),
  cronUpdateJob: vi.fn(),
  cronPauseJob: vi.fn(),
  cronResumeJob: vi.fn(),
  cronTriggerJob: vi.fn(),
  cronDeleteJob: vi.fn(),
  cronDeliveryTargets: vi.fn(),
  profileSessions: vi.fn(),
  sessionMessages: vi.fn(),
  sessionArtifacts: vi.fn(),
  envList: vi.fn(),
  config: vi.fn().mockResolvedValue({
    model: { default: 'gpt-5.5', provider: 'openai-codex' },
    platforms: { gateway: { enabled: true } },
    approvals: { mode: 'manual', timeout: 60 },
    display: { skin: 'default', language: 'en', compact: false },
  } as HermesConfig),
  setConfig: vi.fn().mockResolvedValue({ ok: true }),
  mcpServers: vi.fn(),
  mcpToggle: vi.fn(),
  skillsList: vi.fn(),
  ...overrides,
}) as unknown as import('../transport/rest').RestClient;

describe('useConfigStore', () => {
  beforeEach(() => {
    useConfigStore.setState({ config: undefined, loading: false, saving: false, error: undefined });
  });

  it('loads config', async () => {
    const rest = makeRest();
    await useConfigStore.getState().load(rest);
    const { config, loading, error } = useConfigStore.getState();
    expect(loading).toBe(false);
    expect(error).toBeUndefined();
    expect(config?.model?.default).toBe('gpt-5.5');
    expect(config?.platforms?.gateway?.enabled).toBe(true);
  });

  it('sets error on load failure', async () => {
    const rest = makeRest({ config: vi.fn().mockRejectedValue(new Error('network error')) });
    await useConfigStore.getState().load(rest);
    expect(useConfigStore.getState().error).toBe('network error');
    expect(useConfigStore.getState().loading).toBe(false);
  });

  it('updates a dotted path and persists', async () => {
    const rest = makeRest();
    await useConfigStore.getState().load(rest);
    await useConfigStore.getState().update(rest, 'display.compact', true);
    const { config, saving, error } = useConfigStore.getState();
    expect(saving).toBe(false);
    expect(error).toBeUndefined();
    expect(config?.display?.compact).toBe(true);
    expect(rest.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ display: expect.objectContaining({ compact: true }) }),
    );
  });

  it('saves a partial patch by merging', async () => {
    const rest = makeRest();
    await useConfigStore.getState().load(rest);
    await useConfigStore.getState().save(rest, { approvals: { timeout: 120 } });
    const { config } = useConfigStore.getState();
    expect(config?.approvals?.mode).toBe('manual');
    expect(config?.approvals?.timeout).toBe(120);
    expect(rest.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ approvals: { mode: 'manual', timeout: 120 } }),
    );
  });

  it('sets error on save failure and rolls the optimistic change back', async () => {
    // A toggle that the gateway refused must not keep showing as on: the
    // next load would flip it back anyway, and meanwhile the screen lies.
    const rest = makeRest({ setConfig: vi.fn().mockRejectedValue(new Error('save failed')) });
    await useConfigStore.getState().load(rest);
    const before = useConfigStore.getState().config;
    await expect(useConfigStore.getState().update(rest, 'memory.memory_enabled', true)).rejects.toThrow('save failed');
    expect(useConfigStore.getState().error).toBe('save failed');
    expect(useConfigStore.getState().config?.memory?.memory_enabled).toBeUndefined();
    expect(useConfigStore.getState().config).toEqual(before);
    expect(useConfigStore.getState().saving).toBe(false);
  });

  it('update rolls back to an empty config when nothing had loaded', async () => {
    const rest = makeRest({ setConfig: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(useConfigStore.getState().update(rest, 'display.compact', true)).rejects.toThrow('offline');
    expect(useConfigStore.getState().config).toBeUndefined();
  });

  it('save treats null as a value to store, not a branch to merge into', async () => {
    const rest = makeRest();
    await useConfigStore.getState().load(rest);
    // Clearing a nested setting sends null; merging used to recurse into it and throw.
    await expect(useConfigStore.getState().save(rest, { approvals: null } as never)).resolves.toBeUndefined();
    expect(useConfigStore.getState().config?.approvals).toBeNull();
    expect(rest.setConfig).toHaveBeenCalledWith(expect.objectContaining({ approvals: null }));
  });

  it('save merges into a branch that is currently null instead of throwing', async () => {
    const rest = makeRest({
      config: vi.fn().mockResolvedValue({ model: { default: 'gpt-5.5' }, approvals: null } as never),
    });
    await useConfigStore.getState().load(rest);
    await useConfigStore.getState().save(rest, { approvals: { timeout: 30 } });
    expect(useConfigStore.getState().config?.approvals).toEqual({ timeout: 30 });
  });

  it('clears state', () => {
    useConfigStore.setState({
      config: { model: { default: 'x' } },
      loading: false,
      saving: false,
      error: undefined,
    });
    useConfigStore.getState().clear();
    const { config, loading, saving, error } = useConfigStore.getState();
    expect(config).toBeUndefined();
    expect(loading).toBe(false);
    expect(saving).toBe(false);
    expect(error).toBeUndefined();
  });
});
