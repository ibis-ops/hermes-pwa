import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HermesHttpError,
  MY_NOTES_FOLDER,
  resolveLinkVault,
  type MyNote,
  type MyNotes as MyNotesList,
  type RestClient,
} from '@hermes-pwa/core';
import { Icon } from './Icon';
import { MyNoteSheet } from './MyNoteSheet';
import { SkeletonRows } from './Skeleton';
import { VaultSync } from './VaultSync';
import { formatListTime } from '../lib/chatTime';
import { draftedNoteNames } from '../lib/noteDrafts';

interface MyNotesProps {
  rest: RestClient;
  /** The vault name the person chose for links on this phone, if any (the Obsidian screen's setting). */
  phoneVault: string | undefined;
}

type Opened = { kind: 'note'; note: MyNote } | { kind: 'new' };

const REFRESH_MS = 30_000;

function listErrorText(err: unknown): string {
  if (err instanceof HermesHttpError && err.status === 404) {
    return 'Your Mac did not answer with your notes. Restart the Hermes dashboard on the Mac, then try again.';
  }
  if (err instanceof HermesHttpError)
    return 'Your Mac could not list your notes. Try again in a moment.';
  return 'Could not reach your Mac. Check your connection, then try again.';
}

/** Why the Mac has no notes to show, in plain words, with what to do. */
function problemText(list: MyNotesList): string | undefined {
  if (list.reason === 'bad_setting') {
    return 'HERMES_PWA_NOTES_VAULT in ~/.hermes/.env does not name a vault on your Mac. Fix or remove it, then restart the Hermes dashboard.';
  }
  if (list.reason === 'no_vault' || (!list.available && !list.error)) {
    return 'No Obsidian vault was found on your Mac. Open your vault in Obsidian there once, then try again.';
  }
  if (list.reason === 'not_allowed') {
    return `“${list.folder}” in your vault is a link or a file, not a plain folder, so notes are not read or saved there. Make it a plain folder on your Mac.`;
  }
  if (list.error) return 'Your Mac could not read your notes. Try again in a moment.';
  return undefined;
}

function countLabel(count: number): string {
  if (count === 0) return 'No notes';
  return count === 1 ? '1 note' : `${count} notes`;
}

/**
 * Notes from Sean: the notes in that folder of the vault on the Mac, newest
 * first, as the Notes app lists them (title, when it was last edited, its
 * first line). A tap reads one; New note, at the bottom where a thumb
 * reaches, writes one. Saved notes go to the Mac, and Obsidian Sync brings
 * them to Obsidian on this phone.
 */
export function MyNotes({ rest, phoneVault }: MyNotesProps) {
  const [list, setList] = useState<MyNotesList | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [opened, setOpened] = useState<Opened | undefined>(undefined);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Set<string>>(() => draftedNoteNames());

  const load = useCallback(async () => {
    try {
      const next = await rest.myNotes();
      setList(next);
      setError(undefined);
      setNowMs(Date.now());
    } catch (err) {
      setError(listErrorText(err));
    }
  }, [rest]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const notes = useMemo(() => list?.notes ?? [], [list]);
  const folder = list?.folder ?? MY_NOTES_FOLDER;
  const linkVault = resolveLinkVault(
    { phoneVault: list?.phoneVault, vault: list?.vault ?? '' },
    phoneVault,
  );
  const problem = list ? problemText(list) : undefined;
  const canWrite = list?.available === true && list.reason !== 'not_allowed';

  const closeSheet = () => {
    setOpened(undefined);
    setDrafts(draftedNoteNames());
  };

  return (
    <div className="hm-my-notes" data-testid="my-notes">
      <p className="hm-obsidian__lead hm-muted">
        {list?.vault
          ? `Your notes in the ${folder} folder of the ${list.vault} vault, newest first. They save to your Mac, and Obsidian Sync brings them to this phone.`
          : `Your notes in the ${folder} folder of your Obsidian vault. They save to your Mac, and Obsidian Sync brings them to this phone.`}
      </p>

      <VaultSync rest={rest} linkVault={linkVault} onSynced={load} />

      {error ? (
        <div className="hm-warning-banner hm-warning-banner--error hm-my-notes__error" role="alert">
          <span>{error}</span>
          <button type="button" className="hm-my-notes__retry" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}
      {problem ? <div className="hm-warning-banner hm-my-notes__problem">{problem}</div> : null}

      {list === undefined && !error ? <SkeletonRows rows={5} label="Loading notes" /> : null}

      {list?.available && !problem && notes.length === 0 ? (
        <div className="hm-empty-state hm-my-notes__empty">
          <span className="hm-my-notes__empty-icon" aria-hidden="true">
            <Icon name="note" size={26} />
          </span>
          <h3>No notes yet</h3>
          <p>
            {list.exists
              ? 'Tap New note to write one.'
              : `Tap New note to write your first one. The ${folder} folder is made on your Mac when you save it.`}
          </p>
        </div>
      ) : null}

      {notes.length > 0 ? (
        <ul className="hm-my-notes__list" aria-label={folder}>
          {notes.map((note) => (
            <li key={note.name} className="hm-my-note">
              <button
                type="button"
                className="hm-my-note__main"
                onClick={() => setOpened({ kind: 'note', note })}
                data-testid="my-note"
              >
                <span className="hm-my-note__body">
                  <span className="hm-my-note__top">
                    <span className="hm-my-note__title">{note.title}</span>
                    {drafts.has(note.name) ? (
                      <span className="hm-my-note__draft">Unsaved edits</span>
                    ) : null}
                  </span>
                  <span className="hm-my-note__sub">
                    {note.modifiedAt ? (
                      <span className="hm-my-note__time">
                        {formatListTime(note.modifiedAt, nowMs)}
                      </span>
                    ) : null}
                    <span className="hm-my-note__preview">
                      {note.preview || 'No additional text'}
                    </span>
                  </span>
                </span>
                <span className="hm-my-note__chevron" aria-hidden="true">
                  <Icon name="chevR" size={14} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* The Notes toolbar: how many notes, and New note where a thumb reaches. */}
      <div className="hm-my-notes__bar">
        <span aria-hidden="true" />
        <span className="hm-my-notes__count">{list ? countLabel(list.total) : ''}</span>
        <button
          type="button"
          className="hm-my-notes__compose"
          onClick={() => setOpened({ kind: 'new' })}
          disabled={!canWrite}
          data-testid="my-notes-new"
        >
          <Icon name="compose" size={20} />
          <span>New note</span>
        </button>
      </div>

      {opened ? (
        <MyNoteSheet
          key={opened.kind === 'new' ? 'new' : `note:${opened.note.name}`}
          rest={rest}
          note={opened.kind === 'note' ? opened.note : undefined}
          folder={folder}
          vault={list?.vault}
          linkVault={linkVault}
          maxBytes={list?.maxBytes}
          onSaved={() => {
            setDrafts(draftedNoteNames());
            void load();
          }}
          onClose={closeSheet}
        />
      ) : null}
    </div>
  );
}
