import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObsidianActivity, RestClient } from '@hermes-pwa/core';
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
  return { obsidianActivity: vi.fn().mockResolvedValue(payload) } as unknown as RestClient;
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

  it('lists new notes by day with Obsidian deep links into the phone vault', async () => {
    render(<Obsidian rest={makeRest()} />);
    await waitFor(() => expect(screen.getAllByTestId('obsidian-day')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('obsidian-day');
    expect(within(first!).getByText('Today')).toBeInTheDocument();
    expect(within(second!).getByText('Yesterday')).toBeInTheDocument();

    // The New filter is the default, so the edited client note is not listed yet.
    const links = screen.getAllByTestId('obsidian-note');
    expect(links.map((link) => link.getAttribute('data-action'))).toEqual(['created', 'created']);
    expect(links[0]).toHaveAttribute('href', 'obsidian://open?vault=Vault%201&file=Clients/_Check-in%20Prep%20%E2%80%94%202026-10-24');
    expect(links[1]).toHaveAttribute('href', 'obsidian://open?vault=Vault%201&file=Business%20%26%20Ops/Orders/India%20Drug%20List');
    expect(screen.getByText('obsidian-vault-manager')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change which vault/ })).toHaveTextContent('Opens in Vault 1');
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
    expect(screen.getAllByTestId('obsidian-note')[0]).toHaveAttribute('href', expect.stringContaining('vault=General&'));
    expect(window.localStorage.getItem('hermes-pwa.obsidian.phoneVault.v1')).toBe('General');

    fireEvent.click(screen.getByRole('button', { name: /Change which vault/ }));
    fireEvent.change(screen.getByLabelText('Vault name on this phone'), { target: { value: 'My Notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    expect(screen.getAllByTestId('obsidian-note')[0]).toHaveAttribute('href', expect.stringContaining('vault=My%20Notes&'));
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
});
