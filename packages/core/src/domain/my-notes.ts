/**
 * Sean's own notes: the "Notes from Sean" folder of his Obsidian vault, from the hermes-pwa
 * plugin's `/obsidian/my-notes` routes. The phone lists them newest first, reads one, writes new
 * ones and edits them. The files on the Mac are the source of truth: an edit carries the
 * `version` it started from, and the Mac refuses it when the note changed there since.
 */

/** The folder's name, for when the Mac has not said. */
export const MY_NOTES_FOLDER = 'Notes from Sean';

export interface MyNote {
  /** The file name, e.g. "Gym ideas.md": what the phone asks for the note by. */
  name: string;
  /** The file name without ".md", as Obsidian shows it. */
  title: string;
  /** Vault-relative path, e.g. "Notes from Sean/Gym ideas.md". */
  path: string;
  /** Epoch ms of the last change on the Mac. */
  modifiedAt: number | undefined;
  size: number | undefined;
  /** The note's first line of words, plain; empty when it has none. */
  preview: string;
}

export interface MyNotes {
  /** False when the Mac has no vault for the notes (see `error` and `reason`). */
  available: boolean;
  /** The vault's name on the Mac. */
  vault: string | undefined;
  /** The vault's name on the phone, when the Mac can tell. */
  phoneVault: string | undefined;
  folder: string;
  /** False until the first note is saved; the folder is made then. */
  exists: boolean;
  /** Newest first. */
  notes: MyNote[];
  total: number;
  /** Epoch ms. */
  scannedAt: number | undefined;
  /** The largest note the Mac takes, in bytes. */
  maxBytes: number | undefined;
  /** What went wrong, in the Mac's words. */
  error: string | undefined;
  /** A stable code for `error`: "no_vault", "bad_setting", "not_allowed", ... */
  reason: string | undefined;
}

export interface MyNoteContent {
  vault: string;
  phoneVault: string | undefined;
  folder: string;
  name: string;
  title: string;
  path: string;
  text: string;
  size: number | undefined;
  /** Epoch ms. */
  modifiedAt: number | undefined;
  /** The Mac's copy as it was read; an edit sends it back. */
  version: string;
  /** False when the file is not plain text the phone can save back unchanged. */
  editable: boolean;
}

/**
 * Why the Mac did not read or save a note, for the phone to explain in its own words:
 * `changed` (edited on the Mac after the phone opened it), `gone` (no longer in the folder),
 * `read-only`, `not-allowed` (a link, or a folder that is not a plain folder), `too-large`,
 * `no-vault` (no vault, or a setting that names none), `old-mac` (a dashboard without these
 * routes) and `other`.
 */
export type MyNoteProblem =
  | 'changed'
  | 'gone'
  | 'read-only'
  | 'not-allowed'
  | 'too-large'
  | 'no-vault'
  | 'old-mac'
  | 'other';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A note's title from its file name: "Gym ideas.md" is "Gym ideas". */
export function myNoteTitle(name: string): string {
  return name.replace(/\.md$/iu, '');
}

function toMyNote(raw: unknown, folder: string): MyNote | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const name = str(record.name);
  if (!name || !/\.md$/iu.test(name) || name.includes('/') || name.startsWith('.'))
    return undefined;
  return {
    name,
    title: str(record.title) ?? myNoteTitle(name),
    path: str(record.path) ?? `${folder}/${name}`,
    modifiedAt: epochMs(record.modified_at),
    size: count(record.size),
    preview: typeof record.preview === 'string' ? record.preview : '',
  };
}

export function toMyNotes(raw: unknown): MyNotes {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const folder = str(record.folder) ?? MY_NOTES_FOLDER;
  const notes = Array.isArray(record.notes)
    ? record.notes
        .map((entry) => toMyNote(entry, folder))
        .filter((note): note is MyNote => Boolean(note))
    : [];
  notes.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  return {
    available: record.available === true,
    vault: str(record.vault),
    phoneVault: str(record.phone_vault),
    folder,
    exists: record.exists === true || notes.length > 0,
    notes,
    total: count(record.total) ?? notes.length,
    scannedAt: epochMs(record.scanned_at),
    maxBytes: count(record.max_bytes),
    error: str(record.error),
    reason: str(record.reason),
  };
}

export function toMyNoteContent(raw: unknown): MyNoteContent {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const folder = str(record.folder) ?? MY_NOTES_FOLDER;
  const name = str(record.name) ?? '';
  return {
    vault: str(record.vault) ?? '',
    phoneVault: str(record.phone_vault),
    folder,
    name,
    title: str(record.title) ?? myNoteTitle(name),
    path: str(record.path) ?? (name ? `${folder}/${name}` : ''),
    text: typeof record.text === 'string' ? record.text : '',
    size: count(record.size),
    modifiedAt: epochMs(record.modified_at),
    version: typeof record.version === 'string' ? record.version : '',
    editable:
      record.editable !== false && typeof record.version === 'string' && record.version !== '',
  };
}

const PROBLEMS = new Map<string, MyNoteProblem>([
  ['changed', 'changed'],
  ['gone', 'gone'],
  ['read_only', 'read-only'],
  ['not_allowed', 'not-allowed'],
  ['too_large', 'too-large'],
  ['no_vault', 'no-vault'],
  ['bad_setting', 'no-vault'],
]);

/**
 * What a refused read or save means, from the HTTP status and the error body. The plugin's
 * refusals carry a `reason` code; a 404 without one is the dashboard's own "Not Found", which
 * means the Mac runs a plugin without these routes.
 */
export function myNoteProblem(status: number, body: string): MyNoteProblem {
  let reason: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      reason = (parsed as Record<string, unknown>).reason;
  } catch {
    // Not JSON: judge by the status alone.
  }
  const known = typeof reason === 'string' ? PROBLEMS.get(reason) : undefined;
  if (known) return known;
  if (status === 413) return 'too-large';
  if (status === 404) return 'old-mac';
  return 'other';
}
