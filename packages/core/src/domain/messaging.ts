/**
 * Messaging platforms: the chat services (Signal, Telegram, Discord, ...) the
 * Hermes gateway can run a bot on. Read-only in the app; tokens are set up on
 * the Mac dashboard. Env var values never reach the phone: the parser keeps
 * counts only.
 */

export type MessagingPlatformState = 'connected' | 'connecting' | 'error' | 'enabled' | 'disabled' | 'unknown';

export interface MessagingPlatform {
  id: string;
  name: string;
  description: string | undefined;
  docsUrl: string | undefined;
  enabled: boolean;
  configured: boolean;
  state: MessagingPlatformState;
  /** Raw gateway state when it is not one of the known values. */
  rawState: string | undefined;
  errorMessage: string | undefined;
  /** Epoch ms of the last state change reported by the gateway. */
  updatedAt: number | undefined;
  /** Display name of the channel Hermes treats as home, when one is set. */
  homeChannel: string | undefined;
  /** Required settings that are filled in vs. required in total. */
  requiredSet: number;
  requiredTotal: number;
}

export interface MessagingOverview {
  platforms: MessagingPlatform[];
  gatewayRunning: boolean | undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1_000_000_000_000 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeState(raw: string | undefined, enabled: boolean, configured: boolean): MessagingPlatformState {
  const value = (raw ?? '').toLowerCase();
  if (value === 'connected' || value === 'running' || value === 'ready') return 'connected';
  if (value === 'connecting' || value === 'starting' || value === 'retrying' || value === 'reconnecting') return 'connecting';
  if (value === 'error' || value === 'failed' || value === 'degraded') return 'error';
  if (value === 'disabled' || value === 'off') return 'disabled';
  if (value === 'enabled' || value === 'configured' || value === 'stopped' || value === 'idle') return enabled && configured ? 'enabled' : 'disabled';
  if (!value) return enabled && configured ? 'enabled' : 'disabled';
  return 'unknown';
}

function toPlatform(raw: unknown): MessagingPlatform | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = str(record.id);
  if (!id) return undefined;
  const enabled = record.enabled === true;
  const configured = record.configured === true;
  const rawState = str(record.state);
  const envVars = Array.isArray(record.env_vars) ? record.env_vars : [];
  let requiredSet = 0;
  let requiredTotal = 0;
  for (const entry of envVars) {
    if (typeof entry !== 'object' || entry === null) continue;
    const env = entry as Record<string, unknown>;
    if (env.required !== true) continue;
    requiredTotal += 1;
    if (env.is_set === true) requiredSet += 1;
  }
  const home = typeof record.home_channel === 'object' && record.home_channel !== null
    ? (record.home_channel as Record<string, unknown>)
    : undefined;
  return {
    id,
    name: str(record.name) ?? id,
    description: str(record.description),
    docsUrl: str(record.docs_url),
    enabled,
    configured,
    state: normalizeState(rawState, enabled, configured),
    rawState,
    errorMessage: str(record.error_message),
    updatedAt: parseTimestamp(record.updated_at),
    homeChannel: str(home?.name),
    requiredSet,
    requiredTotal,
  };
}

export function toMessagingOverview(raw: unknown): MessagingOverview {
  if (typeof raw !== 'object' || raw === null) return { platforms: [], gatewayRunning: undefined };
  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record.platforms) ? record.platforms : Array.isArray(raw) ? (raw as unknown[]) : [];
  const platforms = list.map(toPlatform).filter((p): p is MessagingPlatform => p !== undefined);
  // Every platform row repeats the gateway flag; any one of them answers it.
  let gatewayRunning: boolean | undefined;
  if (typeof record.gateway_running === 'boolean') gatewayRunning = record.gateway_running;
  for (const entry of list) {
    if (gatewayRunning !== undefined) break;
    if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).gateway_running === 'boolean') {
      gatewayRunning = (entry as Record<string, unknown>).gateway_running as boolean;
    }
  }
  return { platforms, gatewayRunning };
}

const STATE_ORDER: Record<MessagingPlatformState, number> = {
  connected: 0,
  connecting: 1,
  error: 2,
  enabled: 3,
  unknown: 4,
  disabled: 5,
};

/** Live bots first, then anything that needs attention, then the rest alphabetically. */
export function sortMessagingPlatforms(platforms: MessagingPlatform[]): MessagingPlatform[] {
  return [...platforms].sort((a, b) => {
    const order = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    return order !== 0 ? order : a.name.localeCompare(b.name);
  });
}

export function messagingStateLabel(platform: MessagingPlatform): string {
  switch (platform.state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'error':
      return 'Error';
    case 'enabled':
      return platform.configured ? 'Enabled, not connected' : 'Enabled, needs setup';
    case 'disabled':
      return platform.configured ? 'Off' : 'Not set up';
    default:
      return platform.rawState ?? 'Unknown';
  }
}
