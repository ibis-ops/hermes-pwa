/**
 * Obsidian notes the agent wrote, as reported by the hermes-pwa plugin's
 * `/obsidian/activity` route. The phone lists them by day and opens each one
 * in the Obsidian app through an `obsidian://` link.
 */

export type ObsidianNoteAction = 'created' | 'edited';

export interface ObsidianVault {
  /** Folder name of the vault on the Mac, which is also its name in Obsidian there. */
  name: string;
  path: string;
  /** The vault's name on the phone when the Mac can tell (an iCloud mirror), else undefined. */
  phoneName: string | undefined;
  open: boolean;
}

export interface ObsidianNote {
  /** Vault-relative path with its extension, e.g. "Clients/Ann Lee/Ann Lee.md". */
  path: string;
  name: string;
  folder: string;
  vault: string;
  phoneVault: string | undefined;
  action: ObsidianNoteAction;
  /** Epoch ms: creation time for a new note, last edit for an edited one. */
  at: number;
  createdAt: number | undefined;
  editedAt: number | undefined;
  /** Hermes profile (bot) that did the work, when known. */
  profile: string | undefined;
  size: number | undefined;
}

export interface ObsidianActivity {
  /** False when no vault was found on the Mac. */
  available: boolean;
  vaults: ObsidianVault[];
  notes: ObsidianNote[];
  /** Epoch ms of the scan behind this payload. */
  scannedAt: number | undefined;
  days: number | undefined;
  total: number;
  error: string | undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function toVault(raw: unknown): ObsidianVault | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const name = str(record.name);
  const path = str(record.path);
  if (!name || !path) return undefined;
  return { name, path, phoneName: str(record.phone_name), open: record.open === true };
}

function toNote(raw: unknown): ObsidianNote | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const path = str(record.path);
  const vault = str(record.vault);
  const at = epochMs(record.at);
  if (!path || !vault || at === undefined) return undefined;
  const name = str(record.name) ?? path.replace(/\.[^./]+$/u, '').split('/').pop() ?? path;
  return {
    path,
    name,
    folder: typeof record.folder === 'string' ? record.folder : '',
    vault,
    phoneVault: str(record.phone_vault),
    action: record.action === 'created' ? 'created' : 'edited',
    at,
    createdAt: epochMs(record.created_at),
    editedAt: epochMs(record.edited_at),
    profile: str(record.profile),
    size: typeof record.size === 'number' ? record.size : undefined,
  };
}

export function toObsidianActivity(raw: unknown): ObsidianActivity {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const vaults = Array.isArray(record.vaults) ? record.vaults.map(toVault).filter((v): v is ObsidianVault => Boolean(v)) : [];
  const notes = Array.isArray(record.notes) ? record.notes.map(toNote).filter((n): n is ObsidianNote => Boolean(n)) : [];
  return {
    available: record.available === true || vaults.length > 0,
    vaults,
    notes,
    scannedAt: epochMs(record.scanned_at),
    days: typeof record.days === 'number' ? record.days : undefined,
    total: typeof record.total === 'number' ? record.total : notes.length,
    error: str(record.error),
  };
}

/**
 * Deep link that opens a note in the Obsidian app. Obsidian expects the file
 * path without its extension; slashes stay readable. Without a vault name the
 * app opens the note in the vault it last had open, which is right for a
 * phone with one vault.
 */
export function obsidianOpenUrl(vaultName: string | undefined, notePath: string): string {
  const file = notePath.replace(/\.(md|canvas|base)$/iu, '');
  const encodedFile = encodeURIComponent(file).replace(/%2F/gu, '/');
  const vault = vaultName?.trim();
  return vault
    ? `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodedFile}`
    : `obsidian://open?file=${encodedFile}`;
}

/**
 * The vault name to put in links for one note: the person's own choice first,
 * then what the Mac detected as the phone's copy, then the Mac vault's name.
 */
export function resolveLinkVault(note: ObsidianNote, override: string | undefined): string | undefined {
  if (override !== undefined) return override.trim() || undefined;
  return note.phoneVault ?? note.vault;
}

export interface ObsidianDayGroup {
  /** Local midnight, epoch ms. */
  day: number;
  notes: ObsidianNote[];
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Newest day first; notes inside a day keep their newest-first order. */
export function groupNotesByDay(notes: ObsidianNote[]): ObsidianDayGroup[] {
  const groups = new Map<number, ObsidianNote[]>();
  for (const note of [...notes].sort((a, b) => b.at - a.at)) {
    const day = startOfLocalDay(note.at);
    const bucket = groups.get(day);
    if (bucket) bucket.push(note);
    else groups.set(day, [note]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([day, dayNotes]) => ({ day, notes: dayNotes }));
}
