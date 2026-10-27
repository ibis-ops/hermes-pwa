import { useEffect, useMemo, useState } from 'react';
import { botLabel, useProfilesStore, type Profile, type ReasoningEffort, type RestClient, type Session } from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { BottomSheet } from '../components/BottomSheet';
import { BotAvatar } from '../components/BotAvatar';
import { BotDetailsSheet } from '../components/BotDetailsSheet';
import { TeamMapView } from '../components/TeamMapView';
import { SkeletonRows } from '../components/Skeleton';
import { formatListTime, toMillis } from '../lib/chatTime';

interface ProfilesProps {
  rest: RestClient;
  /** Called once a bot has been made active; the shell brings up its chat. */
  onActivated?: (() => void) | undefined;
}

type BotsView = 'bots' | 'team';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VIEW_KEY = 'hermes-pwa.botsView.v1';

function readView(): BotsView {
  try {
    return window.sessionStorage.getItem(VIEW_KEY) === 'team' ? 'team' : 'bots';
  } catch {
    return 'bots';
  }
}

function writeView(view: BotsView): void {
  try {
    window.sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    // The choice simply is not remembered.
  }
}

function effortLabel(effort: ReasoningEffort | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function displayName(profile: Profile): string {
  return profile.displayName && profile.displayName !== profile.name ? profile.displayName : botLabel(profile.name);
}

function lastActive(session: Session | undefined): number | undefined {
  return toMillis(session?.lastActive ?? session?.updatedAt);
}

interface BotRowProps {
  profile: Profile;
  latest: Session | undefined;
  current: boolean;
  opening: boolean;
  onOpen: () => void;
  onDetails: () => void;
}

function BotRow({ profile, latest, current, opening, onOpen, onDetails }: BotRowProps) {
  const name = displayName(profile);
  const at = lastActive(latest);
  const model = [profile.model, effortLabel(profile.reasoningEffort)].filter(Boolean).join(' · ');
  const preview = latest?.title || profile.description || 'No chats yet';
  return (
    <li className="hm-bot-row" data-current={current ? 'true' : 'false'} data-testid="bot-row">
      <button
        type="button"
        className="hm-bot-row__main"
        onClick={onOpen}
        disabled={opening}
        aria-label={`Open chat with ${name}${current ? ', current bot' : ''}`}
      >
        <BotAvatar name={profile.name} size={46} />
        <span className="hm-bot-row__text">
          <span className="hm-bot-row__top">
            <span className="hm-bot-row__name">{name}</span>
            {current ? <span className="hm-bot-row__current">Current</span> : null}
            <span className="hm-bot-row__time">{opening ? 'Opening…' : at ? formatListTime(at) : ''}</span>
          </span>
          <span className="hm-bot-row__preview">{preview}</span>
          {model ? <span className="hm-bot-row__model">{model}</span> : null}
        </span>
      </button>
      <button type="button" className="hm-bot-row__info" onClick={onDetails} aria-label={`${name} details`}>
        <Icon name="more" size={20} />
      </button>
    </li>
  );
}

/**
 * The bots, as the Messages list: each one with its newest chat, most
 * recent first. Tapping a bot opens its chat; the details button holds its
 * model, name and delete. The Team view holds the map of who reports to whom.
 */
export function Profiles({ rest, onActivated }: ProfilesProps) {
  const { profiles, loading, error, activeName, currentName, load, activate, create } = useProfilesStore();
  const [view, setView] = useState<BotsView>(() => readView());
  const [latest, setLatest] = useState<Record<string, Session | undefined>>({});
  const [detailsFor, setDetailsFor] = useState<string | undefined>();
  const [opening, setOpening] = useState<string | undefined>();
  const [openError, setOpenError] = useState<string | undefined>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cloneFromDefault, setCloneFromDefault] = useState(true);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();

  useEffect(() => {
    void load(rest);
  }, [rest, load]);

  // Each bot's newest chat, for the line under its name.
  const names = useMemo(() => profiles.map((profile) => profile.name), [profiles]);
  const namesKey = names.join('\n');
  useEffect(() => {
    // Keyed on the names as text: re-fetched when the bots change, not on every reload of the list.
    const bots = namesKey ? namesKey.split('\n') : [];
    if (bots.length === 0) return undefined;
    let alive = true;
    void Promise.allSettled(bots.map((bot) => rest.latestSession(bot))).then((results) => {
      if (!alive) return;
      const next: Record<string, Session | undefined> = {};
      results.forEach((result, index) => {
        const bot = bots[index];
        if (bot && result.status === 'fulfilled') next[bot] = result.value;
      });
      setLatest(next);
    });
    return () => {
      alive = false;
    };
  }, [rest, namesKey]);

  const rows = useMemo(
    () =>
      [...profiles].sort((a, b) => {
        const left = lastActive(latest[a.name]) ?? 0;
        const right = lastActive(latest[b.name]) ?? 0;
        if (left !== right) return right - left;
        return displayName(a).localeCompare(displayName(b));
      }),
    [profiles, latest],
  );

  const isCurrent = (profile: Profile) => (activeName ? profile.name === activeName : profile.isActive);
  const lockedReason = (profile: Profile): string | undefined => {
    if (profile.name === 'default') return 'The default bot cannot be renamed or deleted.';
    if (isCurrent(profile) || profile.name === currentName) return 'Switch to another bot before renaming or deleting this one.';
    return undefined;
  };

  async function openChat(profile: Profile) {
    if (opening) return;
    setOpening(profile.name);
    setOpenError(undefined);
    try {
      // The shell brings up this bot's own chat once the active bot changes.
      if (!isCurrent(profile)) await activate(rest, profile.name);
      setDetailsFor(undefined);
      onActivated?.();
    } catch (err) {
      setOpenError(err instanceof Error && err.message ? err.message : `Could not open ${displayName(profile)}.`);
    } finally {
      setOpening(undefined);
    }
  }

  function chooseView(next: BotsView) {
    setView(next);
    writeView(next);
  }

  function openNewSheet() {
    setName('');
    setDescription('');
    setCloneFromDefault(true);
    setFormError(undefined);
    setSheetOpen(true);
  }

  function closeNewSheet() {
    if (creating) return;
    setSheetOpen(false);
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('A name is required.');
      return;
    }
    if (!NAME_RE.test(trimmed)) {
      setFormError('Use lowercase letters, numbers, - and _ only.');
      return;
    }
    if (profiles.some((p) => p.name === trimmed)) {
      setFormError('Another bot already has that name.');
      return;
    }
    setCreating(true);
    setFormError(undefined);
    const body: import('@hermes-pwa/core').ProfileCreateBody = { name: trimmed, clone_from_default: cloneFromDefault };
    if (description.trim()) body.description = description.trim();
    try {
      await create(rest, body);
      setSheetOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create the bot.');
    } finally {
      setCreating(false);
    }
  }

  const detailsProfile = detailsFor ? profiles.find((profile) => profile.name === detailsFor) : undefined;

  return (
    <div className="hm-bots hm-scroll">
      <div className="hm-segmented hm-bots__switch" role="radiogroup" aria-label="Bots view">
        {(['bots', 'team'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={view === value}
            className={`hm-segmented__item${view === value ? ' hm-segmented__item--active' : ''}`}
            onClick={() => chooseView(value)}
          >
            {value === 'bots' ? 'Bots' : 'Team'}
          </button>
        ))}
      </div>

      {error ? <div className="hm-warning-banner hm-warning-banner--error">{error}</div> : null}
      {openError ? (
        <div className="hm-warning-banner hm-warning-banner--error" role="alert">
          {openError}
        </div>
      ) : null}

      {view === 'team' ? (
        profiles.length > 0 ? (
          <TeamMapView
            rest={rest}
            bots={names}
            onOpenBot={(name) => {
              const profile = profiles.find((entry) => entry.name === name);
              if (profile) void openChat(profile);
            }}
          />
        ) : loading ? (
          <SkeletonRows rows={4} kind="cards" label="Loading bots" />
        ) : null
      ) : (
        <>
          {loading && profiles.length === 0 ? <SkeletonRows rows={4} label="Loading bots" /> : null}
          {!loading && profiles.length === 0 ? (
            <div className="hm-empty-state">
              <p className="hm-muted">No bots came back from Hermes.</p>
              <button type="button" className="hm-bots__reload" onClick={() => void load(rest)}>
                Try again
              </button>
            </div>
          ) : null}
          {rows.length > 0 ? (
            <ul className="hm-bots__list" aria-label="Bots">
              {rows.map((profile) => (
                <BotRow
                  key={profile.name}
                  profile={profile}
                  latest={latest[profile.name]}
                  current={isCurrent(profile)}
                  opening={opening === profile.name}
                  onOpen={() => void openChat(profile)}
                  onDetails={() => setDetailsFor(profile.name)}
                />
              ))}
            </ul>
          ) : null}
          <button type="button" className="hm-bots__new" onClick={openNewSheet} aria-label="New bot">
            <Icon name="plus" size={18} />
            <span>New bot</span>
          </button>
          <p className="hm-bots__footnote hm-muted">
            Each bot is a Hermes profile with its own model, memory and skills. Tap one to open its chat.
          </p>
        </>
      )}

      {detailsProfile ? (
        <BotDetailsSheet
          key={detailsProfile.name}
          rest={rest}
          profile={detailsProfile}
          lockedReason={lockedReason(detailsProfile)}
          onOpenChat={() => void openChat(detailsProfile)}
          onClose={() => setDetailsFor(undefined)}
        />
      ) : null}

      {sheetOpen ? (
        <BottomSheet
          title="New bot"
          onClose={closeNewSheet}
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
              <button type="button" className="hm-ghost" onClick={closeNewSheet} disabled={creating}>
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
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="hm-projects__hint hm-muted">Lowercase letters, numbers, - and _ only.</p>
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
              placeholder="What is this bot for?"
              disabled={creating}
              rows={3}
            />
          </div>

          <label className="hm-settings-row hm-settings-row--switch">
            <span className="hm-settings-row__label">Copy settings from the default bot</span>
            <input
              type="checkbox"
              role="switch"
              className="hm-switch"
              checked={cloneFromDefault}
              onChange={(e) => setCloneFromDefault(e.target.checked)}
              disabled={creating}
              aria-label="Copy settings from the default bot"
            />
          </label>

          {formError ? <div className="hm-warning-banner hm-warning-banner--error">{formError}</div> : null}
        </BottomSheet>
      ) : null}
    </div>
  );
}
