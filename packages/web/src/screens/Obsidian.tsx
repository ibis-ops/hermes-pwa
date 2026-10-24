import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  groupNotesByDay,
  obsidianOpenUrl,
  resolveLinkVault,
  type ObsidianActivity,
  type ObsidianNote,
  type RestClient,
} from '@hermes-pwa/core';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { formatClockTime, formatDayLabel } from '../lib/chatTime';

interface ObsidianProps {
  rest: RestClient;
}

type Filter = 'created' | 'edited' | 'all';

const REFRESH_MS = 30_000;
const DAYS = 60;
/** The vault name the phone should open, when the person has set one themselves. */
const PHONE_VAULT_STORAGE_KEY = 'hermes-pwa.obsidian.phoneVault.v1';

function readPhoneVault(): string | undefined {
  try {
    const raw = window.localStorage.getItem(PHONE_VAULT_STORAGE_KEY);
    return raw === null ? undefined : raw;
  } catch {
    return undefined;
  }
}

function writePhoneVault(value: string | undefined): void {
  try {
    if (value === undefined) window.localStorage.removeItem(PHONE_VAULT_STORAGE_KEY);
    else window.localStorage.setItem(PHONE_VAULT_STORAGE_KEY, value);
  } catch {
    // Private mode or blocked storage: the choice just does not survive a reload.
  }
}

function botLabel(profile: string | undefined): string | undefined {
  if (!profile || profile === 'default') return undefined;
  return profile;
}

interface VaultSheetProps {
  activity: ObsidianActivity;
  current: string | undefined;
  onPick: (value: string | undefined) => void;
  onClose: () => void;
}

/** Which vault name the obsidian:// links should carry. */
function VaultSheet({ activity, current, onPick, onClose }: VaultSheetProps) {
  const detected = activity.vaults[0];
  const candidates = useMemo(() => {
    const names = new Set<string>();
    for (const vault of activity.vaults) {
      if (vault.phoneName) names.add(vault.phoneName);
      names.add(vault.name);
    }
    return [...names];
  }, [activity.vaults]);
  const [custom, setCustom] = useState(current !== undefined && !candidates.includes(current) ? current : '');
  const automatic = current === undefined;

  return (
    <BottomSheet title="Open notes in" onClose={onClose} contentClassName="hm-vault-sheet">
      <p className="hm-vault-sheet__hint hm-muted">
        Links open the vault with this name on your phone. If Obsidian says it cannot find the vault, pick the name your phone uses.
      </p>
      <button
        type="button"
        className={`hm-vault-sheet__row ${automatic ? 'hm-vault-sheet__row--selected' : ''}`}
        onClick={() => onPick(undefined)}
        aria-pressed={automatic}
      >
        <span className="hm-vault-sheet__body">
          <span className="hm-vault-sheet__name">Automatic</span>
          <span className="hm-vault-sheet__desc hm-muted">
            {detected?.phoneName
              ? `Your phone's copy looks like “${detected.phoneName}”.`
              : detected
                ? `Uses the Mac vault's name, “${detected.name}”.`
                : 'Uses whatever the Mac reports.'}
          </span>
        </span>
        {automatic ? <Icon name="check" size={16} /> : null}
      </button>
      {candidates.map((name) => {
        const selected = current === name;
        return (
          <button
            key={name}
            type="button"
            className={`hm-vault-sheet__row ${selected ? 'hm-vault-sheet__row--selected' : ''}`}
            onClick={() => onPick(name)}
            aria-pressed={selected}
          >
            <span className="hm-vault-sheet__body">
              <span className="hm-vault-sheet__name">{name}</span>
            </span>
            {selected ? <Icon name="check" size={16} /> : null}
          </button>
        );
      })}
      <form
        className="hm-vault-sheet__custom"
        onSubmit={(event) => {
          event.preventDefault();
          const value = custom.trim();
          if (value) onPick(value);
        }}
      >
        <input
          className="hm-input"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Another vault name"
          aria-label="Vault name on this phone"
          autoCapitalize="words"
          autoCorrect="off"
          enterKeyHint="done"
        />
        <button type="submit" className="hm-vault-sheet__use" disabled={!custom.trim()}>
          Use
        </button>
      </form>
    </BottomSheet>
  );
}

function NoteRow({ note, linkVault }: { note: ObsidianNote; linkVault: string | undefined }) {
  const bot = botLabel(note.profile);
  const editedLater = note.action === 'created' && note.editedAt !== undefined && note.editedAt > note.at + 60_000;
  return (
    <a
      className={`hm-note hm-note--${note.action}`}
      href={obsidianOpenUrl(linkVault, note.path)}
      data-testid="obsidian-note"
      data-action={note.action}
      aria-label={`${note.name}, ${note.action === 'created' ? 'new' : 'edited'} ${formatClockTime(note.at)}, opens in Obsidian`}
    >
      <span className="hm-note__icon" aria-hidden="true">
        <Icon name="note" size={18} />
      </span>
      <span className="hm-note__body">
        <span className="hm-note__name">{note.name}</span>
        <span className="hm-note__meta hm-muted">
          {note.folder ? <span className="hm-note__folder">{note.folder}</span> : null}
          {bot ? <span className="hm-note__bot">{bot}</span> : null}
        </span>
      </span>
      <span className="hm-note__side">
        <span className={`hm-note__badge hm-note__badge--${note.action}`}>{note.action === 'created' ? 'New' : 'Edited'}</span>
        <span className="hm-note__time hm-muted">
          {formatClockTime(note.at)}
          {editedLater && note.editedAt !== undefined ? ` · edited ${formatClockTime(note.editedAt)}` : ''}
        </span>
      </span>
      <span className="hm-note__chevron" aria-hidden="true">
        <Icon name="chevR" size={14} />
      </span>
    </a>
  );
}

/** Notes Hermes wrote in the Obsidian vault, by day, each a link into the Obsidian app. */
export function Obsidian({ rest }: ObsidianProps) {
  const [activity, setActivity] = useState<ObsidianActivity | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>('created');
  const [phoneVault, setPhoneVault] = useState<string | undefined>(() => readPhoneVault());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const next = await rest.obsidianActivity(DAYS);
      setActivity(next);
      setError(undefined);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load the Obsidian activity.');
    }
  }, [rest]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const notes = useMemo(() => activity?.notes ?? [], [activity]);
  const counts = useMemo(
    () => ({
      created: notes.filter((n) => n.action === 'created').length,
      edited: notes.filter((n) => n.action === 'edited').length,
      all: notes.length,
    }),
    [notes],
  );
  const visible = useMemo(() => (filter === 'all' ? notes : notes.filter((n) => n.action === filter)), [notes, filter]);
  const groups = useMemo(() => groupNotesByDay(visible), [visible]);
  const vault = activity?.vaults[0];
  const linkVaultLabel = phoneVault ?? vault?.phoneName ?? vault?.name;

  const pickVault = (value: string | undefined) => {
    setPhoneVault(value);
    writePhoneVault(value);
    setSheetOpen(false);
  };

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'created', label: 'New', count: counts.created },
    { key: 'edited', label: 'Edited', count: counts.edited },
    { key: 'all', label: 'All', count: counts.all },
  ];

  return (
    <div className="hm-obsidian hm-scroll">
      <p className="hm-obsidian__lead hm-muted">
        {vault
          ? `Notes your bots wrote in the ${vault.name} vault over the last ${DAYS} days. Tap one to open it in Obsidian.`
          : 'Notes your bots write in Obsidian show here. Tap one to open it in the Obsidian app.'}
      </p>

      {error ? <div className="hm-warning-banner hm-warning-banner--error">{error}</div> : null}
      {activity && !activity.available ? (
        <div className="hm-warning-banner">
          No Obsidian vault was found on the Mac. Open the vault once in Obsidian there, or set HERMES_PWA_OBSIDIAN_VAULTS in ~/.hermes/.env.
        </div>
      ) : null}

      {activity?.available ? (
        <div className="hm-obsidian__toolbar">
          <div className="hm-obsidian__filters" role="tablist" aria-label="Filter notes">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                className={`hm-filter-chip${filter === f.key ? ' hm-filter-chip--active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="hm-filter-chip__count">{f.count}</span>
              </button>
            ))}
          </div>
          <button type="button" className="hm-obsidian__vault" onClick={() => setSheetOpen(true)} aria-label="Change which vault notes open in">
            <span className="hm-muted">Opens in</span> {linkVaultLabel ?? 'last used vault'}
            <Icon name="chevD" size={12} />
          </button>
        </div>
      ) : null}

      {activity === undefined && !error ? <p className="hm-muted hm-loading">Loading…</p> : null}

      {activity?.available && groups.length === 0 ? (
        <p className="hm-obsidian__empty hm-muted">
          {filter === 'created'
            ? `No new notes from your bots in the last ${DAYS} days.`
            : filter === 'edited'
              ? `No notes edited by your bots in the last ${DAYS} days.`
              : `Your bots have not written to the vault in the last ${DAYS} days.`}
        </p>
      ) : null}

      {groups.map((group) => (
        <section key={group.day} className="hm-obsidian__day" data-testid="obsidian-day">
          <h3 className="hm-obsidian__day-title">
            {formatDayLabel(group.day, nowMs)}
            <span className="hm-obsidian__day-count hm-muted">{group.notes.length}</span>
          </h3>
          <div className="hm-obsidian__list">
            {group.notes.map((note) => (
              <NoteRow key={`${note.vault}/${note.path}`} note={note} linkVault={resolveLinkVault(note, phoneVault)} />
            ))}
          </div>
        </section>
      ))}

      {sheetOpen && activity ? (
        <VaultSheet activity={activity} current={phoneVault} onPick={pickVault} onClose={() => setSheetOpen(false)} />
      ) : null}
    </div>
  );
}
