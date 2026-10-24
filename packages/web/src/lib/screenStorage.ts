import type { Screen } from '../app/AppShell';

const STORAGE_KEY = 'hermes-mobile-screen';
const ACTIVE_SESSION_STORAGE_KEY = 'hermes-pwa.activeSession.v3';
const PROFILED_ACTIVE_SESSION_STORAGE_KEY_PREFIX = 'hermes-pwa.activeSession.v4:';

const VALID_SCREENS = new Set<Screen>([
  'home',
  'chat',
  'sessions',
  'approvals',
  'kanban',
  'agents',
  'profiles',
  'cron',
  'artifacts',
  'messaging',
  'obsidian',
  // TODO: Skills/Tools is temporarily hidden from the PWA menu until we decide
  // whether this administrative surface belongs in the mobile app.
  // Keep the screen code, but do not restore it from localStorage for now.
  // 'skills',
  'command',
  'settings',
]);

export function screenFromLocationHash(hash = typeof window === 'undefined' ? '' : window.location.hash): Screen | undefined {
  const fragment = hash.includes('#') ? hash.slice(hash.indexOf('#')) : hash;
  const normalized = fragment.replace(/^#\/?/, '').split(/[?&]/, 1)[0];
  if (!normalized) return undefined;
  return VALID_SCREENS.has(normalized as Screen) ? (normalized as Screen) : undefined;
}

function activeCacheHasSession(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { storedSessionId?: unknown; messages?: unknown };
    return Boolean(
      typeof parsed.storedSessionId === 'string'
      || (Array.isArray(parsed.messages) && parsed.messages.length > 0),
    );
  } catch {
    return false;
  }
}

function hasActiveSessionCache(): boolean {
  if (activeCacheHasSession(window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY))) return true;
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(PROFILED_ACTIVE_SESSION_STORAGE_KEY_PREFIX)) continue;
    if (activeCacheHasSession(window.localStorage.getItem(key))) return true;
  }
  return false;
}

export function getInitialScreen(): Screen {
  if (typeof window === 'undefined') return 'home';
  const hashScreen = screenFromLocationHash();
  if (hashScreen) return hashScreen;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return hasActiveSessionCache() ? 'chat' : 'home';
  if (!VALID_SCREENS.has(raw as Screen)) return 'home';
  if (raw === 'chat' && !hasActiveSessionCache()) return 'home';
  return raw as Screen;
}

export function persistScreen(screen: Screen): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, screen);
}
