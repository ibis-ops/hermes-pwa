import { describe, expect, it } from 'vitest';
import {
  addToMap,
  botLabel,
  defaultTeamMap,
  descendantsOf,
  possibleBosses,
  removeFromMap,
  sameTeamMap,
  teamTree,
  toTeamMap,
  updateNode,
  withBots,
  withRouterOnTop,
} from './teamMap';

const BOTS = ['default', 'gmail-connector', 'manager', 'signal-connector'];

describe('team map', () => {
  it('starts with the manager on top, reaching every bot, and each bot reaching only the manager', () => {
    const map = defaultTeamMap(BOTS);
    expect(map.nodes.manager).toEqual({ reportsTo: null, canMessage: ['default', 'gmail-connector', 'signal-connector'], role: '' });
    expect(map.nodes['gmail-connector']).toEqual({ reportsTo: 'manager', canMessage: ['manager'], role: '' });
    expect(map.nodes.default?.reportsTo).toBe('manager');
  });

  it('puts the default bot on top when there is no manager', () => {
    const map = defaultTeamMap(['default', 'helper']);
    expect(map.nodes.default?.reportsTo).toBeNull();
    expect(map.nodes.helper?.reportsTo).toBe('default');
  });

  it('reads bot names as words', () => {
    expect(botLabel('gmail-connector')).toBe('Gmail Connector');
    expect(botLabel('obsidian_vault-manager')).toBe('Obsidian Vault Manager');
    expect(botLabel('manager')).toBe('Manager');
  });

  it('builds a tree from Sean down, with bots off the map apart', () => {
    const map = updateNode(defaultTeamMap(['manager', 'gmail-connector', 'signal-connector']), 'signal-connector', {
      reportsTo: 'gmail-connector',
      canMessage: ['gmail-connector'],
      role: '',
    });
    const tree = teamTree(map, ['manager', 'gmail-connector', 'signal-connector', 'new-bot']);
    expect(tree.roots.map((root) => root.name)).toEqual(['manager']);
    expect(tree.roots[0]!.children.map((child) => child.name)).toEqual(['gmail-connector']);
    expect(tree.roots[0]!.children[0]!.children.map((child) => child.name)).toEqual(['signal-connector']);
    expect(tree.unmapped).toEqual(['new-bot']);
  });

  it('never lets the reporting lines go in a circle', () => {
    const map = updateNode(defaultTeamMap(['manager', 'a', 'b']), 'b', { reportsTo: 'a', canMessage: [], role: '' });
    expect([...descendantsOf(map, 'manager')].sort()).toEqual(['a', 'b']);
    expect(possibleBosses(map, 'a')).toEqual(['manager']);
    expect(() => updateNode(map, 'a', { reportsTo: 'b', canMessage: [], role: '' })).toThrow(/circle/);
    expect(() => updateNode(map, 'a', { reportsTo: 'a', canMessage: [], role: '' })).toThrow(/circle/);
  });

  it('cleans an edited node: no self, no strangers, no repeats, a tidy role', () => {
    const map = updateNode(defaultTeamMap(['manager', 'a']), 'a', {
      reportsTo: 'manager',
      canMessage: ['a', 'ghost', 'manager', 'manager'],
      role: '  Reads   email. ',
    });
    expect(map.nodes.a).toEqual({ reportsTo: 'manager', canMessage: ['manager'], role: 'Reads email.' });
  });

  it('adds a bot under a boss and removes one, moving its reports up', () => {
    let map = addToMap(defaultTeamMap(['manager', 'a']), 'b', 'a');
    expect(map.nodes.b).toEqual({ reportsTo: 'a', canMessage: ['a'], role: '' });
    expect(map.nodes.a?.canMessage).toContain('b');
    map = removeFromMap(map, 'a');
    expect(map.nodes.b?.reportsTo).toBe('manager');
    expect(map.nodes.manager?.canMessage).not.toContain('a');
    expect(map.nodes.a).toBeUndefined();
  });

  it('drops bots that no longer exist, and lines to them', () => {
    const map = withBots(defaultTeamMap(['manager', 'a', 'gone']), ['manager', 'a']);
    expect(Object.keys(map.nodes).sort()).toEqual(['a', 'manager']);
    expect(map.nodes.manager?.canMessage).toEqual(['a']);
  });

  it('parses what the plugin returns and compares maps by meaning', () => {
    const parsed = toTeamMap({
      version: 3,
      updatedAt: '2026-10-27T17:00:00Z',
      nodes: { manager: { reportsTo: null, canMessage: ['a', 7], role: 'Leads' }, a: { reportsTo: 'manager' }, bad: 'x' },
    });
    expect(parsed?.version).toBe(3);
    expect(parsed?.nodes.manager).toEqual({ reportsTo: null, canMessage: ['a'], role: 'Leads' });
    expect(parsed?.nodes.a).toEqual({ reportsTo: 'manager', canMessage: [], role: '' });
    expect(parsed?.nodes.bad).toBeUndefined();
    expect(toTeamMap(null)).toBeUndefined();
    expect(sameTeamMap(defaultTeamMap(BOTS), { version: 9, nodes: defaultTeamMap(BOTS).nodes })).toBe(true);
    expect(sameTeamMap(defaultTeamMap(BOTS), defaultTeamMap(['manager']))).toBe(false);
  });

  it('puts the router on top: it reaches every bot and the old top bot reports to it', () => {
    const map = withRouterOnTop(defaultTeamMap(['manager', 'gmail-connector', 'router']), 'router', '  Front   door. ');
    expect(map.nodes.router).toEqual({ reportsTo: null, canMessage: ['gmail-connector', 'manager'], role: 'Front door.' });
    expect(map.nodes.manager).toMatchObject({ reportsTo: 'router' });
    expect(map.nodes.manager!.canMessage).toContain('router');
    expect(map.nodes['gmail-connector']).toEqual({ reportsTo: 'manager', canMessage: ['manager'], role: '' });
    expect(teamTree(map, ['manager', 'gmail-connector', 'router']).roots.map((root) => root.name)).toEqual(['router']);
  });
});
