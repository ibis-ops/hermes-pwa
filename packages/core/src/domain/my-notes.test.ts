import { describe, expect, it } from 'vitest';
import {
  MY_NOTES_FOLDER,
  myNoteProblem,
  myNoteTitle,
  toMyNoteContent,
  toMyNotes,
} from './my-notes';

describe('toMyNotes', () => {
  it('maps the plugin payload, converting epoch seconds to ms and keeping newest first', () => {
    const list = toMyNotes({
      available: true,
      vault: 'General',
      phone_vault: 'Vault 1',
      chosen_by: 'open',
      folder: 'Notes from Sean',
      exists: true,
      notes: [
        {
          name: 'Older.md',
          title: 'Older',
          path: 'Notes from Sean/Older.md',
          modified_at: 1_761_000_000,
          size: 12,
          preview: 'first line',
        },
        {
          name: 'Gym ideas.md',
          title: 'Gym ideas',
          path: 'Notes from Sean/Gym ideas.md',
          modified_at: 1_761_000_500,
          size: 40,
          preview: 'Leg day',
        },
      ],
      total: 2,
      scanned_at: 1_761_000_600,
      max_bytes: 1_048_576,
    });
    expect(list).toEqual({
      available: true,
      vault: 'General',
      phoneVault: 'Vault 1',
      folder: 'Notes from Sean',
      exists: true,
      notes: [
        {
          name: 'Gym ideas.md',
          title: 'Gym ideas',
          path: 'Notes from Sean/Gym ideas.md',
          modifiedAt: 1_761_000_500_000,
          size: 40,
          preview: 'Leg day',
        },
        {
          name: 'Older.md',
          title: 'Older',
          path: 'Notes from Sean/Older.md',
          modifiedAt: 1_761_000_000_000,
          size: 12,
          preview: 'first line',
        },
      ],
      total: 2,
      scannedAt: 1_761_000_600_000,
      maxBytes: 1_048_576,
      error: undefined,
      reason: undefined,
    });
  });

  it('drops entries that are not notes in the folder and fills what is missing', () => {
    const list = toMyNotes({
      available: true,
      notes: [
        { name: 'Plain.md' },
        { name: '../escape.md' },
        { name: '.hidden.md' },
        { name: 'photo.png' },
        { title: 'no name' },
        null,
        'x',
      ],
    });
    expect(list.folder).toBe(MY_NOTES_FOLDER);
    expect(list.notes).toEqual([
      {
        name: 'Plain.md',
        title: 'Plain',
        path: 'Notes from Sean/Plain.md',
        modifiedAt: undefined,
        size: undefined,
        preview: '',
      },
    ]);
    expect(list.exists).toBe(true);
    expect(list.total).toBe(1);
  });

  it('is empty but well formed for junk, and says why when no vault was found', () => {
    expect(toMyNotes(null)).toMatchObject({
      available: false,
      notes: [],
      total: 0,
      exists: false,
      folder: MY_NOTES_FOLDER,
      reason: undefined,
    });
    expect(
      toMyNotes({
        available: false,
        error: 'no Obsidian vault was found on this Mac',
        reason: 'no_vault',
      }),
    ).toMatchObject({
      error: 'no Obsidian vault was found on this Mac',
      reason: 'no_vault',
    });
  });
});

describe('toMyNoteContent', () => {
  it('maps one note with its version', () => {
    const content = toMyNoteContent({
      vault: 'General',
      phone_vault: 'Vault 1',
      folder: 'Notes from Sean',
      name: 'Gym ideas.md',
      title: 'Gym ideas',
      path: 'Notes from Sean/Gym ideas.md',
      text: '# Gym\n\nLeg day',
      size: 14,
      modified_at: 1_761_000_000,
      version: 'abc123',
      editable: true,
    });
    expect(content).toEqual({
      vault: 'General',
      phoneVault: 'Vault 1',
      folder: 'Notes from Sean',
      name: 'Gym ideas.md',
      title: 'Gym ideas',
      path: 'Notes from Sean/Gym ideas.md',
      text: '# Gym\n\nLeg day',
      size: 14,
      modifiedAt: 1_761_000_000_000,
      version: 'abc123',
      editable: true,
    });
  });

  it('is not editable without a version or when the Mac says so', () => {
    expect(toMyNoteContent({ name: 'A.md', text: 'x' })).toMatchObject({
      title: 'A',
      path: 'Notes from Sean/A.md',
      version: '',
      editable: false,
    });
    expect(
      toMyNoteContent({ name: 'A.md', text: 'x', version: 'v', editable: false }).editable,
    ).toBe(false);
    expect(toMyNoteContent(undefined)).toMatchObject({
      name: '',
      text: '',
      path: '',
      editable: false,
    });
  });
});

describe('myNoteTitle', () => {
  it('drops the extension only', () => {
    expect(myNoteTitle('Gym ideas.md')).toBe('Gym ideas');
    expect(myNoteTitle('Notes.MD')).toBe('Notes');
    expect(myNoteTitle('v1.2 plan.md')).toBe('v1.2 plan');
  });
});

describe('myNoteProblem', () => {
  const body = (detail: string, reason?: string) =>
    JSON.stringify(reason ? { detail, reason } : { detail });

  it('reads the reason code the plugin sends with a refusal', () => {
    expect(
      myNoteProblem(409, body('the note changed on the Mac after it was opened', 'changed')),
    ).toBe('changed');
    expect(myNoteProblem(404, body('note not found', 'gone'))).toBe('gone');
    expect(myNoteProblem(403, body('the note is read-only on the Mac', 'read_only'))).toBe(
      'read-only',
    );
    expect(myNoteProblem(403, body('links are not followed', 'not_allowed'))).toBe('not-allowed');
    expect(myNoteProblem(413, body('note too large', 'too_large'))).toBe('too-large');
    expect(myNoteProblem(404, body('no Obsidian vault was found on this Mac', 'no_vault'))).toBe(
      'no-vault',
    );
    expect(
      myNoteProblem(
        404,
        body('HERMES_PWA_NOTES_VAULT does not name an Obsidian vault on this Mac', 'bad_setting'),
      ),
    ).toBe('no-vault');
  });

  it('falls back on the status when there is no code', () => {
    // The dashboard's own 404: the Mac runs a plugin without these routes.
    expect(myNoteProblem(404, '{"detail":"Not Found"}')).toBe('old-mac');
    expect(myNoteProblem(413, 'request body too large')).toBe('too-large');
    expect(myNoteProblem(409, body('too many notes have this title', 'taken'))).toBe('other');
    expect(myNoteProblem(500, body('could not save the note'))).toBe('other');
    expect(myNoteProblem(400, '["not", "an", "object"]')).toBe('other');
    expect(myNoteProblem(403, body('x', 'constructor'))).toBe('other');
  });
});
