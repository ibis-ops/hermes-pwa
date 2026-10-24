import { describe, expect, it } from 'vitest';
import { groupNotesByDay, obsidianOpenUrl, resolveLinkVault, toObsidianActivity, type ObsidianNote } from './obsidian';

const note = (over: Partial<ObsidianNote> = {}): ObsidianNote => ({
  path: 'Clients/Ann Lee/Ann Lee.md',
  name: 'Ann Lee',
  folder: 'Clients/Ann Lee',
  vault: 'General',
  phoneVault: 'Vault 1',
  action: 'created',
  at: Date.UTC(2026, 9, 24, 15, 44),
  createdAt: Date.UTC(2026, 9, 24, 15, 44),
  editedAt: undefined,
  profile: 'default',
  size: 120,
  ...over,
});

describe('toObsidianActivity', () => {
  it('maps the plugin payload, converting epoch seconds to ms', () => {
    const activity = toObsidianActivity({
      available: true,
      vaults: [{ name: 'General', path: '/Users/s/Desktop/General', open: true, phone_name: 'Vault 1' }],
      notes: [
        {
          path: 'Business & Ops/Orders/India Drug List.md',
          name: 'India Drug List',
          folder: 'Business & Ops/Orders',
          vault: 'General',
          phone_vault: 'Vault 1',
          action: 'created',
          at: 1_761_000_000,
          created_at: 1_761_000_000,
          edited_at: null,
          profile: 'default',
          size: 900,
        },
        { path: 'bad' },
      ],
      scanned_at: 1_761_000_100,
      days: 60,
      total: 1,
    });
    expect(activity.available).toBe(true);
    expect(activity.vaults).toEqual([{ name: 'General', path: '/Users/s/Desktop/General', open: true, phoneName: 'Vault 1' }]);
    expect(activity.notes).toHaveLength(1);
    expect(activity.notes[0]).toMatchObject({ name: 'India Drug List', at: 1_761_000_000_000, action: 'created', phoneVault: 'Vault 1' });
    expect(activity.scannedAt).toBe(1_761_000_100_000);
  });

  it('is empty but well formed for junk', () => {
    const activity = toObsidianActivity(null);
    expect(activity.available).toBe(false);
    expect(activity.notes).toEqual([]);
    expect(activity.total).toBe(0);
  });
});

describe('obsidianOpenUrl', () => {
  it('drops the extension, encodes the vault and keeps folder slashes readable', () => {
    expect(obsidianOpenUrl('Vault 1', 'Business & Ops/Orders/India Drug List.md')).toBe(
      'obsidian://open?vault=Vault%201&file=Business%20%26%20Ops/Orders/India%20Drug%20List',
    );
  });

  it('omits the vault when none is known so Obsidian uses the last open one', () => {
    expect(obsidianOpenUrl(undefined, 'Inbox/Note.canvas')).toBe('obsidian://open?file=Inbox/Note');
    expect(obsidianOpenUrl('  ', 'Inbox/Note.md')).toBe('obsidian://open?file=Inbox/Note');
  });
});

describe('resolveLinkVault', () => {
  it('prefers the override, then the detected phone vault, then the Mac vault', () => {
    expect(resolveLinkVault(note(), 'Mine')).toBe('Mine');
    expect(resolveLinkVault(note(), undefined)).toBe('Vault 1');
    expect(resolveLinkVault(note({ phoneVault: undefined }), undefined)).toBe('General');
    expect(resolveLinkVault(note(), '')).toBeUndefined();
  });
});

describe('groupNotesByDay', () => {
  it('buckets by local day, newest first', () => {
    const today = new Date(2026, 9, 24, 9, 0).getTime();
    const yesterday = new Date(2026, 9, 23, 22, 0).getTime();
    const groups = groupNotesByDay([
      note({ path: 'a.md', at: yesterday }),
      note({ path: 'b.md', at: today }),
      note({ path: 'c.md', at: today + 60_000 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.notes.map((n) => n.path)).toEqual(['c.md', 'b.md']);
    expect(groups[1]?.notes.map((n) => n.path)).toEqual(['a.md']);
    expect(new Date(groups[0]!.day).getHours()).toBe(0);
  });
});
