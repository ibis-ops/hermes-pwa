/**
 * The router bot: Jev (TypeSafe's decision model, through Vercel AI Gateway or OpenRouter) reads
 * each message Sean sends the router and picks who takes it, the router itself
 * on its fast model or a bot it can hand work to. The plugin on the Mac makes
 * the call and keeps a short log; this is the app's side of it. Pure, no DOM.
 */

/** The route that means "the router answers it itself". */
export const ROUTER_SELF = 'answer';

/** What the setup gives the router bot as its role on the team map. */
export const ROUTER_ROLE = 'Front door: answers quick questions itself on a fast model and hands real work to the bot that owns it.';

export interface RouterSettings {
  enabled: boolean;
  /** The bot whose messages Jev routes. */
  bot: string;
  /** Jev's model id; empty means the service's own Jev. */
  jevModel: string;
  /** Below this, Jev's pick is a guess and the router decides itself. */
  minConfidence: number;
  updatedAt?: string | undefined;
}

export interface RouterDecision {
  at: string;
  bot: string;
  sessionId: string;
  /** Fingerprint of the message; see {@link routerTextKey}. */
  key: string;
  preview: string;
  /** Who took it: ROUTER_SELF, a bot name, or null when the router decided itself. */
  route: string | null;
  /** Jev's unsure pick, when it was not sure enough. */
  guess: string | null;
  confidence: number | null;
  source: 'jev' | 'router';
  reason: string;
  ms: number | null;
  cost: number | null;
  /** The service Jev was asked through ("vercel", "openrouter"), when it was asked. */
  provider: string | null;
  /** Whether that request asked for zero data retention; null when unknown. */
  zdr: boolean | null;
  /** The router ran the pick's team itself (bots it hands work to cannot hand it on). */
  split: boolean;
  /** Jev picked a bot the router cannot hand work to (not in its delegation routes); the router said so. */
  blocked: boolean;
}

/**
 * A bot on the team map that the router bot cannot hand work to: Hermes only runs a delegated
 * task as a profile listed in the bot's delegation routes. `suggestion` is a first draft of the
 * line that tells Jev and the router what it does (its role on the map, else its SOUL.md mission).
 */
export interface UnreachableBot {
  name: string;
  suggestion: string;
}

export interface RouterStatus {
  settings: RouterSettings;
  /** Whether the Mac has a key for Jev. */
  keyConfigured: boolean;
  /** The service the key is for ("Vercel AI Gateway", "OpenRouter"), when there is one. */
  provider: string | undefined;
  /** The .env name the plugin reads its own Jev key from. */
  keyName: string;
  /**
   * Bots with their own copy of the plugin at an older version than the dashboard's: their hooks
   * are old, so they miss the team map and (for the router) Jev's notes.
   */
  staleBots: string[];
  /** Terminal command for the Mac that updates those copies; empty when none is stale. */
  updateCommand: string;
  /** Bots on the team map the router cannot hand work to yet. */
  unreachable: UnreachableBot[];
  decisions: RouterDecision[];
}

/** Where a message would go, from the Router sheet's "Try a message": nothing is sent or kept. */
export interface RouterTry {
  route: string | null;
  guess: string | null;
  confidence: number | null;
  source: 'jev' | 'router';
  reason: string;
  /** The router would run the pick's team itself. */
  split: boolean;
  /** That team, by bot name. */
  team: string[];
  /** Jev would pick a bot the router cannot hand work to yet. */
  blocked: boolean;
  ms: number | null;
  cost: number | null;
}

/** One entry of a bot's delegation profile routes: a profile it may run a task as, and what it is for. */
export interface ProfileRoute {
  name: string;
  description: string;
}

/**
 * A bot's delegation profile routes, as Hermes's own dashboard API reads and writes them
 * (`/api/delegation/routing`, `/api/delegation/backends/profile_routes`). `backend` is the
 * delegation backend the bot runs; the routes only apply under "profile_routes".
 */
export interface ProfileRoutes {
  backend: string;
  profiles: ProfileRoute[];
  /** The profile a task without one runs as; null for the bot's own route. */
  default: string | null;
}

/** The plugin's own Jev key in Hermes's .env, when the Mac does not say otherwise. */
export const ROUTER_KEY_NAME = 'HERMES_PWA_JEV_API_KEY';

const DEFAULT_SETTINGS: RouterSettings = { enabled: false, bot: 'router', jevModel: '', minConfidence: 0.6 };

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toRouterSettings(raw: unknown): RouterSettings {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const settings: RouterSettings = {
    enabled: record.enabled === true,
    bot: str(record.bot) || DEFAULT_SETTINGS.bot,
    jevModel: str(record.jevModel),
    minConfidence: num(record.minConfidence) ?? DEFAULT_SETTINGS.minConfidence,
  };
  if (str(record.updatedAt)) settings.updatedAt = str(record.updatedAt);
  return settings;
}

export function toRouterDecision(raw: unknown): RouterDecision | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const at = str(record.at);
  if (!at) return undefined;
  return {
    at,
    bot: str(record.bot),
    sessionId: str(record.sessionId),
    key: str(record.key),
    preview: str(record.preview),
    route: str(record.route) || null,
    guess: str(record.guess) || null,
    confidence: num(record.confidence),
    source: record.source === 'jev' ? 'jev' : 'router',
    reason: str(record.reason),
    ms: num(record.ms),
    cost: num(record.cost),
    provider: str(record.provider) || null,
    zdr: typeof record.zdr === 'boolean' ? record.zdr : null,
    split: record.split === true,
    blocked: record.blocked === true,
  };
}

function toUnreachableBot(raw: unknown): UnreachableBot[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const name = str(record.name);
  return name ? [{ name, suggestion: str(record.suggestion) }] : [];
}

export function toRouterStatus(raw: unknown): RouterStatus {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  return {
    settings: toRouterSettings(record.settings),
    keyConfigured: record.keyConfigured === true,
    provider: str(record.provider) || undefined,
    keyName: str(record.keyName) || ROUTER_KEY_NAME,
    staleBots: Array.isArray(record.staleBots) ? record.staleBots.filter((name): name is string => typeof name === 'string' && name.length > 0) : [],
    updateCommand: str(record.updateCommand),
    unreachable: Array.isArray(record.unreachable) ? record.unreachable.flatMap(toUnreachableBot) : [],
    decisions: decisions.flatMap((entry) => {
      const decision = toRouterDecision(entry);
      return decision ? [decision] : [];
    }),
  };
}

export function toRouterTry(raw: unknown): RouterTry {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    route: str(record.route) || null,
    guess: str(record.guess) || null,
    confidence: num(record.confidence),
    source: record.source === 'jev' ? 'jev' : 'router',
    reason: str(record.reason),
    split: record.split === true,
    team: Array.isArray(record.team) ? record.team.filter((name): name is string => typeof name === 'string' && name.length > 0) : [],
    blocked: record.blocked === true,
    ms: num(record.ms),
    cost: num(record.cost),
  };
}

/** Hermes's `GET /api/delegation/routing` answer, reduced to the profile routes. */
export function toProfileRoutes(raw: unknown): ProfileRoutes {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const block = record.profile_routes && typeof record.profile_routes === 'object' ? (record.profile_routes as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const profiles: ProfileRoute[] = [];
  for (const entry of Array.isArray(block.profiles) ? block.profiles : []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = str((entry as Record<string, unknown>).name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    profiles.push({ name, description: str((entry as Record<string, unknown>).description).trim() });
  }
  return { backend: str(record.configured) || 'default', profiles, default: str(block.default).trim() || null };
}

/**
 * The routes with `name` added (or its description replaced), everything else as it was, so a
 * save through Hermes's API (which replaces the whole block) keeps every other route.
 */
export function withProfileRoute(routes: ProfileRoutes, name: string, description: string): ProfileRoutes {
  const line = description.replace(/\s+/g, ' ').trim();
  const known = routes.profiles.some((route) => route.name === name);
  return {
    ...routes,
    profiles: known
      ? routes.profiles.map((route) => (route.name === name ? { name, description: line } : route))
      : [...routes.profiles, { name, description: line }],
  };
}

function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return bytes;
}

/**
 * The message fingerprint the plugin logs with each decision (FNV-1a, 32 bit,
 * over the UTF-8 of the text with whitespace collapsed), so a decision can be
 * matched to the message it was about without the log keeping the message.
 */
export function routerTextKey(text: string): string {
  const normalized = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 2000).join('');
  let hash = 0x811c9dc5;
  for (const byte of utf8(normalized)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
