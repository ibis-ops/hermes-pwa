import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesHttpError, type ObsidianActivity, type RestClient } from '@hermes-pwa/core';
import { Obsidian } from './Obsidian';

const NOW = new Date(2026, 9, 24, 12, 30).getTime();
const today = (h: number, m = 0) => new Date(2026, 9, 24, h, m).getTime();
const yesterday = (h: number, m = 0) => new Date(2026, 9, 23, h, m).getTime();

const activity: ObsidianActivity = {
  available: true,
  vaults: [{ name: 'General', path: '/Users/s/Desktop/General', phoneName: 'Vault 1', open: true }],
  notes: [
    { path: 'Clients/John Sanford/John Sanford.md', name: 'John Sanford', folder: 'Clients/John Sanford', vault: 'General', phoneVault: 'Vault 1', action: 'edited', at: today(9, 16), createdAt: undefined, editedAt: today(9, 16), profile: 'default', size: 10 },
    { path: 'Clients/_Check-in Prep — 2026-10-24.md', name: '_Check-in Prep — 2026-10-24', folder: 'Clients', vault: 'General', phoneVault: 'Vault 1', action: 'created', at: today(8, 43), createdAt: today(8, 43), editedAt: undefined, profile: 'default', size: 10 },
    { path: 'Business & Ops/Orders/India Drug List.md', name: 'India Drug List', folder: 'Business & Ops/Orders', vault: 'General', phoneVault: 'Vault 1', action: 'created', at: yesterday(21, 39), createdAt: yesterday(21, 39), editedAt: undefined, profile: 'obsidian-vault-manager', size: 10 },
  ],
  scannedAt: NOW,
  days: 60,
  total: 3,
  error: undefined,
};

function makeRest(payload: ObsidianActivity = activity): RestClient {
  return {
    obsidianActivity: vi.fn().mockResolvedValue(payload),
    obsidianNote: vi.fn().mockImplementation((vault: string, path: string) =>
      Promise.resolve({
        vault,
        phoneVault: 'Vault 1',
        path,
        name: path.split('/').pop()?.replace(/\.md$/u, '') ?? path,
        text: '---\ntype: note\ntags: [client]\n---\n\n# Heading\n\nBody with [[Other|a link]].',
        size: 60,
        modifiedAt: today(9, 0),
      }),
    ),
  } as unknown as RestClient;
}

describe('Obsidian', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists new notes by day and opens one in the viewer with an Obsidian link into the phone vault', async () => {
    const rest = makeRest();
    render(<Obsidian rest={rest} />);
    await waitFor(() => expect(screen.getAllByTestId('obsidian-day')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('obsidian-day');
    expect(within(first!).getByText('Today')).toBeInTheDocument();
    expect(within(second!).getByText('Yesterday')).toBeInTheDocument();

    // The New filter is the default, so the edited client note is not listed yet.
    const rows = screen.getAllByTestId('obsidian-note');
    expect(rows.map((row) => row.getAttribute('data-action'))).toEqual(['created', 'created']);
    expect(screen.getByText('obsidian-vault-manager')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change which vault/ })).toHaveTextContent('Opens in Vault 1');

    fireEvent.click(rows[1]!);
    expect(rest.obsidianNote).toHaveBeenCalledWith('General', 'Business & Ops/Orders/India Drug List.md');
    await waitFor(() => expect(screen.getByTestId('note-body')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('a link')).toBeInTheDocument();
    expect(within(screen.getByTestId('note-properties')).getByText('client')).toBeInTheDocument();
    expect(screen.getByTestId('note-open-link')).toHaveAttribute(
      'href',
      'obsidian://open?vault=Vault%201&file=Business%20%26%20Ops/Orders/India%20Drug%20List',
    );
  });

  it('filters to edited notes and to everything', async () => {
    render(<Obsidian rest={makeRest()} />);
    await waitFor(() => expect(screen.getAllByTestId('obsidian-note')).toHaveLength(2));
    fireEvent.click(screen.getByRole('tab', { name: /Edited/ }));
    expect(screen.getAllByTestId('obsidian-note')).toHaveLength(1);
    expect(screen.getByText('John Sanford')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    expect(screen.getAllByTestId('obsidian-note')).toHaveLength(3);
  });

  it('lets the person choose the vault name the links open and remembers it', async () => {
    render(<Obsidian rest={makeRest()} />);
    await waitFor(() => expect(screen.getAllByTestId('obsidian-note')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Change which vault/ }));
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByRole('button', { name: /Change which vault/ })).toHaveTextContent('Opens in General');
    expect(window.localStorage.getItem('hermes-pwa.obsidian.phoneVault.v1')).toBe('General');

    fireEvent.click(screen.getByRole('button', { name: /Change which vault/ }));
    fireEvent.change(screen.getByLabelText('Vault name on this phone'), { target: { value: 'My Notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    fireEvent.click(screen.getAllByTestId('obsidian-note')[0]!);
    await waitFor(() => expect(screen.getByTestId('note-open-link')).toHaveAttribute('href', expect.stringContaining('vault=My%20Notes&')));
  });

  it('shows the read error inside the viewer', async () => {
    const rest = makeRest();
    (rest.obsidianNote as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('note not found'));
    render(<Obsidian rest={rest} />);
    await waitFor(() => expect(screen.getAllByTestId('obsidian-note')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('obsidian-note')[0]!);
    await waitFor(() => expect(screen.getByText('note not found')).toBeInTheDocument());
    expect(screen.getByTestId('note-open-link')).toBeInTheDocument();
  });

  it('explains when no vault was found or nothing was written', async () => {
    const { unmount } = render(<Obsidian rest={makeRest({ ...activity, available: false, vaults: [], notes: [], total: 0 })} />);
    await waitFor(() => expect(screen.getByText(/No Obsidian vault was found on the Mac/)).toBeInTheDocument());
    unmount();

    render(<Obsidian rest={makeRest({ ...activity, notes: [], total: 0 })} />);
    await waitFor(() => expect(screen.getByText(/No new notes from your bots/)).toBeInTheDocument());
  });

  it('shows the error when the Mac cannot be reached', async () => {
    const rest = { obsidianActivity: vi.fn().mockRejectedValue(new Error('Gateway offline')) } as unknown as RestClient;
    render(<Obsidian rest={rest} />);
    await waitFor(() => expect(screen.getByText('Gateway offline')).toBeInTheDocument());
  });

  it('syncs the vault: opens Obsidian on the Mac when needed, rescans, and offers Obsidian here', async () => {
    const rest = makeRest();
    const obsidianSync = vi.fn().mockResolvedValue({ available: true, running: true, started: true });
    (rest as unknown as { obsidianSync: typeof obsidianSync }).obsidianSync = obsidianSync;
    render(<Obsidian rest={rest} />);
    await waitFor(() => expect(screen.getAllByTestId('obsidian-day')).toHaveLength(2));
    fireEvent.click(screen.getByTestId('obsidian-sync'));
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('Opened Obsidian on your Mac so Sync can catch up.');
    expect(within(note).getByRole('link', { name: 'Open Obsidian here' })).toHaveAttribute('href', 'obsidian://open?vault=Vault%201');
    expect(obsidianSync).toHaveBeenCalledTimes(1);
    expect(rest.obsidianActivity).toHaveBeenCalledTimes(2);
  });

  it('still refreshes the list when the Mac runs an older dashboard', async () => {
    const rest = makeRest();
    (rest as unknown as { obsidianSync: () => Promise<never> }).obsidianSync = () => Promise.reject(new HermesHttpError(404, 'Not Found', 'no route'));
    render(<Obsidian rest={rest} />);
    await waitFor(() => expect(screen.getAllByTestId('obsidian-day')).toHaveLength(2));
    fireEvent.click(screen.getByTestId('obsidian-sync'));
    expect(await screen.findByRole('status')).toHaveTextContent('Restart the Hermes dashboard on your Mac');
    expect(rest.obsidianActivity).toHaveBeenCalledTimes(2);
  });

  it('explains a missing notes list in words, not the server JSON', async () => {
    const rest = makeRest();
    (rest as unknown as { obsidianActivity: () => Promise<never> }).obsidianActivity = vi
      .fn()
      .mockRejectedValue(new HermesHttpError(404, 'Not Found', '{"detail":"Not Found"}'));
    render(<Obsidian rest={rest} />);
    expect(await screen.findByText(/did not answer with the notes list/)).toBeInTheDocument();
    expect(screen.queryByText(/detail/)).toBeNull();
  });
});
