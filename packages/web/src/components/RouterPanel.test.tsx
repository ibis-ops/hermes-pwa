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
  unreachable: [],
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
        { at: '2026-10-27T20:00:00Z', bot: 'router', sessionId: 's', key: 'k', preview: 'Any email from clients?', route: 'gmail-connector', guess: null, confidence: 0.9, source: 'jev', reason: '', ms: 300, cost: 0.00002, provider: 'vercel', zdr: true, split: false, blocked: false },
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
        { at: '2026-10-27T21:10:00Z', bot: 'router', sessionId: 's', key: 'c', preview: 'hmm', route: null, guess: 'manager', confidence: 0.4, source: 'router', reason: 'Jev was not sure', ms: 210, cost: 0.00001, provider: 'vercel', zdr: null, split: false, blocked: false },
      ],
    };
    render(<RouterCard rest={makeRest({ routerStatus: vi.fn().mockResolvedValue(answered) })} bots={[...PROFILES.map((p) => p.name), 'router']} onMapChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Router settings' })).toHaveTextContent('On: Jev picks who takes each message.');
  });

  it('tries a message and says where it would go, without a bot getting it', async () => {
    const connected: RouterStatus = { ...OFF, settings: { ...OFF.settings, enabled: true }, keyConfigured: true, provider: 'Vercel AI Gateway' };
    const routerTry = vi
      .fn()
      .mockResolvedValueOnce({ route: 'google-calander', guess: null, confidence: 1, source: 'jev', reason: '', split: false, team: [], ms: 240, cost: 0.00003 })
      .mockRejectedValueOnce(new HermesHttpError(404, 'Not Found', '{"detail":"Not Found"}'));
    render(
      <RouterCard
        rest={makeRest({ routerStatus: vi.fn().mockResolvedValue(connected), routerTry })}
        bots={[...PROFILES.map((p) => p.name), 'router']}
        onMapChanged={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Router settings' }));
    const sheet = await screen.findByRole('dialog', { name: 'Router' });
    const input = within(sheet).getByRole('textbox', { name: 'Message to try' });
    expect(within(sheet).getByRole('button', { name: 'Try' })).toBeDisabled();
    fireEvent.change(input, { target: { value: "What's on my calendar tomorrow?" } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Try' }));
    expect(await within(sheet).findByTestId('router-try-result')).toHaveTextContent('It would go to Google Calander · Jev 100% sure');
    expect(routerTry).toHaveBeenCalledWith("What's on my calendar tomorrow?");
    fireEvent.click(within(sheet).getByRole('button', { name: 'Try' }));
    await waitFor(() =>
      expect(within(sheet).getByTestId('router-try-result')).toHaveTextContent('Trying a message needs the Hermes dashboard on your Mac to restart.'),
    );
  });

  it("names the bots Router can't hand work to and adds one to its routes through Hermes", async () => {
    const blocked: RouterStatus = {
      ...OFF,
      settings: { ...OFF.settings, enabled: true },
      keyConfigured: true,
      provider: 'Vercel AI Gateway',
      unreachable: [{ name: 'claude-cowork-driver', suggestion: 'Connect to claude cowork and claude code' }],
      decisions: [
        { at: '2026-10-27T22:15:03Z', bot: 'router', sessionId: 's', key: 'd', preview: 'How are the Claude projects doing?', route: 'claude-cowork-driver', guess: null, confidence: 0.84, source: 'jev', reason: '', ms: 600, cost: 0.00002, provider: 'vercel', zdr: false, split: false, blocked: true },
      ],
    };
    const reached: RouterStatus = { ...blocked, unreachable: [] };
    const routerStatus = vi.fn().mockResolvedValueOnce(blocked).mockResolvedValue(reached);
    const profileRoutes = vi.fn().mockResolvedValue({
      backend: 'profile_routes',
      profiles: [{ name: 'default', description: 'General work.' }, { name: 'gmail-connector', description: 'Reads email.' }],
      default: 'default',
    });
    const saveProfileRoutes = vi.fn(async (_bot: string, routes: unknown) => routes);
    render(
      <RouterCard
        rest={makeRest({ routerStatus, profileRoutes, saveProfileRoutes })}
        bots={[...PROFILES.map((p) => p.name), 'router', 'claude-cowork-driver']}
        onMapChanged={vi.fn()}
      />,
    );
    const card = await screen.findByRole('button', { name: 'Router settings' });
    expect(card).toHaveTextContent("On, but Router can't hand work to Claude Cowork Driver yet.");
    fireEvent.click(card);
    const sheet = await screen.findByRole('dialog', { name: 'Router' });
    const note = within(sheet).getByTestId('router-reach');
    expect(note).toHaveTextContent("Router can't hand work to Claude Cowork Driver");
    expect(within(sheet).getByTestId('router-decision')).toHaveTextContent("For Claude Cowork Driver, which Router can't reach yet · Jev 84% sure");
    const line = within(note).getByRole('textbox', { name: 'What Claude Cowork Driver does' });
    // Its SOUL.md mission, as a first draft to edit.
    expect(line).toHaveValue('Connect to claude cowork and claude code');
    fireEvent.change(line, { target: { value: 'Drives Claude Cowork and Claude Code on the Mac: checks on running Claude projects.' } });
    fireEvent.click(within(note).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(saveProfileRoutes).toHaveBeenCalled());
    expect(profileRoutes).toHaveBeenCalledWith('router');
    expect(saveProfileRoutes).toHaveBeenCalledWith('router', {
      backend: 'profile_routes',
      profiles: [
        { name: 'default', description: 'General work.' },
        { name: 'gmail-connector', description: 'Reads email.' },
        { name: 'claude-cowork-driver', description: 'Drives Claude Cowork and Claude Code on the Mac: checks on running Claude projects.' },
      ],
      default: 'default',
    });
    expect(await within(sheet).findByTestId('router-reach-added')).toHaveTextContent(
      'Added Claude Cowork Driver. Start a new chat with Router to use it.',
    );
    expect(within(sheet).queryByTestId('router-reach-bot')).toBeNull();
  });

  it('adds no route when the router bot does not hand work on by profile routes, and says why', async () => {
    const blocked: RouterStatus = { ...OFF, settings: { ...OFF.settings, enabled: true }, unreachable: [{ name: 'claude-cowork-driver', suggestion: '' }] };
    const saveProfileRoutes = vi.fn();
    render(
      <RouterCard
        rest={makeRest({
          routerStatus: vi.fn().mockResolvedValue(blocked),
          profileRoutes: vi.fn().mockResolvedValue({ backend: 'default', profiles: [], default: null }),
          saveProfileRoutes,
        })}
        bots={[...PROFILES.map((p) => p.name), 'router']}
        onMapChanged={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Router settings' }));
    const note = within(await screen.findByRole('dialog', { name: 'Router' })).getByTestId('router-reach');
    const add = within(note).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled(); // no line yet
    fireEvent.change(within(note).getByRole('textbox', { name: 'What Claude Cowork Driver does' }), { target: { value: 'Drives Claude Cowork.' } });
    fireEvent.click(add);
    expect(await within(note).findByRole('alert')).toHaveTextContent('Router does not hand work on by profile routes, so a route would not be used.');
    expect(saveProfileRoutes).not.toHaveBeenCalled();
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
        { at: '2026-10-27T21:05:00Z', bot: 'router', sessionId: 's', key: 'a', preview: 'Out of credits?', route: null, guess: null, confidence: null, source: 'router', reason: 'Vercel AI Gateway is out of credits', ms: 120, cost: null, provider: 'vercel', zdr: null, split: false, blocked: false },
        { at: '2026-10-27T21:00:00Z', bot: 'router', sessionId: 's', key: 'b', preview: 'hi', route: 'answer', guess: null, confidence: 0.97, source: 'jev', reason: '', ms: 200, cost: 0.00001, provider: 'vercel', zdr: false, split: false, blocked: false },
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
    // Only the answer with a cost counts.
    expect(within(sheet).getByTestId('router-spend')).toHaveTextContent("Jev's last answer cost less than a cent in all.");
  });
});
