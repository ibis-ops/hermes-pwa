/**
 * The team map Sean draws in the Bots tab: who each bot reports to, which
 * bots it can message, and its role in a line. The plugin stores it and tells
 * each bot its place; nothing is blocked. Pure functions, no DOM.
 */

export interface TeamNode {
  /** The bot this one reports to; null when it reports straight to Sean. */
  reportsTo: string | null;
  /** Bots this one may message or hand work to. */
  canMessage: string[];
  /** One line on what the bot does. */
  role: string;
}

export interface TeamMap {
  /** Goes up by one on every save; absent on a map not saved yet. */
  version?: number | undefined;
  updatedAt?: string | undefined;
  nodes: Record<string, TeamNode>;
}

export interface TeamTreeNode {
  name: string;
  children: TeamTreeNode[];
}

export const TEAM_ROLE_MAX_CHARS = 300;

/** `gmail-connector` reads as "Gmail Connector". */
export function botLabel(name: string): string {
  const words = name.split(/[-_]+/).filter(Boolean);
  return words.map((word) => (word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1))).join(' ') || name;
}

/** The bot at the top of a starting map: the manager when there is one. */
export function topBot(names: string[]): string | undefined {
  if (names.includes('manager')) return 'manager';
  if (names.includes('default')) return 'default';
  return [...names].sort()[0];
}

/**
 * The starting map: the manager on top and able to reach every bot; every
 * other bot reports to the manager and can reach only the manager.
 */
export function defaultTeamMap(names: string[]): TeamMap {
  const top = topBot(names);
  const nodes: Record<string, TeamNode> = {};
  for (const name of names) {
    nodes[name] =
      name === top
        ? { reportsTo: null, canMessage: names.filter((other) => other !== name).sort(), role: '' }
        : { reportsTo: top ?? null, canMessage: top ? [top] : [], role: '' };
  }
  return { nodes };
}

/** A map parsed from the plugin, or undefined when it holds none. */
export function toTeamMap(raw: unknown): TeamMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const nodesRaw = record.nodes;
  if (!nodesRaw || typeof nodesRaw !== 'object' || Array.isArray(nodesRaw)) return undefined;
  const nodes: Record<string, TeamNode> = {};
  for (const [name, value] of Object.entries(nodesRaw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const node = value as Record<string, unknown>;
    nodes[name] = {
      reportsTo: typeof node.reportsTo === 'string' && node.reportsTo ? node.reportsTo : null,
      canMessage: Array.isArray(node.canMessage) ? node.canMessage.filter((x): x is string => typeof x === 'string') : [],
      role: typeof node.role === 'string' ? node.role : '',
    };
  }
  const map: TeamMap = { nodes };
  if (typeof record.version === 'number') map.version = record.version;
  if (typeof record.updatedAt === 'string' && record.updatedAt) map.updatedAt = record.updatedAt;
  return map;
}

/** The map limited to bots that still exist; lines to removed bots go too. */
export function withBots(map: TeamMap, names: string[]): TeamMap {
  const known = new Set(names);
  const nodes: Record<string, TeamNode> = {};
  for (const [name, node] of Object.entries(map.nodes)) {
    if (!known.has(name)) continue;
    nodes[name] = {
      reportsTo: node.reportsTo && known.has(node.reportsTo) ? node.reportsTo : null,
      canMessage: node.canMessage.filter((target) => known.has(target) && target !== name),
      role: node.role,
    };
  }
  return { ...map, nodes };
}

/** Every bot below `name` on the map (its reports, their reports, and so on). */
export function descendantsOf(map: TeamMap, name: string): Set<string> {
  const below = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [other, node] of Object.entries(map.nodes)) {
      if (node.reportsTo === current && !below.has(other) && other !== name) {
        below.add(other);
        queue.push(other);
      }
    }
  }
  return below;
}

/** The bots `name` may report to without making a circle. */
export function possibleBosses(map: TeamMap, name: string): string[] {
  const below = descendantsOf(map, name);
  return Object.keys(map.nodes)
    .filter((other) => other !== name && !below.has(other))
    .sort();
}

function sortNames(names: string[], top: string | undefined): string[] {
  return [...names].sort((a, b) => (a === top ? -1 : b === top ? 1 : botLabel(a).localeCompare(botLabel(b))));
}

/** The map as a tree from Sean down, with bots that are not on it listed apart. */
export function teamTree(map: TeamMap, names: string[]): { roots: TeamTreeNode[]; unmapped: string[] } {
  const onMap = names.filter((name) => map.nodes[name]);
  const top = topBot(onMap);
  const build = (name: string, path: Set<string>): TeamTreeNode => ({
    name,
    children: sortNames(
      onMap.filter((other) => map.nodes[other]?.reportsTo === name && !path.has(other)),
      top,
    ).map((child) => build(child, new Set([...path, child]))),
  });
  const roots = sortNames(
    onMap.filter((name) => {
      const boss = map.nodes[name]?.reportsTo;
      return !boss || !map.nodes[boss];
    }),
    top,
  ).map((name) => build(name, new Set([name])));
  return { roots, unmapped: sortNames(names.filter((name) => !map.nodes[name]), top) };
}

/** One bot's place changed; the rest of the map stays as it was. */
export function updateNode(map: TeamMap, name: string, next: TeamNode): TeamMap {
  if (next.reportsTo && (next.reportsTo === name || descendantsOf(map, name).has(next.reportsTo))) {
    throw new Error('That would make the reporting lines go in a circle.');
  }
  const role = next.role.replace(/\s+/g, ' ').trim().slice(0, TEAM_ROLE_MAX_CHARS);
  const canMessage = [...new Set(next.canMessage.filter((target) => target !== name && map.nodes[target]))].sort();
  return { ...map, nodes: { ...map.nodes, [name]: { reportsTo: next.reportsTo, canMessage, role } } };
}

/** A bot not on the map joins it under `boss`, able to message its boss. */
export function addToMap(map: TeamMap, name: string, boss: string | null): TeamMap {
  const nodes: Record<string, TeamNode> = { ...map.nodes, [name]: { reportsTo: boss, canMessage: boss ? [boss] : [], role: '' } };
  const bossNode = boss ? nodes[boss] : undefined;
  if (boss && bossNode && !bossNode.canMessage.includes(name)) {
    nodes[boss] = { ...bossNode, canMessage: [...bossNode.canMessage, name].sort() };
  }
  return { ...map, nodes };
}

/** A bot leaves the map: its reports move up to its boss, and no one lists it any more. */
export function removeFromMap(map: TeamMap, name: string): TeamMap {
  const gone = map.nodes[name];
  const nodes: Record<string, TeamNode> = {};
  for (const [other, node] of Object.entries(map.nodes)) {
    if (other === name) continue;
    nodes[other] = {
      ...node,
      reportsTo: node.reportsTo === name ? (gone?.reportsTo ?? null) : node.reportsTo,
      canMessage: node.canMessage.filter((target) => target !== name),
    };
  }
  return { ...map, nodes };
}

/** Whether two maps say the same thing (versions aside). */
export function sameTeamMap(a: TeamMap | undefined, b: TeamMap | undefined): boolean {
  if (!a || !b) return a === b;
  const names = Object.keys(a.nodes).sort();
  if (names.join('\n') !== Object.keys(b.nodes).sort().join('\n')) return false;
  return names.every((name) => {
    const x = a.nodes[name]!;
    const y = b.nodes[name]!;
    return x.reportsTo === y.reportsTo && x.role === y.role && [...x.canMessage].sort().join() === [...y.canMessage].sort().join();
  });
}
