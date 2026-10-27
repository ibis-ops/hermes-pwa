import { create } from 'zustand';
import type { Profile, ProfileActive, ProfileCreateBody, ReasoningEffort } from '../domain/profile';
import type { RestClient } from '../transport/rest';
import { useChatStore } from './chat';
import { SELECTED_PROFILE_STORAGE_KEY, readSelectedProfile, writeSelectedProfile } from './selected-profile';

export { SELECTED_PROFILE_STORAGE_KEY };

export interface ProfilesStore {
  profiles: Profile[];
  /** Profile selected in the UI (may differ from the backend's running profile). */
  activeName: string | undefined;
  /** Profile the gateway process is actually running (server-side). */
  currentName: string | undefined;
  loading: boolean;
  error: string | undefined;

  load(rest: RestClient): Promise<void>;
  activate(rest: RestClient, name: string): Promise<void>;
  create(rest: RestClient, body: ProfileCreateBody): Promise<void>;
  rename(rest: RestClient, name: string, newName: string): Promise<void>;
  delete(rest: RestClient, name: string): Promise<void>;
  setModel(rest: RestClient, name: string, provider: string, model: string, reasoningEffort?: ReasoningEffort, showReasoning?: boolean): Promise<void>;
  clear(): void;
}

export const useProfilesStore = create<ProfilesStore>((set, get) => ({
  profiles: [],
  activeName: undefined,
  currentName: undefined,
  loading: false,
  error: undefined,

  async load(rest) {
    set({ loading: true, error: undefined });
    try {
      const [profiles, active] = await Promise.all([
        rest.profileList(),
        rest.profileActive().catch(() => ({ active: undefined, current: undefined } as ProfileActive)),
      ]);
      // `current` is the running gateway profile. The bot in use here is the
      // phone's own pick when it still exists, else the gateway's sticky active profile.
      const serverActive = active.active ?? active.current ?? '';
      const currentName = active.current ?? active.active ?? '';
      const remembered = get().activeName ?? readSelectedProfile();
      const activeName = remembered && profiles.some((p) => p.name === remembered) ? remembered : serverActive;
      const normalized = profiles.map((p) => ({ ...p, isActive: p.name === activeName }));
      set({ profiles: normalized, activeName: activeName || undefined, currentName: currentName || undefined, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load profiles' });
    }
  },

  async activate(_rest, name) {
    const profiles = get().profiles.map((p) => ({ ...p, isActive: p.name === name }));
    writeSelectedProfile(name);
    set({ profiles, activeName: name, error: undefined });
  },

  async create(rest, body) {
    set({ loading: true, error: undefined });
    try {
      const result = await rest.profileCreate(body);
      if (!result.ok) throw new Error('Profile creation failed');
      await get().load(rest);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to create profile' });
      throw err;
    }
  },

  async rename(rest, name, newName) {
    set({ error: undefined });
    try {
      await rest.profileRename(name, newName);
      // The phone's choice and the chat's cached session follow the new name;
      // load() below resolves the remembered bot by activeName, so it moves first.
      if (get().activeName === name || readSelectedProfile() === name) writeSelectedProfile(newName);
      if (get().activeName === name) set({ activeName: newName });
      if (get().currentName === name) set({ currentName: newName });
      useChatStore.getState().renameCacheProfile(name, newName);
      await get().load(rest);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to rename profile' });
      throw err;
    }
  },

  async delete(rest, name) {
    set({ error: undefined });
    try {
      await rest.profileDelete(name);
      const profiles = get().profiles.filter((p) => p.name !== name);
      const activeName = get().activeName === name ? undefined : get().activeName;
      const currentName = get().currentName === name ? undefined : get().currentName;
      if (get().activeName === name) writeSelectedProfile(undefined);
      // Its sessions are gone with it; a chat open on one of them must not linger.
      useChatStore.getState().forgetCacheProfile(name);
      set({ profiles, activeName, currentName });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete profile' });
      throw err;
    }
  },

  async setModel(rest, name, provider, model, reasoningEffort, showReasoning) {
    set({ error: undefined });
    try {
      await rest.profileUpdateModel(name, {
        provider,
        model,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(showReasoning !== undefined ? { show_reasoning: showReasoning } : {}),
      });
      const profiles = get().profiles.map((p) => {
        if (p.name !== name) return p;
        return {
          ...p,
          provider,
          model,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(showReasoning !== undefined ? { showReasoning } : {}),
        };
      });
      set({ profiles });
      await get().load(rest);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to update profile model' });
      throw err;
    }
  },

  clear() {
    writeSelectedProfile(undefined);
    set({ profiles: [], activeName: undefined, currentName: undefined, loading: false, error: undefined });
  },
}));
