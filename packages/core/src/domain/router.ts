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
  decisions: RouterDecision[];
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
  };
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
    decisions: decisions.flatMap((entry) => {
      const decision = toRouterDecision(entry);
      return decision ? [decision] : [];
    }),
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
