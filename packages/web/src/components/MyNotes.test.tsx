import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HermesHttpError,
  type MyNote,
  type MyNoteContent,
  type MyNotes as MyNotesList,
  type RestClient,
} from '@hermes-pwa/core';
import { MyNotes } from './MyNotes';
import { formatListTime } from '../lib/chatTime';
import { noteDraftKey, readNoteDraft } from '../lib/noteDrafts';

const NOW = new Date(2026, 9, 27, 21, 0).getTime();
const at = (daysAgo: number, hour: number, minute = 0) =>
  new Date(2026, 9, 27 - daysAgo, hour, minute).getTime();

const gym: MyNote = {
  name: 'Gym ideas.md',
  title: 'Gym ideas',
  path: 'Notes from Sean/Gym ideas.md',
  modifiedAt: at(0, 20, 15),
  size: 40,
  preview: 'Leg day: squats',
};
const trip: MyNote = {
  name: 'Trip.md',
  title: 'Trip',
  path: 'Notes from Sean/Trip.md',
  modifiedAt: at(1, 9),
  size: 0,
  preview: '',
};
const GYM_TEXT = '---\ntags: [gym]\n---\n# Plan\n\nLeg day: **squats**';

function list(notes: MyNote[], extra: Partial<MyNotesList> = {}): MyNotesList {
  return {
    available: true,
    vault: 'General',
    phoneVault: 'Vault 1',
    folder: 'Notes from Sean',
    exists: true,
    notes,
    total: notes.length,
    scannedAt: NOW,
    maxBytes: 1_048_576,
    error: undefined,
    reason: undefined,
    ...extra,
  };
}

function content(note: MyNote, text: string, version = 'v1'): MyNoteContent {
  return {
    vault: 'General',
    phoneVault: 'Vault 1',
    folder: 'Notes from Sean',
    name: note.name,
    title: note.title,
    path: note.path,
    text,
    size: text.length,
    modifiedAt: note.modifiedAt,
    version,
    editable: true,
  };
}

function renamed(name: string): MyNote {
  const title = name.replace(/\.md$/, '');
  return { name, title, path: `Notes from Sean/${name}`, modifiedAt: NOW, size: 0, preview: '' };
}

function makeRest(listed: MyNotesList = list([gym, trip])) {
  const mocks = {
    myNotes: vi.fn().mockResolvedValue(listed),
    myNote: vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve(name === gym.name ? content(gym, GYM_TEXT) : content(trip, '')),
      ),
    createMyNote: vi.fn(),
    saveMyNote: vi.fn(),
    obsidianSync: vi.fn().mockResolvedValue({ available: true, running: true, started: false }),
  };
  return { rest: mocks as unknown as RestClient, mocks };
}

async function openNote(title: string) {
  const row = (await screen.findAllByTestId('my-note')).find((candidate) =>
    within(candidate).queryByText(title),
  );
  fireEvent.click(row!);
}

/** Edit waits for the note to arrive from the Mac before it can be tapped. */
async function tap(name: string) {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('MyNotes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the notes newest first with when each was edited and its first line', async () => {
    const { rest } = makeRest();
    render(<MyNotes rest={rest} phoneVault={undefined} />);
    const rows = await screen.findAllByTestId('my-note');
    expect(rows.map((row) => row.querySelector('.hm-my-note__title')?.textContent)).toEqual([
      'Gym ideas',
      'Trip',
    ]);
    expect(within(rows[0]!).getByText(formatListTime(gym.modifiedAt!, NOW))).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Leg day: squats')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Yesterday')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('No additional text')).toBeInTheDocument();
    expect(screen.getByText('2 notes')).toBeInTheDocument();
    expect(screen.getByText(/Notes from Sean folder of the General vault/)).toBeInTheDocument();
  });

  it('opens a note as the note viewer shows notes, then saves an edit with the version it was read at', async () => {
    const { rest, mocks } = makeRest();
    mocks.saveMyNote.mockImplementation((_name: string, text: string) =>
      Promise.resolve(content(gym, text, 'v2')),
    );
    render(<MyNotes rest={rest} phoneVault={undefined} />);
    await openNote('Gym ideas');
    expect(mocks.myNote).toHaveBeenCalledWith('Gym ideas.md');
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    expect(within(screen.getByTestId('note-properties')).getByText('gym')).toBeInTheDocument();
    expect(screen.getByText('squats').tagName).toBe('STRONG');
    expect(screen.getByText(/^General · edited Today/)).toBeInTheDocument();
    expect(screen.getByTestId('note-open-link')).toHaveAttribute(
      'href',
      'obsidian://open?vault=Vault%201&file=Notes%20from%20Sean/Gym%20ideas',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByLabelText('Note text');
    expect(field).toHaveValue(GYM_TEXT);
    // Nothing changed yet, so there is nothing to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '# Plan\n\nLeg day: squats and lunges' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved to your Mac.')).toBeInTheDocument();
    expect(mocks.saveMyNote).toHaveBeenCalledWith(
      'Gym ideas.md',
      '# Plan\n\nLeg day: squats and lunges',
      'v1',
    );
    expect(screen.getByText('Leg day: squats and lunges')).toBeInTheDocument();
    expect(screen.queryByLabelText('Note text')).toBeNull();
    await waitFor(() => expect(mocks.myNotes).toHaveBeenCalledTimes(2));
    expect(readNoteDraft(noteDraftKey('Gym ideas.md'))).toBeUndefined();
  });

  it('writes a new note with a title and text; the folder is made on the first save', async () => {
    const { rest, mocks } = makeRest(list([], { exists: false }));
    mocks.createMyNote.mockImplementation((_title: string, text: string) =>
      Promise.resolve(content(renamed('Groceries.md'), text, 'v9')),
    );
    render(<MyNotes rest={rest} phoneVault={undefined} />);
    expect(
      await screen.findByText(/folder is made on your Mac when you save it/),
    ).toBeInTheDocument();
    expect(screen.getByText('No notes')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('my-notes-new'));
    const title = screen.getByLabelText('Title');
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.getByText('Saves to Notes from Sean in General')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(title, { target: { value: 'Groceries' } });
    fireEvent.change(screen.getByLabelText('Note text'), { target: { value: 'Milk\nEggs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved to your Mac.')).toBeInTheDocument();
    expect(mocks.createMyNote).toHaveBeenCalledWith('Groceries', 'Milk\nEggs');
    expect(screen.getByRole('heading', { name: 'Groceries' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(readNoteDraft(noteDraftKey(undefined))).toBeUndefined();
  });

  it('keeps the text when the note changed on the Mac, and saves it as a new note instead', async () => {
    const { rest, mocks } = makeRest();
    mocks.saveMyNote.mockRejectedValue(
      new HermesHttpError(
        409,
        'Conflict',
        JSON.stringify({
          detail: 'the note changed on the Mac after it was opened',
          reason: 'changed',
          version: 'v5',
        }),
      ),
    );
    mocks.createMyNote.mockImplementation((_title: string, text: string) =>
      Promise.resolve(content(renamed('Gym ideas 1.md'), text, 'v6')),
    );
    render(<MyNotes rest={rest} phoneVault={undefined} />);
    await openNote('Gym ideas');
    await tap('Edit');
    fireEvent.change(screen.getByLabelText('Note text'), {
      target: { value: 'Mine, from the phone' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('my-note-blocked')).toHaveTextContent(
      'This note changed on your Mac after you started these changes.',
    );
    expect(screen.getByLabelText('Note text')).toHaveValue('Mine, from the phone');
    // The text is kept on the phone until it is saved somewhere.
    await waitFor(() =>
      expect(readNoteDraft(noteDraftKey('Gym ideas.md'))?.text).toBe('Mine, from the phone'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save as new note' }));
    expect(await screen.findByText('Saved to your Mac as “Gym ideas 1”.')).toBeInTheDocument();
    expect(mocks.createMyNote).toHaveBeenCalledWith('Gym ideas', 'Mine, from the phone');
    expect(mocks.saveMyNote).toHaveBeenCalledTimes(1);
    expect(readNoteDraft(noteDraftKey('Gym ideas.md'))).toBeUndefined();
  });

  it('discards changes only on a second tap, and shows the note as it is on the Mac', async () => {
    const { rest, mocks } = makeRest();
    mocks.saveMyNote.mockRejectedValue(
      new HermesHttpError(
        404,
        'Not Found',
        JSON.stringify({ detail: 'note not found', reason: 'gone' }),
      ),
    );
    render(<MyNotes rest={rest} phoneVault={undefined} />);
    await openNote('Gym ideas');
    await tap('Edit');
    fireEvent.change(screen.getByLabelText('Note text'), {
      target: { value: 'Typed on the phone' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('my-note-blocked')).toHaveTextContent(
      'This note is no longer on your Mac.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes' }));
    expect(screen.getByTestId('my-note-discard-confirm')).toHaveTextContent(
      'Discard your changes? They are only on this phone.',
    );
    expect(screen.getByLabelText('Note text')).toHaveValue('Typed on the phone');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    expect(mocks.myNote).toHaveBeenCalledTimes(2);
    expect(readNoteDraft(noteDraftKey('Gym ideas.md'))).toBeUndefined();
  });

  it('brings back text that was not saved when the sheet closed, and marks the note in the list', async () => {
    const { rest } = makeRest();
    render(<MyNotes rest={rest} phoneVault={undefined} />);

    // A new note, closed before saving.
    fireEvent.click(await screen.findByTestId('my-notes-new'));
    fireEvent.change(screen.getByLabelText('Note text'), { target: { value: 'Call the physio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText('Note text')).toBeNull());
    fireEvent.click(screen.getByTestId('my-notes-new'));
    expect(screen.getByLabelText('Note text')).toHaveValue('Call the physio');
    expect(screen.getByText('Brought back what you had not saved.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard this note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Note text')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText('Note text')).toBeNull());

    // An edit, closed before saving: the row says so, and Edit picks it up again.
    await openNote('Gym ideas');
    await tap('Edit');
    fireEvent.change(screen.getByLabelText('Note text'), {
      target: { value: 'Half way through an edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText('Note text')).toBeNull());
    const row = (await screen.findAllByTestId('my-note'))[0]!;
    expect(within(row).getByText('Unsaved edits')).toBeInTheDocument();
    fireEvent.click(row);
    await tap('Keep editing');
    expect(screen.getByLabelText('Note text')).toHaveValue('Half way through an edit');
    expect(screen.getByText('Brought back what you had not saved.')).toBeInTheDocument();
  });

  it('does not send a note over the size the Mac takes, and keeps the text when the Mac cannot be reached', async () => {
    const { rest, mocks } = makeRest(list([gym], { maxBytes: 10 }));
    mocks.createMyNote.mockRejectedValue(new TypeError('Load failed'));
    render(<MyNotes rest={rest} phoneVault={undefined} />);
    fireEvent.click(await screen.findByTestId('my-notes-new'));
    const field = screen.getByLabelText('Note text');
    fireEvent.change(field, { target: { value: 'twelve chars' } });
    expect(screen.getByText('Too long to save. Notes can be up to 1 KB.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(field, { target: { value: 'é is two' } });
    expect(screen.queryByText(/Too long to save/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'Could not reach your Mac. Your text stays on this phone; save again when you are connected.',
      ),
    ).toBeInTheDocument();
    expect(field).toHaveValue('é is two');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('explains a missing vault, an older dashboard and an unreachable Mac in words', async () => {
    const noVault = makeRest(
      list([], {
        available: false,
        vault: undefined,
        exists: false,
        error: 'no Obsidian vault was found on this Mac',
        reason: 'no_vault',
      }),
    );
    const { unmount } = render(<MyNotes rest={noVault.rest} phoneVault={undefined} />);
    expect(await screen.findByText(/No Obsidian vault was found on your Mac/)).toBeInTheDocument();
    expect(screen.getByTestId('my-notes-new')).toBeDisabled();
    unmount();

    const oldMac = makeRest();
    oldMac.mocks.myNotes.mockRejectedValueOnce(
      new HermesHttpError(404, 'Not Found', '{"detail":"Not Found"}'),
    );
    const second = render(<MyNotes rest={oldMac.rest} phoneVault={undefined} />);
    expect(await screen.findByText(/Restart the Hermes dashboard on the Mac/)).toBeInTheDocument();
    expect(screen.queryByText(/detail/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByTestId('my-note')).toHaveLength(2);
    second.unmount();

    const offline = makeRest();
    offline.mocks.myNotes.mockRejectedValue(new TypeError('Load failed'));
    render(<MyNotes rest={offline.rest} phoneVault={undefined} />);
    expect(
      await screen.findByText('Could not reach your Mac. Check your connection, then try again.'),
    ).toBeInTheDocument();
  });

  it('opens notes in the vault named for this phone', async () => {
    const { rest } = makeRest();
    render(<MyNotes rest={rest} phoneVault="My Phone Vault" />);
    await openNote('Trip');
    expect(
      await screen.findByText('This note is empty. Tap Edit to write in it.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('note-open-link')).toHaveAttribute(
      'href',
      'obsidian://open?vault=My%20Phone%20Vault&file=Notes%20from%20Sean/Trip',
    );
  });
});
