import { describe, expect, it } from 'vitest';
import { ROUTER_SELF, routerTextKey, toRouterStatus } from './router';

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
});
