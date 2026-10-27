import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesHttpError, useModelStore, useProfilesStore, type RestClient, type RouterStatus, type TeamMap } from '@hermes-pwa/core';
import { RouterCard } from './RouterPanel';

const OFF: RouterStatus = {
  settings: { enabled: false, bot: 'router', jevModel: '', minConfidence: 0.6 },
  keyConfigured: false,
  provider: undefined,
  keyName: 'HERMES_PWA_JEV_API_KEY',
  staleBots: [],
  updateCommand: '',
  decisions: [],
};

const PROFILES = [
  { name: 'default', provider: 'anthropic', model: 'claude-sonnet-5', isActive: true },
  { name: 'manager', provider: 'anthropic', model: 'claude-sonnet-5', isActive: false },
  { name: 'gmail-connector', provider: 'anthropic', model: 'claude-sonnet-5', isActive: false },
];

function makeRest(overrides: Record<string, unknown> = {}): RestClient {
  let profiles = [...PROFILES];
  return {
    routerStatus: vi.fn().mockResolvedValue(OFF),
    saveRouter: vi.fn(async (patch: Partial<RouterStatus['settings']>) => ({ ...OFF, settings: { ...OFF.settings, ...patch } })),
    modelOptions: vi.fn().mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      providers: [{ name: 'Anthropic', slug: 'anthropic', models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'], authenticated: true }],
    }),
    profileList: vi.fn(async () => profiles),
    profileActive: vi.fn().mockResolvedValue({ active: 'default', current: 'default' }),
    profileCreate: vi.fn(async (body: { name: string }) => {
      profiles = [...profiles, { name: body.name, provider: 'anthropic', model: 'claude-sonnet-5', isActive: false }];
      return { ok: true, name: body.name };
    }),
    profileUpdateModel: vi.fn().mockResolvedValue({ ok: true }),
    botGraph: vi.fn().mockResolvedValue(undefined),
    saveBotGraph: vi.fn(async (map: TeamMap) => ({ ...map, version: 1 })),
    ...overrides,
  } as unknown as RestClient;
}

describe('RouterCard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProfilesStore.setState({ profiles: PROFILES, activeName: 'default', currentName: 'default', loading: false, error: undefined });
    useModelStore.setState({ options: undefined, info: undefined, auxiliary: undefined, loading: false, setting: false, error: undefined });
  });

  it('says the router waits on a dashboard restart when the Mac does not have it yet', async () => {
    render(<RouterCard rest={makeRest({ routerStatus: vi.fn().mockRejectedValue(new HermesHttpError(404, 'Not Found', 'nope')) })} bots={['default']} onMapChanged={vi.fn()} />);
    expect(await screen.findByTestId('router-card')).toHaveTextContent('Turns on once the Hermes dashboard on your Mac restarts.');
  });

  it('sets Router up in one tap: a fast model, on top of the map, routing on', async () => {
    const rest = makeRest();
    const onMapChanged = vi.fn();
    render(<RouterCard rest={rest} bots={PROFILES.map((p) => p.name)} onMapChanged={onMapChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Router settings' }));
    const sheet = await screen.findByRole('dialog', { name: 'Set up Router' });
    await waitFor(() => expect(within(sheet).getByRole('combobox', { name: "Router's model" })).toHaveValue('claude-haiku-4-5'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set up Router' }));

    await waitFor(() => expect(rest.saveRouter).toHaveBeenCalledWith({ enabled: true, bot: 'router' }));
    expect(rest.profileCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'router', clone_from_default: true }));
    expect(rest.profileUpdateModel).toHaveBeenCalledWith('router', expect.objectContaining({ provider: 'anthropic', model: 'claude-haiku-4-5', reasoning_effort: 'none' }));
    const map = (rest.saveBotGraph as ReturnType<typeof vi.fn>).mock.calls[0]![0] as TeamMap;
    expect(map.nodes.router).toMatchObject({ reportsTo: null, canMessage: ['default', 'gmail-connector', 'manager'] });
    expect(map.nodes.manager?.reportsTo).toBe('router');
    expect(onMapChanged).toHaveBeenCalled();
  });

  it('changes the settings of a router that exists, and explains the missing Jev key', async () => {
    const on: RouterStatus = {
      ...OFF,
      settings: { ...OFF.settings, enabled: true },
      decisions: [
        { at: '2026-10-27T20:00:00Z', bot: 'router', sessionId: 's', key: 'k', preview: 'Any email from clients?', route: 'gmail-connector', guess: null, confidence: 0.9, source: 'jev', reason: '', ms: 300, cost: 0.00002, provider: 'vercel', zdr: true },
      ],
    };
    const rest = makeRest({ routerStatus: vi.fn().mockResolvedValue(on) });
    const onOpenBot = vi.fn();
    render(<RouterCard rest={rest} bots={[...PROFILES.map((p) => p.name), 'router']} onMapChanged={vi.fn()} onOpenBot={onOpenBot} />);
    const card = await screen.findByRole('button', { name: 'Router settings' });
    expect(card).toHaveTextContent('On, but Jev needs its key on the Mac');
    fireEvent.click(card);
    const sheet = await screen.findByRole('dialog', { name: 'Router' });
    expect(within(sheet).getByTestId('router-key')).toHaveTextContent('hermes config set HERMES_PWA_JEV_API_KEY "$(pbpaste)"');
    expect(within(sheet).getByTestId('router-decision')).toHaveTextContent('Sent to Gmail Connector · Jev 90% sure');
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Route with Jev' }));
    await waitFor(() => expect(rest.saveRouter).toHaveBeenCalledWith({ enabled: false }));
    await waitFor(() => expect(within(sheet).getByRole('radio', { name: 'Strict 75%' })).not.toBeDisabled());
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Strict 75%' }));
    await waitFor(() => expect(rest.saveRouter).toHaveBeenCalledWith({ minConfidence: 0.75 }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Message' }));
    expect(onOpenBot).toHaveBeenCalledWith('router');
  });

  it('says which bots run an older copy of the plugin, with the command that updates them', async () => {
    const stale: RouterStatus = {
      ...OFF,
      staleBots: ['manager', 'gmail-connector', 'signal-connector', 'router'],
      updateCommand: 'for bot in manager gmail-connector signal-connector router; do hermes -p "$bot" plugins update hermes-pwa; done',
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<RouterCard rest={makeRest({ routerStatus: vi.fn().mockResolvedValue(stale) })} bots={[...PROFILES.map((p) => p.name), 'router']} onMapChanged={vi.fn()} />);
    const note = await screen.findByTestId('router-stale');
    expect(note).toHaveTextContent('Manager, Gmail Connector and 2 more bots run an older copy of this app\'s plugin');
    fireEvent.click(within(note).getByRole('button', { name: 'Copy the command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(stale.updateCommand));
    expect(await within(note).findByText('Copied')).toBeInTheDocument();
  });

  it('says plainly On when Jev answered the newest message, even unsure', async () => {
    const answered: RouterStatus = {
      ...OFF,
      settings: { ...OFF.settings, enabled: true },
      keyConfigured: true,
      provider: 'Vercel AI Gateway',
      decisions: [
        { at: '2026-10-27T21:10:00Z', bot: 'router', sessionId: 's', key: 'c', preview: 'hmm', route: null, guess: 'manager', confidence: 0.4, source: 'router', reason: 'Jev was not sure', ms: 210, cost: 0.00001, provider: 'vercel', zdr: null },
      ],
    };
    render(<RouterCard rest={makeRest({ routerStatus: vi.fn().mockResolvedValue(answered) })} bots={[...PROFILES.map((p) => p.name), 'router']} onMapChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Router settings' })).toHaveTextContent('On: Jev picks who takes each message.');
  });

  it('shows no update notice when every copy matches', async () => {
    render(<RouterCard rest={makeRest()} bots={PROFILES.map((p) => p.name)} onMapChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Router settings' });
    expect(screen.queryByTestId('router-stale')).toBeNull();
  });

  it('says which service Jev runs through and whether zero data retention is on', async () => {
    const connected: RouterStatus = {
      ...OFF,
      settings: { ...OFF.settings, enabled: true },
      keyConfigured: true,
      provider: 'Vercel AI Gateway',
      decisions: [
        { at: '2026-10-27T21:05:00Z', bot: 'router', sessionId: 's', key: 'a', preview: 'Out of credits?', route: null, guess: null, confidence: null, source: 'router', reason: 'Vercel AI Gateway is out of credits', ms: 120, cost: null, provider: 'vercel', zdr: null },
        { at: '2026-10-27T21:00:00Z', bot: 'router', sessionId: 's', key: 'b', preview: 'hi', route: 'answer', guess: null, confidence: 0.97, source: 'jev', reason: '', ms: 200, cost: 0.00001, provider: 'vercel', zdr: false },
      ],
    };
    render(<RouterCard rest={makeRest({ routerStatus: vi.fn().mockResolvedValue(connected) })} bots={[...PROFILES.map((p) => p.name), 'router']} onMapChanged={vi.fn()} />);
    const card = await screen.findByRole('button', { name: 'Router settings' });
    // The newest message got no answer from Jev, so the card says why instead of "On".
    expect(card).toHaveTextContent('On, but Jev did not answer last time: Vercel AI Gateway is out of credits. Router decides for now.');
    fireEvent.click(card);
    const sheet = await screen.findByRole('dialog', { name: 'Router' });
    expect(within(sheet).getByTestId('router-key')).toHaveTextContent('Connected through Vercel AI Gateway on the Mac. Zero data retention is off');
    expect(within(sheet).getAllByTestId('router-decision')[0]).toHaveTextContent('Router decided · Vercel AI Gateway is out of credits');
  });
});
