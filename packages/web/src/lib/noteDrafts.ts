/**
 * Notes typed on this phone and not saved to the Mac yet. Closing the editor,
 * switching screens or iOS closing the app in the background never loses
 * them: the editor brings them back the next time. One per note, by file name,
 * and one for a new note. The keys sit under `hermes-pwa.obsidian.`, which
 * signing out clears from the phone.
 */

const DRAFT_PREFIX = 'hermes-pwa.obsidian.noteDraft.v1:';
const NOTE_KEY_PREFIX = 'note:';

export interface NoteDraft {
  title: string;
  text: string;
  /** The Mac's version an edit started from; undefined for a new note. */
  version: string | undefined;
}

/** The draft for a new note, or for changes to the note with this file name. */
export function noteDraftKey(name: string | undefined): string {
  return name ? `${NOTE_KEY_PREFIX}${name}` : 'new';
}

function storageKey(key: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(key)}`;
}

export function readNoteDraft(key: string): NoteDraft | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<NoteDraft>;
    if (typeof parsed.text !== 'string') return undefined;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      text: parsed.text,
      version: typeof parsed.version === 'string' && parsed.version ? parsed.version : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Keep a draft, or drop it with `undefined`. */
export function writeNoteDraft(key: string, draft: NoteDraft | undefined): void {
  try {
    if (draft) window.localStorage.setItem(storageKey(key), JSON.stringify(draft));
    else window.localStorage.removeItem(storageKey(key));
  } catch {
    // Storage blocked or full: the draft lives only while the editor is open.
  }
}

function draftName(key: string): string | undefined {
  try {
    const decoded = decodeURIComponent(key.slice(DRAFT_PREFIX.length));
    return decoded.startsWith(NOTE_KEY_PREFIX) && decoded.length > NOTE_KEY_PREFIX.length
      ? decoded.slice(NOTE_KEY_PREFIX.length)
      : undefined;
  } catch {
    return undefined;
  }
}

/** File names of the notes that have changes on this phone not saved to the Mac yet. */
export function draftedNoteNames(): Set<string> {
  const names = new Set<string>();
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      const name = key?.startsWith(DRAFT_PREFIX) ? draftName(key) : undefined;
      if (name && readNoteDraft(noteDraftKey(name))) names.add(name);
    }
  } catch {
    // Storage blocked: no drafts to show.
  }
  return names;
}
