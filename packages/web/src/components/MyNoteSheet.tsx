import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HermesHttpError,
  myNoteProblem,
  obsidianOpenUrl,
  type MyNote,
  type MyNoteContent,
  type MyNoteProblem,
  type RestClient,
} from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { NoteText } from './NoteText';
import { SkeletonRows } from './Skeleton';
import { formatClockTime, formatDayLabel } from '../lib/chatTime';
import { noteDraftKey, readNoteDraft, writeNoteDraft, type NoteDraft } from '../lib/noteDrafts';

/** How long typing pauses before the draft is kept on the phone. */
const DRAFT_DELAY_MS = 400;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Refusals that keep the text and offer to save it as a new note instead. */
type Blocked = Extract<MyNoteProblem, 'changed' | 'gone' | 'read-only' | 'not-allowed'>;

const BLOCKED: ReadonlySet<MyNoteProblem> = new Set<MyNoteProblem>([
  'changed',
  'gone',
  'read-only',
  'not-allowed',
]);

interface MyNoteSheetProps {
  rest: RestClient;
  /** The note to open, or undefined to write a new one. */
  note: MyNote | undefined;
  /** Folder and vault the note lives in, for the line under the title. */
  folder: string;
  vault: string | undefined;
  /** Vault name the Obsidian link should open on this phone. */
  linkVault: string | undefined;
  /** The largest note the Mac takes, in bytes. */
  maxBytes?: number | undefined;
  /** A note was written to the Mac, new or edited. */
  onSaved: (note: MyNoteContent) => void;
  onClose: () => void;
}

/** Line breaks as a text field hands them back, so an untouched note reads as unchanged. */
function plainLines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The note's size as the Mac counts it: UTF-8 bytes. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function problemOf(err: unknown): MyNoteProblem | 'offline' {
  if (err instanceof HermesHttpError) return myNoteProblem(err.status, err.body);
  return 'offline';
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const capped = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/** What went wrong reading a note, and what to do about it. */
function readErrorText(err: unknown, maxBytes: number): string {
  const problem = problemOf(err);
  if (problem === 'gone')
    return 'This note is no longer on your Mac. It may have been moved or renamed there.';
  if (problem === 'too-large')
    return `This note is over ${sizeLabel(maxBytes)}, too long to open here. Open it in Obsidian.`;
  if (problem === 'not-allowed')
    return 'This note is a link on your Mac, and links are not opened here. Open it in Obsidian.';
  if (problem === 'no-vault')
    return 'Your Mac has no Obsidian vault for your notes right now. Open your vault in Obsidian on the Mac, then try again.';
  if (problem === 'old-mac')
    return 'Your Mac did not answer. Restart the Hermes dashboard on the Mac, then try again.';
  if (problem === 'offline')
    return 'Could not reach your Mac. Check your connection, then try again.';
  const detail = err instanceof Error ? sentence(err.message) : '';
  return detail ? `${detail} Try again.` : 'Could not read the note. Try again.';
}

/** What went wrong saving, and what to do about it. The text always stays in the editor. */
function saveErrorText(err: unknown, maxBytes: number): string {
  const problem = problemOf(err);
  if (problem === 'too-large')
    return `This note is too long to save. Notes can be up to ${sizeLabel(maxBytes)}.`;
  if (problem === 'no-vault')
    return 'Your Mac has no Obsidian vault for your notes right now. Open your vault in Obsidian on the Mac, then save again.';
  if (problem === 'not-allowed')
    return 'Your Mac will not save into the Notes from Sean folder because it is a link, not a plain folder.';
  if (problem === 'old-mac')
    return 'Your Mac did not answer. Restart the Hermes dashboard on the Mac, then save again.';
  if (problem === 'offline')
    return 'Could not reach your Mac. Your text stays on this phone; save again when you are connected.';
  const detail = err instanceof Error ? sentence(err.message) : '';
  return detail
    ? `${detail} Your text stays on this phone; save again.`
    : 'Could not save. Your text stays on this phone; save again.';
}

function blockedText(blocked: Blocked): string {
  if (blocked === 'changed')
    return 'This note changed on your Mac after you started these changes. Save yours as a new note, or discard them.';
  if (blocked === 'gone')
    return 'This note is no longer on your Mac. Save your text as a new note, or discard it.';
  if (blocked === 'read-only')
    return 'This note is read-only on your Mac. Save your text as a new note, or discard it.';
  return 'Your Mac will not change this note because it is a link. Save your text as a new note, or discard it.';
}

function isBlocked(problem: MyNoteProblem | 'offline'): problem is Blocked {
  return problem !== 'offline' && BLOCKED.has(problem);
}

/**
 * One of Sean's notes: read as the note viewer shows notes, then edited in
 * place; or a new note, with a title and text. Save sits right above the
 * keyboard. Whatever is typed stays on the phone as a draft until the Mac has
 * it, so closing the sheet, a dropped connection or a refused save never
 * loses text. An edit carries the version it started from; when the note
 * changed on the Mac since, the Mac keeps its copy and the text here can be
 * saved as a new note instead.
 */
export function MyNoteSheet({
  rest,
  note,
  folder,
  vault,
  linkVault,
  maxBytes = DEFAULT_MAX_BYTES,
  onSaved,
  onClose,
}: MyNoteSheetProps) {
  // The note on show: a new note gets its file name when it is first saved.
  const [name, setName] = useState<string | undefined>(note?.name);
  const [initial] = useState(() => (note ? undefined : readNoteDraft(noteDraftKey(undefined))));
  const [content, setContent] = useState<MyNoteContent | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<'view' | 'edit'>(note ? 'view' : 'edit');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [baseVersion, setBaseVersion] = useState<string | undefined>(undefined);
  const [restored, setRestored] = useState(
    Boolean(initial && (initial.title.trim() || initial.text.trim())),
  );
  const [blocked, setBlocked] = useState<Blocked | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [savedText, setSavedText] = useState<string | undefined>(undefined);
  const isNew = name === undefined;
  const draftKey = noteDraftKey(name);
  const alive = useRef(true);
  const titleRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // A fresh note starts in its title; one brought back from a draft waits for a tap.
  const [focusTitle] = useState(() => !note && !initial);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // After the sheet has noted where focus was, so closing it hands focus back there.
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle]);

  const load = useCallback(
    async (which: string): Promise<MyNoteContent | undefined> => {
      setLoadError(undefined);
      try {
        const next = await rest.myNote(which);
        if (alive.current) setContent(next);
        return next;
      } catch (err) {
        if (alive.current) setLoadError(readErrorText(err, maxBytes));
        return undefined;
      }
    },
    [rest, maxBytes],
  );

  const firstName = useRef(note?.name);
  useEffect(() => {
    if (firstName.current) void load(firstName.current);
  }, [load]);

  // Drafts: kept a moment after typing stops, and at once when the sheet
  // closes or the app goes to the background.
  const pendingDraft = useRef<{ key: string; draft: NoteDraft | undefined } | undefined>(undefined);
  const flushDraft = useCallback(() => {
    const pending = pendingDraft.current;
    pendingDraft.current = undefined;
    if (pending) writeNoteDraft(pending.key, pending.draft);
  }, []);
  const dropDraft = useCallback((key: string) => {
    pendingDraft.current = undefined;
    writeNoteDraft(key, undefined);
  }, []);

  const baseText = useMemo(() => plainLines(content?.text ?? ''), [content]);
  const dirty =
    mode === 'edit' && (isNew ? title.trim() !== '' || text.trim() !== '' : text !== baseText);

  useEffect(() => {
    if (mode !== 'edit') return undefined;
    pendingDraft.current = {
      key: draftKey,
      draft: dirty ? { title, text, version: isNew ? undefined : baseVersion } : undefined,
    };
    const timer = window.setTimeout(flushDraft, DRAFT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [mode, draftKey, dirty, title, text, isNew, baseVersion, flushDraft]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onHidden);
      flushDraft();
    };
  }, [flushDraft]);

  const close = () => {
    flushDraft();
    onClose();
  };

  // A draft from an earlier visit to this note, for the Edit button's label.
  const hasDraft = useMemo(
    () => mode === 'view' && name !== undefined && readNoteDraft(noteDraftKey(name)) !== undefined,
    [mode, name],
  );

  // Only a note that might be over the cap is measured: a UTF-16 unit is at most 3 bytes of UTF-8.
  const tooLong = text.length * 3 > maxBytes && utf8Bytes(text) > maxBytes;
  const canSave = !saving && !tooLong && dirty;

  function resetMessages() {
    setSaveError(undefined);
    setConfirmingDiscard(false);
    setSavedText(undefined);
  }

  function startEditing() {
    if (!content?.editable) return;
    const base = plainLines(content.text);
    const draft = readNoteDraft(noteDraftKey(content.name));
    resetMessages();
    if (draft && draft.text !== base) {
      setText(draft.text);
      setBaseVersion(draft.version ?? content.version);
      setRestored(true);
      setBlocked(draft.version && draft.version !== content.version ? 'changed' : undefined);
    } else {
      setText(base);
      setBaseVersion(content.version);
      setRestored(false);
      setBlocked(undefined);
    }
    setMode('edit');
  }

  /** The Mac has the note: drop the draft of what was written (even if the sheet closed meanwhile) and show it. */
  function finish(key: string, saved: MyNoteContent, message: string) {
    dropDraft(key);
    onSaved(saved);
    if (!alive.current) return;
    setName(saved.name);
    setContent(saved);
    setMode('view');
    setRestored(false);
    setBlocked(undefined);
    setConfirmingDiscard(false);
    setSaveError(undefined);
    setSavedText(message);
  }

  async function save() {
    if (!canSave) return;
    const key = draftKey;
    setSaving(true);
    resetMessages();
    try {
      const saved =
        name === undefined
          ? await rest.createMyNote(title, text)
          : await rest.saveMyNote(name, text, baseVersion ?? '');
      finish(key, saved, 'Saved to your Mac.');
    } catch (err) {
      if (!alive.current) return;
      const problem = problemOf(err);
      if (!isNew && isBlocked(problem)) setBlocked(problem);
      else setSaveError(saveErrorText(err, maxBytes));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function saveAsNew() {
    if (saving || tooLong) return;
    const key = draftKey;
    setSaving(true);
    resetMessages();
    try {
      const saved = await rest.createMyNote(content?.title ?? note?.title ?? '', text);
      finish(key, saved, `Saved to your Mac as “${saved.title}”.`);
    } catch (err) {
      if (alive.current) setSaveError(saveErrorText(err, maxBytes));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function discard() {
    dropDraft(draftKey);
    resetMessages();
    setRestored(false);
    setBlocked(undefined);
    if (name === undefined) {
      setTitle('');
      setText('');
      return;
    }
    // Back to the note as it is on the Mac now.
    setMode('view');
    setContent(undefined);
    await load(name);
  }

  // Discarding cannot be undone, so it asks once more in place.
  const discardControl = confirmingDiscard ? (
    <div className="hm-my-note-sheet__confirm" data-testid="my-note-discard-confirm">
      <span>
        {isNew
          ? 'Discard this note? It is only on this phone.'
          : 'Discard your changes? They are only on this phone.'}
      </span>
      <span className="hm-my-note-sheet__confirm-actions">
        <button
          type="button"
          className="hm-my-note-sheet__text-btn"
          onClick={() => setConfirmingDiscard(false)}
        >
          Keep
        </button>
        <button
          type="button"
          className="hm-my-note-sheet__text-btn hm-my-note-sheet__text-btn--danger"
          onClick={() => void discard()}
        >
          Discard
        </button>
      </span>
    </div>
  ) : (
    <button
      type="button"
      className="hm-my-note-sheet__text-btn hm-my-note-sheet__text-btn--danger"
      onClick={() => setConfirmingDiscard(true)}
      disabled={saving}
    >
      {isNew ? 'Discard this note' : 'Discard my changes'}
    </button>
  );

  const shownTitle = isNew ? 'New note' : (content?.title ?? note?.title ?? 'Note');
  const shownVault = content?.vault || vault;
  const modified = content?.modifiedAt;
  // Where a note saves while it is written; once it is read, the folder goes without saying.
  const metaLine = isNew
    ? `Saves to ${folder}${shownVault ? ` in ${shownVault}` : ''}`
    : mode === 'edit'
      ? [folder, shownVault].filter(Boolean).join(' · ')
      : [
          shownVault,
          modified ? `edited ${formatDayLabel(modified)} ${formatClockTime(modified)}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
  const openPath = content?.path ?? note?.path ?? '';

  const footer =
    mode === 'edit' ? (
      <div className="hm-my-note-sheet__footer">
        {tooLong ? (
          <p className="hm-my-note-sheet__limit" role="alert">
            Too long to save. Notes can be up to {sizeLabel(maxBytes)}.
          </p>
        ) : null}
        {blocked ? (
          <button
            type="button"
            className="hm-primary hm-my-note-sheet__save"
            onClick={() => void saveAsNew()}
            disabled={saving || tooLong}
          >
            {saving ? 'Saving…' : 'Save as new note'}
          </button>
        ) : (
          <button
            type="button"
            className="hm-primary hm-my-note-sheet__save"
            onClick={() => void save()}
            disabled={!canSave}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    ) : (
      <div className="hm-my-note-sheet__footer">
        <div className="hm-my-note-sheet__actions">
          <a
            className="hm-my-note-sheet__open"
            href={obsidianOpenUrl(linkVault, openPath)}
            data-testid="note-open-link"
          >
            <Icon name="note" size={16} />
            Open in Obsidian
          </a>
          <button
            type="button"
            className="hm-my-note-sheet__edit"
            onClick={startEditing}
            disabled={!content?.editable}
          >
            <Icon name="edit" size={16} />
            {hasDraft ? 'Keep editing' : 'Edit'}
          </button>
        </div>
        <p className="hm-my-note-sheet__hint hm-muted">
          {content && !content.editable
            ? 'This note has characters the phone cannot edit. Open it in Obsidian to change it.'
            : 'Obsidian opens it here once Sync has brought it to this phone.'}
        </p>
      </div>
    );

  return (
    <BottomSheet
      title={shownTitle}
      onClose={close}
      closeDisabled={saving}
      closeLabel={mode === 'edit' ? 'Close' : 'Done'}
      className="hm-sheet--my-note"
      contentClassName={`hm-my-note-sheet hm-my-note-sheet--${mode}`}
      meta={metaLine ? <p className="hm-my-note-sheet__meta hm-muted">{metaLine}</p> : null}
      footer={footer}
    >
      {mode === 'view' ? (
        <>
          {savedText ? (
            <p className="hm-my-note-sheet__saved" role="status">
              <Icon name="check" size={16} />
              {savedText}
            </p>
          ) : null}
          {loadError ? (
            <div className="hm-warning-banner hm-warning-banner--error" role="alert">
              {loadError}
            </div>
          ) : null}
          {!content && !loadError ? (
            <SkeletonRows rows={5} kind="chat" label="Loading note" />
          ) : null}
          {content ? (
            content.text.trim() ? (
              <NoteText text={content.text} />
            ) : (
              <p className="hm-my-note-sheet__empty hm-muted">
                This note is empty. Tap Edit to write in it.
              </p>
            )
          ) : null}
        </>
      ) : (
        <>
          {blocked ? (
            <div
              className="hm-warning-banner hm-my-note-sheet__banner"
              role="alert"
              data-testid="my-note-blocked"
            >
              <p>{blockedText(blocked)}</p>
              {discardControl}
            </div>
          ) : restored ? (
            <div className="hm-my-note-sheet__banner hm-my-note-sheet__banner--quiet" role="status">
              <p>Brought back what you had not saved.</p>
              {discardControl}
            </div>
          ) : null}
          {saveError ? (
            <div className="hm-warning-banner hm-warning-banner--error" role="alert">
              {saveError}
            </div>
          ) : null}
          {isNew ? (
            <input
              className="hm-my-note-edit__title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Title"
              aria-label="Title"
              autoCapitalize="sentences"
              enterKeyHint="next"
              readOnly={saving}
              ref={titleRef}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  textRef.current?.focus();
                }
              }}
            />
          ) : null}
          <textarea
            ref={textRef}
            className="hm-my-note-edit__text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={isNew ? 'Write your note' : 'Write here'}
            aria-label="Note text"
            autoCapitalize="sentences"
            readOnly={saving}
          />
        </>
      )}
    </BottomSheet>
  );
}
