import { describe, expect, it } from 'vitest';
import { ROUTER_SELF, routerTextKey, toProfileRoutes, toRouterStatus, toRouterTry, withProfileRoute } from './router';

describe('router', () => {
  it('fingerprints a message the same way the plugin does', () => {
    // dashboard/tests/test_router.py pins the same values on the Python side.
    expect(routerTextKey('  Hello   world \n')).toBe('594d29c7');
    expect(routerTextKey('Hello world')).toBe('594d29c7');
    expect(routerTextKey('Draft an email to Kahunas clients about Friday’s check-ins \u{1F680}')).toBe('28d37499');
  });

  it('reads the status the plugin sends, with defaults for anything missing', () => {
    const status = toRouterStatus({
      settings: { enabled: true, bot: 'router', minConfidence: 0.7 },
      keyConfigured: true,
      decisions: [
        { at: '2026-10-27T20:00:00Z', bot: 'router', sessionId: 's-1', key: 'abc', preview: 'hi', route: 'answer', confidence: 0.9, source: 'jev', reason: '' },
        { at: '2026-10-27T20:01:00Z', route: null, guess: 'manager', confidence: 0.4, source: 'router', reason: 'Jev was not sure' },
        { nope: true },
      ],
    });
    expect(status.settings).toEqual({ enabled: true, bot: 'router', jevModel: '', minConfidence: 0.7 });
    expect(status.keyConfigured).toBe(true);
    expect(status.keyName).toBe('HERMES_PWA_JEV_API_KEY');
    expect(status.provider).toBeUndefined();
    expect(status.decisions.map((d) => [d.route, d.guess, d.source])).toEqual([
      [ROUTER_SELF, null, 'jev'],
      [null, 'manager', 'router'],
    ]);
    expect(toRouterStatus(undefined).settings.enabled).toBe(false);
    const vercel = toRouterStatus({
      keyConfigured: true,
      provider: 'Vercel AI Gateway',
      decisions: [{ at: '2026-10-27T21:00:00Z', route: 'answer', source: 'jev', confidence: 0.9, provider: 'vercel', zdr: true }],
    });
    expect(vercel.provider).toBe('Vercel AI Gateway');
    expect([vercel.decisions[0]!.provider, vercel.decisions[0]!.zdr, vercel.decisions[0]!.split]).toEqual(['vercel', true, false]);
    expect(toRouterStatus({ decisions: [{ at: '2026-10-27T22:00:00Z', route: 'manager', source: 'jev', split: true }] }).decisions[0]!.split).toBe(true);
    expect(status.decisions[0]!.zdr).toBeNull();
  });

  it('reads which bots run an older copy of the plugin, and the command that updates them', () => {
    expect([toRouterStatus({}).staleBots, toRouterStatus({}).updateCommand]).toEqual([[], '']);
    const stale = toRouterStatus({ staleBots: ['manager', 7, '', 'gmail-connector'], updateCommand: 'hermes -p manager plugins update hermes-pwa' });
    expect(stale.staleBots).toEqual(['manager', 'gmail-connector']);
    expect(stale.updateCommand).toBe('hermes -p manager plugins update hermes-pwa');
  });

  it('reads where a tried message would go', () => {
    expect(toRouterTry({ route: 'manager', source: 'jev', confidence: 0.97, split: true, team: ['gmail-connector', 3], ms: 210, cost: 0.00003 })).toEqual({
      route: 'manager',
      guess: null,
      confidence: 0.97,
      source: 'jev',
      reason: '',
      split: true,
      team: ['gmail-connector'],
      blocked: false,
      ms: 210,
      cost: 0.00003,
    });
    expect(toRouterTry(null)).toMatchObject({ route: null, source: 'router', split: false, team: [], blocked: false });
    expect(toRouterTry({ route: 'claude-cowork-driver', source: 'jev', confidence: 0.9, blocked: true }).blocked).toBe(true);
  });

  it('reads the bots the router cannot hand work to, and decisions it could not hand over', () => {
    expect(toRouterStatus({}).unreachable).toEqual([]);
    const status = toRouterStatus({
      unreachable: [{ name: 'claude-cowork-driver', suggestion: 'Drives Claude Cowork on the Mac' }, { name: '' }, 'x', { name: 'signal-connector' }],
      decisions: [{ at: '2026-10-27T22:15:03Z', route: 'claude-cowork-driver', source: 'jev', confidence: 0.84, blocked: true }],
    });
    expect(status.unreachable).toEqual([
      { name: 'claude-cowork-driver', suggestion: 'Drives Claude Cowork on the Mac' },
      { name: 'signal-connector', suggestion: '' },
    ]);
    expect(status.decisions[0]!.blocked).toBe(true);
    expect(toRouterStatus({ decisions: [{ at: '2026-10-27T22:00:00Z', route: 'manager', source: 'jev' }] }).decisions[0]!.blocked).toBe(false);
  });

  it('reads and extends a bot\'s delegation profile routes, keeping every other one', () => {
    // The shape of Hermes's GET /api/delegation/routing.
    const routes = toProfileRoutes({
      configured: 'profile_routes',
      profile_routes: {
        profiles: [
          { name: 'default', description: 'General work.' },
          { name: 'gmail-connector', description: '  Reads and sends email.  ' },
          { name: 'gmail-connector', description: 'a repeat' },
          { name: '', description: 'no name' },
          'junk',
          { name: 'manager' },
        ],
        default: 'default',
      },
      model_map: { options: [] },
    });
    expect(routes).toEqual({
      backend: 'profile_routes',
      profiles: [
        { name: 'default', description: 'General work.' },
        { name: 'gmail-connector', description: 'Reads and sends email.' },
        { name: 'manager', description: '' },
      ],
      default: 'default',
    });
    const added = withProfileRoute(routes, 'claude-cowork-driver', '  Drives Claude Cowork\n and Claude Code on the Mac ');
    expect(added.profiles.map((route) => route.name)).toEqual(['default', 'gmail-connector', 'manager', 'claude-cowork-driver']);
    expect(added.profiles[3]).toEqual({ name: 'claude-cowork-driver', description: 'Drives Claude Cowork and Claude Code on the Mac' });
    expect(added.default).toBe('default');
    // A bot already listed gets its line replaced in place.
    expect(withProfileRoute(routes, 'manager', 'Coordinates the team.').profiles).toEqual([
      { name: 'default', description: 'General work.' },
      { name: 'gmail-connector', description: 'Reads and sends email.' },
      { name: 'manager', description: 'Coordinates the team.' },
    ]);
    expect(toProfileRoutes(undefined)).toEqual({ backend: 'default', profiles: [], default: null });
  });
});
