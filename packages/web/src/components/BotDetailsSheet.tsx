import { useEffect, useMemo, useState } from 'react';
import { botLabel, useModelStore, useProfilesStore, type Profile, type ReasoningEffort, type RestClient } from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { BotAvatar } from './BotAvatar';
import { Icon } from './Icon';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function reasoningLabel(effort: ReasoningEffort | undefined): string {
  if (!effort) return 'Default';
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

interface BotDetailsSheetProps {
  rest: RestClient;
  profile: Profile;
  /** Why this bot cannot be renamed or deleted (the default, or the one in use), if so. */
  lockedReason?: string | undefined;
  onOpenChat: () => void;
  onClose: () => void;
}

/**
 * One bot's card, like a contact's: Message, its model settings, its name,
 * and Delete with a second question in place. Everything in one sheet, so no
 * sheet ever opens on top of another.
 */
export function BotDetailsSheet({ rest, profile, lockedReason, onOpenChat, onClose }: BotDetailsSheetProps) {
  const profiles = useProfilesStore((s) => s.profiles);
  const rename = useProfilesStore((s) => s.rename);
  const deleteProfile = useProfilesStore((s) => s.delete);
  const setModel = useProfilesStore((s) => s.setModel);
  const options = useModelStore((s) => s.options);
  const loadOptions = useModelStore((s) => s.loadOptions);
  const [busy, setBusy] = useState<'model' | 'rename' | 'delete' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(profile.name);
  const [provider, setProvider] = useState(profile.provider ?? '');
  const [model, setModelName] = useState(profile.model ?? '');
  const [effort, setEffort] = useState<ReasoningEffort>(profile.reasoningEffort ?? 'high');
  const [showReasoning, setShowReasoning] = useState(profile.showReasoning ?? false);

  useEffect(() => {
    if (!options) void loadOptions(rest);
  }, [options, loadOptions, rest]);

  const providers = useMemo(() => options?.providers ?? [], [options]);
  const currentProvider = providers.find((entry) => entry.slug === provider);

  // Fill in a provider and model once the choices arrive, when the bot names none.
  useEffect(() => {
    if (!options) return;
    setProvider((value) => value || options.provider || providers[0]?.slug || '');
  }, [options, providers]);
  useEffect(() => {
    if (!currentProvider) return;
    setModelName((value) => (value && currentProvider.models.includes(value) ? value : currentProvider.models[0] ?? value));
  }, [currentProvider]);

  const label = profile.displayName && profile.displayName !== profile.name ? profile.displayName : botLabel(profile.name);
  const modelChanged =
    provider !== (profile.provider ?? '') ||
    model !== (profile.model ?? '') ||
    effort !== (profile.reasoningEffort ?? 'high') ||
    showReasoning !== (profile.showReasoning ?? false);
  const trimmedName = name.trim();
  const nameProblem =
    trimmedName === profile.name
      ? undefined
      : !NAME_RE.test(trimmedName)
        ? 'Use lowercase letters, numbers, - and _ only.'
        : profiles.some((other) => other.name === trimmedName)
          ? 'Another bot already has that name.'
          : undefined;

  async function run(kind: 'model' | 'rename' | 'delete', work: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError(undefined);
    setSaved(false);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(undefined);
    }
  }

  const saveModel = () =>
    run('model', async () => {
      if (!provider || !model) throw new Error('Pick a provider and a model.');
      await setModel(rest, profile.name, provider, model, effort, showReasoning);
      setSaved(true);
    });

  const saveName = () =>
    run('rename', async () => {
      await rename(rest, profile.name, trimmedName);
      onClose();
    });

  const removeBot = () =>
    run('delete', async () => {
      await deleteProfile(rest, profile.name);
      onClose();
    });

  return (
    <BottomSheet title={label} onClose={onClose} closeDisabled={busy !== undefined} className="hm-sheet--bot" contentClassName="hm-bot-details">
      {confirmingDelete ? (
        <div className="hm-bot-details__confirm" data-testid="bot-delete-confirm">
          <p className="hm-bot-details__confirm-text">
            Delete {label}? This removes the bot&apos;s profile folder on the Mac, with its memory, skills and chats. It cannot be undone.
          </p>
          <div className="hm-action-sheet__group">
            <button
              type="button"
              className="hm-action-sheet__item hm-action-sheet__item--destructive"
              onClick={() => void removeBot()}
              disabled={busy !== undefined}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete bot'}
            </button>
            <button type="button" className="hm-action-sheet__item" onClick={() => setConfirmingDelete(false)} disabled={busy !== undefined}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="hm-bot-details__hero">
            <BotAvatar name={profile.name} size={72} />
            <span className="hm-bot-details__handle hm-muted">@{profile.name}</span>
            {profile.description ? <p className="hm-bot-details__desc hm-muted">{profile.description}</p> : null}
            <button type="button" className="hm-bot-details__message" onClick={onOpenChat}>
              <Icon name="chat" size={18} />
              <span>Message</span>
            </button>
          </div>

          <h4 className="hm-bot-details__heading">Model</h4>
          <div className="hm-bot-details__group">
            <label className="hm-bot-details__field">
              <span>Provider</span>
              <select
                className="hm-select"
                value={provider}
                onChange={(event) => {
                  const slug = event.target.value;
                  setProvider(slug);
                  setModelName(providers.find((entry) => entry.slug === slug)?.models[0] ?? '');
                }}
                disabled={busy !== undefined || !options}
                aria-label="Provider"
              >
                {!options ? <option value={provider}>Loading…</option> : null}
                {providers.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="hm-bot-details__field">
              <span>Model</span>
              <select
                className="hm-select"
                value={model}
                onChange={(event) => setModelName(event.target.value)}
                disabled={busy !== undefined || !currentProvider}
                aria-label="Model"
              >
                {!currentProvider ? <option value={model}>{model || 'Loading…'}</option> : null}
                {currentProvider?.models.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <label className="hm-bot-details__field">
              <span>Reasoning effort</span>
              <select
                className="hm-select"
                value={effort}
                onChange={(event) => setEffort(event.target.value as ReasoningEffort)}
                disabled={busy !== undefined}
                aria-label="Reasoning effort"
              >
                {REASONING_EFFORTS.map((entry) => (
                  <option key={entry} value={entry}>
                    {reasoningLabel(entry)}
                  </option>
                ))}
              </select>
            </label>
            <label className="hm-bot-details__field hm-bot-details__field--switch">
              <span>Show thinking in chat</span>
              <input
                type="checkbox"
                role="switch"
                className="hm-switch"
                checked={showReasoning}
                onChange={(event) => setShowReasoning(event.target.checked)}
                disabled={busy !== undefined}
                aria-label="Show thinking in chat"
              />
            </label>
          </div>
          <button
            type="button"
            className="hm-bot-details__action"
            onClick={() => void saveModel()}
            disabled={busy !== undefined || !modelChanged || !provider || !model}
          >
            {busy === 'model' ? 'Saving…' : saved && !modelChanged ? 'Saved' : 'Save model'}
          </button>

          <h4 className="hm-bot-details__heading">Name</h4>
          <div className="hm-bot-details__group">
            <label className="hm-bot-details__field">
              <span className="hm-sr-only">Bot name</span>
              <input
                className="hm-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy !== undefined || Boolean(lockedReason)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Bot name"
              />
            </label>
          </div>
          {nameProblem ? <p className="hm-bot-details__note hm-bot-details__note--error">{nameProblem}</p> : null}
          {lockedReason ? <p className="hm-bot-details__note hm-muted">{lockedReason}</p> : null}
          {!lockedReason ? (
            <button
              type="button"
              className="hm-bot-details__action"
              onClick={() => void saveName()}
              disabled={busy !== undefined || trimmedName === profile.name || Boolean(nameProblem)}
            >
              {busy === 'rename' ? 'Renaming…' : 'Rename'}
            </button>
          ) : null}

          {!lockedReason ? (
            <button
              type="button"
              className="hm-bot-details__action hm-bot-details__action--destructive"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy !== undefined}
            >
              Delete bot
            </button>
          ) : null}
        </>
      )}
      {error ? (
        <p className="hm-bot-details__note hm-bot-details__note--error" role="alert">
          {error}
        </p>
      ) : null}
    </BottomSheet>
  );
}
