import type { Screen } from '../app/AppShell';

const STORAGE_KEY = 'hermes-mobile-screen';
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

const ACTIVE_SESSION_KEY_PREFIXES = ['hermes-pwa.activeSession.v3', 'hermes-pwa.activeSession.v4:'];

/** True when a transcript is cached on this phone, so the shell can show it before the socket is up. */
export function hasCachedTranscript(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !ACTIVE_SESSION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      const raw = window.localStorage.getItem(key);
      if (raw && raw.includes('"messages":[{')) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** The chat is the app; it is where a launch lands unless the last screen was another. */
export function getInitialScreen(): Screen {
  if (typeof window === 'undefined') return 'chat';
  const hashScreen = screenFromLocationHash();
  if (hashScreen) return hashScreen;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return 'chat';
  }
  if (!raw) return 'chat';
  if (!VALID_SCREENS.has(raw as Screen)) return 'chat';
  return raw as Screen;
}

export function persistScreen(screen: Screen): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, screen);
  } catch {
    // Storage blocked: the screen is simply not remembered.
  }
}
