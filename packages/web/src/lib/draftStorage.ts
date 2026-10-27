/**
 * Composer drafts. They survive a screen switch and an iOS app kill; one per
 * bot, keyed by the bot's name.
 */

const DRAFT_STORAGE_PREFIX = 'hermes-pwa.draft.v1:';

export interface StoredDraft {
  text: string;
  attachments: { id: string; name: string; path: string }[];
}

function draftStorageKey(draftKey: string): string {
  return `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(draftKey)}`;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function readDraft(draftKey: string | undefined): StoredDraft | undefined {
  if (!draftKey || typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(draftStorageKey(draftKey));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter(
          (a): a is StoredDraft['attachments'][number] =>
            Boolean(a) && typeof a === 'object' && typeof (a as { path?: unknown }).path === 'string' && typeof (a as { name?: unknown }).name === 'string',
        )
      : [];
    if (!text && attachments.length === 0) return undefined;
    return { text, attachments: attachments.map((a) => ({ id: typeof a.id === 'string' ? a.id : makeId(), name: a.name, path: a.path })) };
  } catch {
    return undefined;
  }
}

export function writeDraft(draftKey: string | undefined, draft: StoredDraft | undefined): void {
  if (!draftKey || typeof window === 'undefined') return;
  try {
    const key = draftStorageKey(draftKey);
    if (!draft || (!draft.text.trim() && draft.attachments.length === 0)) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage blocked (private mode, quota): the draft lives for this app session only.
  }
}
