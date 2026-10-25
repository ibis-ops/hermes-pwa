import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useProfilesStore } from './profiles';

const makeRest = (overrides: Partial<{
  profileList: () => Promise<import('../domain/profile').Profile[]>;
  profileActive: () => Promise<import('../domain/profile').ProfileActive>;
  profileActivate: (name: string) => Promise<void>;
  profileCreate: (body: import('../domain/profile').ProfileCreateBody) => Promise<import('../domain/profile').ProfileCreateResult>;
  profileRename: (name: string, newName: string) => Promise<void>;
  profileDelete: (name: string) => Promise<void>;
  profileUpdateModel: (name: string, body: { provider: string; model: string; reasoning_effort?: import('../domain/profile').ReasoningEffort; show_reasoning?: boolean }) => Promise<import('../domain/model').ModelAssignmentResult>;
}> = {}) => ({
  status: vi.fn(),
  providers: vi.fn(),
  passwordLogin: vi.fn(),
  me: vi.fn(),
  wsTicket: vi.fn(),
  logout: vi.fn(),
  kanbanBoards: vi.fn(),
  kanbanBoard: vi.fn(),
  kanbanComment: vi.fn(),
  profileList: vi.fn().mockResolvedValue([
    { name: 'default', model: 'claude-opus-4-8', isActive: true },
    { name: 'research', model: 'gpt-4o', isActive: false },
  ]),
  profileActive: vi.fn().mockResolvedValue({ active: 'research', current: 'default' }),
  profileActivate: vi.fn().mockResolvedValue(undefined),
  profileCreate: vi.fn().mockResolvedValue({ ok: true, name: 'ops' }),
  profileRename: vi.fn().mockResolvedValue(undefined),
  profileDelete: vi.fn().mockResolvedValue(undefined),
  profileUpdateModel: vi.fn().mockResolvedValue({ ok: true, provider: 'anthropic', model: 'claude-sonnet-4' }),
  ...overrides,
}) as unknown as import('../transport/rest').RestClient;

describe('useProfilesStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProfilesStore.setState({ profiles: [], activeName: undefined, currentName: undefined, loading: false, error: undefined });
  });

  it('loads profiles and marks active', async () => {
    const rest = makeRest();
    await useProfilesStore.getState().load(rest);
    const { profiles, activeName, currentName } = useProfilesStore.getState();
    expect(profiles).toHaveLength(2);
    expect(activeName).toBe('research');
    expect(currentName).toBe('default');
    expect(profiles.find((p) => p.name === 'default')?.isActive).toBe(false);
    expect(profiles.find((p) => p.name === 'research')?.isActive).toBe(true);
  });

  it('handles profileActive failure gracefully', async () => {
    const rest = makeRest({ profileActive: vi.fn().mockRejectedValue(new Error('no active')) });
    await useProfilesStore.getState().load(rest);
    const { profiles, activeName, currentName } = useProfilesStore.getState();
    expect(profiles).toHaveLength(2);
    expect(activeName).toBeUndefined();
    expect(currentName).toBeUndefined();
  });

  it('activates a profile on this device only and remembers it across loads', async () => {
    const rest = makeRest();
    await useProfilesStore.getState().load(rest);
    await useProfilesStore.getState().activate(rest, 'research');
    const { profiles, activeName, currentName } = useProfilesStore.getState();
    expect(activeName).toBe('research');
    expect(currentName).toBe('default');
    expect(profiles.find((p) => p.name === 'research')?.isActive).toBe(true);
    expect(profiles.find((p) => p.name === 'default')?.isActive).toBe(false);
    // The Mac's sticky active profile (and so the hermes CLI default) is left alone.
    expect(rest.profileActivate).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('hermes-pwa.selectedProfile.v1')).toBe('research');

    useProfilesStore.setState({ profiles: [], activeName: undefined, currentName: undefined });
    await useProfilesStore.getState().load(rest);
    expect(useProfilesStore.getState().activeName).toBe('research');
  });

  it('falls back to the gateway profile when the remembered bot no longer exists', async () => {
    window.localStorage.setItem('hermes-pwa.selectedProfile.v1', 'gone');
    const rest = makeRest({ profileActive: vi.fn().mockResolvedValue({ active: 'default', current: 'default' }) });
    await useProfilesStore.getState().load(rest);
    expect(useProfilesStore.getState().activeName).toBe('default');
  });

  it('creates a profile and reloads list', async () => {
    const rest = makeRest();
    await useProfilesStore.getState().load(rest);
    await useProfilesStore.getState().create(rest, { name: 'ops', clone_from_default: true });
    expect(rest.profileCreate).toHaveBeenCalledWith({ name: 'ops', clone_from_default: true });
    expect(useProfilesStore.getState().profiles).toHaveLength(2);
  });

  it('sets error on create failure', async () => {
    const rest = makeRest({ profileCreate: vi.fn().mockRejectedValue(new Error('name taken')) });
    await expect(useProfilesStore.getState().create(rest, { name: 'ops' })).rejects.toThrow('name taken');
    expect(useProfilesStore.getState().error).toBe('name taken');
  });

  it('renames a profile and reloads the list', async () => {
    const rest = makeRest();
    await useProfilesStore.getState().rename(rest, 'research', 'research-v2');
    expect(rest.profileRename).toHaveBeenCalledWith('research', 'research-v2');
    expect(rest.profileList).toHaveBeenCalled();
  });

  it('deletes a profile from local state', async () => {
    const rest = makeRest();
    await useProfilesStore.getState().load(rest);
    await useProfilesStore.getState().delete(rest, 'research');
    expect(rest.profileDelete).toHaveBeenCalledWith('research');
    expect(useProfilesStore.getState().profiles.map((p) => p.name)).toEqual(['default']);
  });

  it('updates a profile model through the scoped profile endpoint and reloads profiles', async () => {
    const rest = makeRest();
    await useProfilesStore.getState().load(rest);
    await useProfilesStore.getState().setModel(rest, 'research', 'kimi-coding', 'kimi-k2.6', 'high', true);
    expect(rest.profileUpdateModel).toHaveBeenCalledWith('research', {
      provider: 'kimi-coding',
      model: 'kimi-k2.6',
      reasoning_effort: 'high',
      show_reasoning: true,
    });
    expect(rest.profileList).toHaveBeenCalledTimes(2);
  });

  it('sets error on load failure', async () => {
    const rest = makeRest({ profileList: vi.fn().mockRejectedValue(new Error('network error')) });
    await useProfilesStore.getState().load(rest);
    expect(useProfilesStore.getState().error).toBe('network error');
    expect(useProfilesStore.getState().loading).toBe(false);
  });

  it('clears state', async () => {
    const rest = makeRest();
    await useProfilesStore.getState().load(rest);
    useProfilesStore.getState().clear();
    const { profiles, activeName, currentName, loading, error } = useProfilesStore.getState();
    expect(profiles).toHaveLength(0);
    expect(activeName).toBeUndefined();
    expect(currentName).toBeUndefined();
    expect(loading).toBe(false);
    expect(error).toBeUndefined();
  });
});
