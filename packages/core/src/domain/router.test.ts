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
    expect(status.settings).toEqual({ enabled: true, bot: 'router', jevModel: '~typesafe/jev-latest', minConfidence: 0.7 });
    expect(status.keyConfigured).toBe(true);
    expect(status.decisions.map((d) => [d.route, d.guess, d.source])).toEqual([
      [ROUTER_SELF, null, 'jev'],
      [null, 'manager', 'router'],
    ]);
    expect(toRouterStatus(undefined).settings.enabled).toBe(false);
  });
});
