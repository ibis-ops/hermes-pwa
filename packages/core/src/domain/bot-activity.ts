/**
 * What each bot is working on, from the hermes-pwa plugin's `/bots/activity` route. During a turn
 * Hermes stamps the session with a label for the step it is on ("executing tool: terminal") and
 * clears it when the turn ends, so a labelled session is live work: a chat, a job another bot
 * handed over, a scheduled job, or a message from Signal. Each bot also has when it was last active.
 */

export type BotWorkKind = 'chat' | 'delegated' | 'scheduled' | 'messaging';

export interface BotWork {
  kind: BotWorkKind;
  /** The chat's title or the handed-over goal; undefined while Hermes has none. */
  title: string | undefined;
  /** Hermes's own label for the current step, for example "executing tool: terminal". */
  activity: string | undefined;
  /** The bot that handed this job over, for delegated work. */
  requestedBy: string | undefined;
  source: string | undefined;
  sessionId: string | undefined;
  /** Epoch ms. */
  startedAt: number | undefined;
  updatedAt: number | undefined;
}

export interface BotActivity {
  working: boolean;
  work: BotWork[];
  /** Epoch ms of the bot's newest session activity. */
  lastActiveAt: number | undefined;
  lastTitle: string | undefined;
}

export interface BotActivityReport {
  bots: Record<string, BotActivity>;
  scannedAt: number | undefined;
  error: string | undefined;
}

const BOT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KINDS = new Set<BotWorkKind>(['chat', 'delegated', 'scheduled', 'messaging']);
const WORK_PER_BOT = 5;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function botName(value: unknown): string | undefined {
  const name = str(value);
  return name && BOT_NAME.test(name) ? name : undefined;
}

export function toBotWork(raw: unknown): BotWork | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const kind = str(record.kind) as BotWorkKind | undefined;
  return {
    kind: kind && KINDS.has(kind) ? kind : 'chat',
    title: str(record.title),
    activity: str(record.activity),
    requestedBy: botName(record.requested_by),
    source: str(record.source),
    sessionId: str(record.session_id),
    startedAt: epochMs(record.started_at),
    updatedAt: epochMs(record.updated_at),
  };
}

function toBotActivity(raw: unknown): BotActivity | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const work = Array.isArray(record.work)
    ? record.work.map(toBotWork).filter((item): item is BotWork => Boolean(item)).slice(0, WORK_PER_BOT)
    : [];
  return {
    working: record.working === true && work.length > 0,
    work,
    lastActiveAt: epochMs(record.last_active_at),
    lastTitle: str(record.last_title),
  };
}

export function toBotActivityReport(raw: unknown): BotActivityReport {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const bots: Record<string, BotActivity> = {};
  const rawBots = record.bots;
  if (typeof rawBots === 'object' && rawBots !== null && !Array.isArray(rawBots)) {
    for (const [name, value] of Object.entries(rawBots as Record<string, unknown>)) {
      const bot = botName(name);
      const activity = bot ? toBotActivity(value) : undefined;
      if (bot && activity) bots[bot] = activity;
    }
  }
  return { bots, scannedAt: epochMs(record.scanned_at), error: str(record.error) };
}

const TOOL_PHRASES: Record<string, string> = {
  terminal: 'Using the terminal',
  execute_code: 'Running code',
  delegate_task: 'Handing work to a bot',
  search_files: 'Searching files',
  read_file: 'Reading a file',
  write_file: 'Writing a file',
  patch: 'Editing a file',
  web_search: 'Searching the web',
  web_extract: 'Reading a web page',
  computer_use: 'Using the screen',
  skill_view: 'Reading a skill',
  skills_list: 'Checking its skills',
  session_search: 'Searching past chats',
  memory: 'Using its memory',
  todo: 'Updating its to-do list',
  clarify: 'Asking you a question',
  vision_analyze: 'Looking at an image',
  image_generate: 'Making an image',
  text_to_speech: 'Reading aloud',
  cronjob: 'Using the scheduler',
  send_message: 'Sending a message',
};

/**
 * "search_files" reads "Searching files". An MCP tool ("mcp_signal_bridge_get_unread") reads
 * "Using a connector": its server and tool names cannot be told apart once joined.
 */
function toolPhrase(name: string): string {
  const key = name.trim().toLowerCase();
  const known = TOOL_PHRASES[key];
  if (known) return known;
  if (key.startsWith('browser')) return 'Using the browser';
  if (key.startsWith('mcp_')) return 'Using a connector';
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? `Using ${words}` : 'Using a tool';
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Hermes's step label in a few plain words: "executing tool: search_files" becomes "Searching
 * files", a model call becomes "Thinking". Unknown labels pass through, shortened.
 */
export function describeActivity(label: string | undefined): string | undefined {
  const text = label?.trim();
  if (!text) return undefined;
  let match = /^executing tool:\s*([\w.-]+)/i.exec(text);
  if (match?.[1]) return toolPhrase(match[1]);
  match = /^executing \d+ tools concurrently:\s*(.+)$/i.exec(text);
  if (match?.[1]) {
    const phrases = [...new Set(match[1].split(/,\s*/).filter(Boolean).map(toolPhrase))];
    if (phrases.length === 0) return 'Using several tools';
    return phrases.length === 1 ? phrases[0] : `${phrases[0]} and ${lowerFirst(phrases[1] ?? '')}`;
  }
  if (/^sequential tool running/i.test(text)) return 'Using a tool';
  if (/compress|compact/i.test(text)) return 'Compacting the chat';
  if (/retry|stale|killed/i.test(text)) return 'Retrying the model';
  if (/resumed after the computer slept/i.test(text)) return 'Picking up after the Mac slept';
  if (/^(starting api call|waiting for|receiving stream|tool results posted|tool completed)/i.test(text)) return 'Thinking';
  const short = text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** The bots working right now, busiest first, then by name. */
export function workingBots(report: BotActivityReport | undefined): string[] {
  if (!report) return [];
  return Object.entries(report.bots)
    .filter(([, activity]) => activity.working)
    .sort(([a, left], [b, right]) => right.work.length - left.work.length || a.localeCompare(b))
    .map(([name]) => name);
}
