import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '@hermes-pwa/core';
import { Messaging } from './Messaging';

const overview = {
  gatewayRunning: true,
  platforms: [
    { id: 'telegram', name: 'Telegram', description: 'Telegram DMs', docsUrl: 'https://t.me', enabled: false, configured: false, state: 'disabled' as const, rawState: 'disabled', errorMessage: undefined, updatedAt: undefined, homeChannel: undefined, requiredSet: 0, requiredTotal: 1 },
    { id: 'signal', name: 'Signal', description: 'signal-cli bridge', docsUrl: undefined, enabled: true, configured: true, state: 'connected' as const, rawState: 'connected', errorMessage: undefined, updatedAt: Date.now() - 120_000, homeChannel: 'Home', requiredSet: 2, requiredTotal: 2 },
    { id: 'slack', name: 'Slack', description: 'Slack', docsUrl: undefined, enabled: true, configured: true, state: 'error' as const, rawState: 'error', errorMessage: 'invalid_auth', updatedAt: Date.now() - 60_000, homeChannel: undefined, requiredSet: 2, requiredTotal: 2 },
  ],
};

describe('Messaging', () => {
  it('lists live bots first with their state and keeps the rest under Available', async () => {
    const rest = { messagingPlatforms: vi.fn().mockResolvedValue(overview) } as unknown as RestClient;
    render(<Messaging rest={rest} />);
    await waitFor(() => expect(screen.getAllByTestId('messaging-platform')).toHaveLength(3));
    const rows = screen.getAllByTestId('messaging-platform');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['connected', 'error', 'disabled']);
    expect(screen.getByText(/Connected · Home: Home/)).toBeInTheDocument();
    expect(screen.getByText(/Error · invalid_auth/)).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('explains when nothing is set up', async () => {
    const rest = { messagingPlatforms: vi.fn().mockResolvedValue({ gatewayRunning: false, platforms: [overview.platforms[0]] }) } as unknown as RestClient;
    render(<Messaging rest={rest} />);
    await waitFor(() => expect(screen.getByText(/No chat app is set up yet/)).toBeInTheDocument());
    expect(screen.getByText(/The gateway is stopped/)).toBeInTheDocument();
  });
});
