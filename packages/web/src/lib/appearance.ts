/**
 * Light, dark, or whatever the phone is set to. Stored on this device only and
 * applied before the first paint (main.tsx), so the app never flashes the
 * other theme on launch.
 */
export type Appearance = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'hermes-pwa.appearance.v1';
const THEME_COLORS = { light: '#f2f2f7', dark: '#000000' } as const;

export function readAppearance(): Appearance {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyAppearance(value: Appearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (value === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', value);
  }
  // The status bar and the app switcher follow the same choice.
  for (const meta of Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))) {
    const media = meta.getAttribute('media') ?? '';
    const scheme = media.includes('dark') ? 'dark' : 'light';
    meta.setAttribute('content', THEME_COLORS[value === 'system' ? scheme : value]);
  }
}

export function writeAppearance(value: Appearance): void {
  try {
    if (value === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Private mode: the choice lasts until the app is closed.
  }
  applyAppearance(value);
}
