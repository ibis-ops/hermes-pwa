import { useEffect, useMemo, useState } from 'react';
import { useChatStore, useModelStore, useProfilesStore, type Profile, type ReasoningEffort, type RestClient } from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { BottomSheet } from '../components/BottomSheet';

interface ProfilesProps {
  rest: RestClient;
  /** Called once a bot has been made active and a new chat with it is open. */
  onActivated?: (() => void) | undefined;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function reasoningLabel(effort: ReasoningEffort | undefined): string {
  if (!effort) return 'Default';
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function thinkingLabel(showReasoning: boolean | undefined): string {
  if (showReasoning === true) return 'Shown';
  if (showReasoning === false) return 'Hidden';
  return 'Default';
}

export function Profiles({ rest, onActivated }: ProfilesProps) {
  const { profiles, loading, error, activeName, currentName, load, activate, create, rename, delete: deleteProfile, setModel } = useProfilesStore();
  const { options, loading: modelLoading, error: modelError, loadOptions } = useModelStore();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cloneFromDefault, setCloneFromDefault] = useState(true);
  const [creating, setCreating] = useState(false);
  const [actingName, setActingName] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [modelProfile, setModelProfile] = useState<Profile | undefined>();
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort>('high');
  const [selectedShowReasoning, setSelectedShowReasoning] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelFormError, setModelFormError] = useState<string | undefined>();

  useEffect(() => {
    void load(rest);
  }, [rest, load]);

  useEffect(() => {
    void loadOptions(rest);
  }, [rest, loadOptions]);

  const providersBySlug = useMemo(() => {
    const map = new Map<string, NonNullable<typeof options>['providers'][number]>();
    options?.providers.forEach((p) => map.set(p.slug, p));
    return map;
  }, [options]);

  function openSheet() {
    setName('');
    setDescription('');
    setCloneFromDefault(true);
    setFormError(undefined);
    setSheetOpen(true);
  }

  function closeSheet() {
    if (creating) return;
    setSheetOpen(false);
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Profile name is required');
      return;
    }
    if (!NAME_RE.test(trimmed)) {
      setFormError('Use lowercase letters, numbers, underscore or hyphen');
      return;
    }
    if (profiles.some((p) => p.name === trimmed)) {
      setFormError('Profile already exists');
      return;
    }
    setCreating(true);
    setFormError(undefined);
    const body: import('@hermes-pwa/core').ProfileCreateBody = {
      name: trimmed,
      clone_from_default: cloneFromDefault,
    };
    if (description.trim()) body.description = description.trim();
    try {
      await create(rest, body);
      closeSheet();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create profile');
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(profileName: string) {
    const nextName = window.prompt(`Rename profile "${profileName}" to:`, profileName)?.trim();
    if (!nextName || nextName === profileName) return;
    if (!NAME_RE.test(nextName)) {
      window.alert('Use lowercase letters, numbers, underscore or hyphen.');
      return;
    }
    if (profiles.some((p) => p.name === nextName)) {
      window.alert('Profile already exists.');
      return;
    }
    setActingName(profileName);
    try {
      await rename(rest, profileName, nextName);
    } finally {
      setActingName(undefined);
    }
  }

  async function handleDelete(profileName: string) {
    const confirmed = window.confirm(`Delete profile "${profileName}"? This removes that profile directory and its local state.`);
    if (!confirmed) return;
    setActingName(profileName);
    try {
      await deleteProfile(rest, profileName);
    } finally {
      setActingName(undefined);
    }
  }

  function openModelSheet(profile: Profile) {
    const providerSlug = profile.provider ?? options?.provider ?? options?.providers[0]?.slug ?? '';
    const provider = providersBySlug.get(providerSlug);
    const model = profile.model && provider?.models.includes(profile.model)
      ? profile.model
      : provider?.models[0] ?? profile.model ?? options?.model ?? '';
    setModelProfile(profile);
    setSelectedProvider(providerSlug);
    setSelectedModel(model);
    setSelectedEffort(profile.reasoningEffort ?? 'high');
    setSelectedShowReasoning(profile.showReasoning ?? false);
    setModelFormError(undefined);
  }

  function closeModelSheet() {
    if (modelSaving) return;
    setModelProfile(undefined);
    setModelFormError(undefined);
  }

  function handleProviderChange(providerSlug: string) {
    setSelectedProvider(providerSlug);
    const provider = providersBySlug.get(providerSlug);
    setSelectedModel(provider?.models[0] ?? '');
  }

  async function handleSaveModel() {
    if (!modelProfile) return;
    if (!selectedProvider || !selectedModel) {
      setModelFormError('Provider and model are required');
      return;
    }
    setModelSaving(true);
    setModelFormError(undefined);
    try {
      await setModel(rest, modelProfile.name, selectedProvider, selectedModel, selectedEffort, selectedShowReasoning);
      closeModelSheet();
    } catch (err) {
      setModelFormError(err instanceof Error ? err.message : 'Failed to update profile model');
    } finally {
      setModelSaving(false);
    }
  }

  const currentProvider = providersBySlug.get(selectedProvider);
  const modelPickerTitle = modelProfile ? `Model for ${modelProfile.displayName ?? modelProfile.name}` : 'Profile model';

  return (
    <div className="hm-agents">
      <p className="hm-agents__subtitle hm-muted">
        Each bot is a Hermes profile with its own model, personality, memory and skills. Activate one to chat with it; the main agent can also delegate work to them.
      </p>

      {error && <div className="hm-warning-banner hm-warning-banner--error">{error}</div>}
      {modelError && <div className="hm-warning-banner hm-warning-banner--error">{modelError}</div>}
      {loading && <p className="hm-muted hm-loading">Loading bots…</p>}
      <button className="hm-agents__new-btn" aria-label="New bot" onClick={openSheet}>
        <Icon name="plus" size={16} /> New bot
      </button>

      {profiles.length === 0 && !loading && (
        <button className="hm-agents__new-btn" onClick={() => void load(rest)}>
          Reload profiles
        </button>
      )}

      <div className="hm-agents__list">
        {profiles.map((p) => {
          const protectedProfile = p.name === 'default' || p.name === activeName || p.name === currentName || p.isActive;
          const acting = actingName === p.name;
          return (
            <div
              key={p.name}
              className={`hm-agent-card${p.isActive ? ' hm-agent-card--active' : ''}`}
              data-testid="agent-card"
            >
              <div className="hm-agent-card__header">
                <span className="hm-agent-card__avatar" aria-hidden="true">
                  <Icon name="robot" size={20} />
                </span>
                <div className="hm-agent-card__info">
                  <span className="hm-agent-card__name">{p.displayName ?? p.name}</span>
                  {p.isActive && (
                    <span className="hm-badge hm-badge--active" aria-label="Active profile">
                      Active
                    </span>
                  )}
                </div>
              </div>

              {p.description && <p className="hm-agent-card__desc hm-muted">{p.description}</p>}

              <div className="hm-profile-model-summary" aria-label={`Current model settings for profile ${p.name}`}>
                <div className="hm-profile-model-summary__line">
                  <span className="hm-profile-model-summary__label">Provider</span>
                  <span className="hm-profile-model-summary__value">{p.provider ?? '—'}</span>
                </div>
                <div className="hm-profile-model-summary__line">
                  <span className="hm-profile-model-summary__label">Model</span>
                  <span className="hm-profile-model-summary__value">{p.model ?? '—'}</span>
                </div>
                <div className="hm-profile-model-summary__line">
                  <span className="hm-profile-model-summary__label">Effort</span>
                  <span className="hm-profile-model-summary__value">{reasoningLabel(p.reasoningEffort)}</span>
                </div>
                <div className="hm-profile-model-summary__line">
                  <span className="hm-profile-model-summary__label">Thinking</span>
                  <span className="hm-profile-model-summary__value">{thinkingLabel(p.showReasoning)}</span>
                </div>
              </div>

              <div className="hm-agent-card__footer">
                <button
                  type="button"
                  className="hm-agent-card__model hm-agent-card__model--button"
                  onClick={() => openModelSheet(p)}
                  disabled={modelLoading || acting}
                  aria-label={`Change model for profile ${p.name}`}
                  title="Change provider, model, effort and thinking for this profile"
                >
                  <Icon name="sparkle" size={12} />
                  <span>Change model settings</span>
                  <Icon name="chevR" size={12} />
                </button>
                <div className="hm-profile-actions">
                  {p.isActive ? null : (
                    <button
                      className="hm-agent-card__activate"
                      onClick={async () => {
                        setActingName(p.name);
                        try {
                          await activate(rest, p.name);
                          useChatStore.getState().startNewSession(p.name);
                          onActivated?.();
                        } finally {
                          setActingName(undefined);
                        }
                      }}
                      aria-label={`Activate ${p.name}`}
                      disabled={acting}
                    >
                      Activate
                    </button>
                  )}
                  <button
                    type="button"
                    className="hm-row-action"
                    onClick={() => void handleRename(p.name)}
                    disabled={acting || protectedProfile}
                    aria-label={`Rename profile ${p.name}`}
                    title={protectedProfile ? 'Switch away before renaming this profile' : 'Rename profile'}
                  >
                    <Icon name="edit" size={14} />
                    <span>Rename</span>
                  </button>
                  <button
                    type="button"
                    className="hm-row-action hm-row-action--danger"
                    onClick={() => void handleDelete(p.name)}
                    disabled={acting || protectedProfile}
                    aria-label={`Delete profile ${p.name}`}
                    title={protectedProfile ? 'Default/current/active profiles are protected' : 'Delete profile'}
                  >
                    <Icon name="trash" size={14} />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {modelProfile && (
        <BottomSheet
          title={modelPickerTitle}
          onClose={closeModelSheet}
          closeDisabled={modelSaving}
          footer={
            <div className="hm-projects__inline-actions">
              <button
                type="button"
                className="hm-primary hm-projects__inline-save"
                disabled={modelSaving || !selectedProvider || !selectedModel}
                onClick={() => void handleSaveModel()}
              >
                {modelSaving ? 'Saving…' : 'Save model'}
              </button>
              <button type="button" className="hm-ghost" onClick={closeModelSheet} disabled={modelSaving}>
                Cancel
              </button>
            </div>
          }
        >
              <div className="hm-projects__field">
                <label className="hm-projects__label" htmlFor="profile-model-provider">
                  Provider
                </label>
                <select
                  id="profile-model-provider"
                  className="hm-select"
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={modelSaving}
                >
                  {options?.providers.map((provider) => (
                    <option key={provider.slug} value={provider.slug}>
                      {provider.name} {provider.authenticated ? '✓' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hm-projects__field">
                <label className="hm-projects__label" htmlFor="profile-model-model">
                  Model
                </label>
                <select
                  id="profile-model-model"
                  className="hm-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={modelSaving || !currentProvider}
                >
                  {currentProvider?.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hm-projects__field">
                <label className="hm-projects__label" htmlFor="profile-model-effort">
                  Reasoning effort
                </label>
                <select
                  id="profile-model-effort"
                  className="hm-select"
                  value={selectedEffort}
                  onChange={(e) => setSelectedEffort(e.target.value as ReasoningEffort)}
                  disabled={modelSaving}
                >
                  {REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {reasoningLabel(effort)}
                    </option>
                  ))}
                </select>
              </div>

              <label className="hm-settings-row hm-settings-row--checkbox hm-profile-thinking-toggle">
                <input
                  type="checkbox"
                  checked={selectedShowReasoning}
                  onChange={(e) => setSelectedShowReasoning(e.target.checked)}
                  disabled={modelSaving}
                />
                <span>Show thinking / reasoning in chat</span>
              </label>

              {modelFormError && <div className="hm-warning-banner hm-warning-banner--error">{modelFormError}</div>}
        </BottomSheet>
      )}

      {sheetOpen && (
        <BottomSheet
          title="New bot"
          onClose={closeSheet}
          closeDisabled={creating}
          footer={
            <div className="hm-projects__inline-actions">
              <button
                type="button"
                className="hm-primary hm-projects__inline-save"
                disabled={creating || !name.trim()}
                onClick={() => void handleCreate()}
              >
                {creating ? 'Creating…' : 'Create bot'}
              </button>
              <button type="button" className="hm-ghost" onClick={closeSheet} disabled={creating}>
                Cancel
              </button>
            </div>
          }
        >
              <div className="hm-projects__field">
                <label className="hm-projects__label" htmlFor="profile-name">
                  Name
                </label>
                <input
                  id="profile-name"
                  className="hm-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. research"
                  disabled={creating}
                  autoFocus
                />
                <p className="hm-projects__hint hm-muted">Lowercase, numbers, _ and - only.</p>
              </div>

              <div className="hm-projects__field">
                <label className="hm-projects__label" htmlFor="profile-desc">
                  Description
                </label>
                <textarea
                  id="profile-desc"
                  className="hm-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this profile for?"
                  disabled={creating}
                  rows={3}
                />
              </div>

              <label className="hm-settings-row hm-settings-row--checkbox">
                <input
                  type="checkbox"
                  checked={cloneFromDefault}
                  onChange={(e) => setCloneFromDefault(e.target.checked)}
                  disabled={creating}
                />
                <span>Clone from default</span>
              </label>

              {formError && <div className="hm-warning-banner hm-warning-banner--error">{formError}</div>}
        </BottomSheet>
      )}
    </div>
  );
}
