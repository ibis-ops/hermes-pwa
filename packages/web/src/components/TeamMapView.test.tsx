import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient, TeamMap } from '@hermes-pwa/core';
import { TeamMapView } from './TeamMapView';

const SAVED: TeamMap = {
  version: 4,
  nodes: {
    manager: { reportsTo: null, canMessage: ['gmail-connector', 'signal-connector'], role: 'Routes work to the connectors.' },
    'gmail-connector': { reportsTo: 'manager', canMessage: ['manager'], role: 'Reads and drafts email.' },
    'signal-connector': { reportsTo: 'manager', canMessage: ['manager'], role: '' },
  },
};

function restWith(saved: TeamMap | undefined, save: (map: TeamMap) => Promise<TeamMap> = async (map) => ({ ...map, version: 5 })): RestClient {
  return {
    botGraph: vi.fn().mockResolvedValue(saved),
    saveBotGraph: save,
    routerStatus: vi.fn().mockResolvedValue({
      settings: { enabled: false, bot: 'router', jevModel: '~typesafe/jev-latest', minConfidence: 0.6 },
      keyConfigured: false,
      staleBots: [],
      updateCommand: '',
      decisions: [],
    }),
  } as unknown as RestClient;
}

const BOTS = ['manager', 'gmail-connector', 'signal-connector'];

describe('TeamMapView', () => {
  it('draws the saved map from Sean down, with each bot under its boss', async () => {
    render(<TeamMapView rest={restWith(SAVED)} bots={BOTS} />);
    const nodes = await screen.findAllByTestId('team-node');
    expect(nodes.map((node) => node.querySelector('.hm-team__node-name')?.textContent)).toEqual([
      'Manager',
      'Gmail Connector',
      'Signal Connector',
    ]);
    expect(nodes[0]).toHaveTextContent('Routes work to the connectors.');
    expect(nodes[0]).toHaveTextContent('Messages Gmail Connector and Signal Connector');
    expect(nodes[1]).toHaveTextContent('Messages only Manager');
    expect(screen.queryByTestId('team-starting')).toBeNull();
  });

  it("moves a bot under another and saves who it reports to", async () => {
    const save = vi.fn(async (map: TeamMap) => ({ ...map, version: 5 }));
    render(<TeamMapView rest={restWith(SAVED, save)} bots={BOTS} />);
    fireEvent.click((await screen.findAllByTestId('team-node'))[2]!);
    const sheet = await screen.findByRole('dialog', { name: 'Signal Connector' });
    fireEvent.click(within(sheet).getByRole('radio', { name: /Gmail Connector/ }));
    fireEvent.change(within(sheet).getByPlaceholderText('What Signal Connector does, in a line'), { target: { value: 'Reads Signal.' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]![0];
    expect(saved.nodes['signal-connector']).toEqual({
      reportsTo: 'gmail-connector',
      canMessage: ['gmail-connector', 'manager'],
      role: 'Reads Signal.',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('never offers a bot under one of its own reports', async () => {
    render(<TeamMapView rest={restWith(SAVED)} bots={BOTS} />);
    fireEvent.click((await screen.findAllByTestId('team-node'))[0]!);
    const sheet = await screen.findByRole('dialog', { name: 'Manager' });
    expect(within(sheet).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['YouSean (top of the map)']);
  });

  it('turns off messaging between two bots', async () => {
    const save = vi.fn(async (map: TeamMap) => ({ ...map, version: 5 }));
    render(<TeamMapView rest={restWith(SAVED, save)} bots={BOTS} />);
    fireEvent.click((await screen.findAllByTestId('team-node'))[0]!);
    const sheet = await screen.findByRole('dialog', { name: 'Manager' });
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Manager can message Signal Connector' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save.mock.calls[0]![0].nodes.manager?.canMessage).toEqual(['gmail-connector']));
  });

  it('lists a new bot apart and adds it under the manager', async () => {
    const save = vi.fn(async (map: TeamMap) => ({ ...map, version: 5 }));
    render(<TeamMapView rest={restWith(SAVED, save)} bots={[...BOTS, 'research']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Research.*Add under Manager/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].nodes.research).toEqual({ reportsTo: 'manager', canMessage: ['manager'], role: '' });
    expect(save.mock.calls[0]![0].nodes.manager?.canMessage).toContain('research');
  });

  it('keeps the sheet open and says so when saving fails', async () => {
    const save = vi.fn<[TeamMap], Promise<TeamMap>>(async () => {
      throw new Error('Could not reach the Mac.');
    });
    render(<TeamMapView rest={restWith(SAVED, save)} bots={BOTS} />);
    fireEvent.click((await screen.findAllByTestId('team-node'))[1]!);
    const sheet = await screen.findByRole('dialog', { name: 'Gmail Connector' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Could not reach the Mac.');
  });
});
