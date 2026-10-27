/**
 * The read-aloud voice and speed, kept on this phone only. The voice is one of
 * the Mac's (by name); unset means the best one installed there.
 */

export interface ReadAloudSettings {
  voice: string | undefined;
  /** 1 is normal speed. */
  rate: number;
}

export const READ_ALOUD_RATES = [
  { label: 'Slower', value: 0.85 },
  { label: 'Normal', value: 1 },
  { label: 'Faster', value: 1.2 },
] as const;

const STORAGE_KEY = 'hermes-pwa.readAloud.v1';
const DEFAULTS: ReadAloudSettings = { voice: undefined, rate: 1 };
// When storage refuses a write, the last choice lives here until the app closes.
let unsaved: ReadAloudSettings | undefined;

export function readReadAloudSettings(): ReadAloudSettings {
  if (unsaved) return { ...unsaved };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rate = typeof parsed.rate === 'number' && parsed.rate >= 0.5 && parsed.rate <= 2 ? parsed.rate : 1;
    const voice = typeof parsed.voice === 'string' && parsed.voice ? parsed.voice : undefined;
    return { voice, rate };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeReadAloudSettings(settings: ReadAloudSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    unsaved = undefined;
  } catch {
    unsaved = { ...settings };
  }
}
