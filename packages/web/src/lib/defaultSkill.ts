/**
 * The skill a profile's new chats start with. Stored on this device only:
 * Hermes has no such setting for the dashboard chat, so the app sends the
 * first message of a new chat as `/skill <message>` and Hermes expands it.
 */

const KEY_PREFIX = 'hermes-pwa.defaultSkill.v1:';

export const DEFAULT_SKILL_EVENT = 'hermes-pwa:default-skill';

function key(profile: string | undefined): string {
  return `${KEY_PREFIX}${profile ?? 'default'}`;
}

export function readDefaultSkill(profile: string | undefined): string | undefined {
  try {
    const value = window.localStorage.getItem(key(profile));
    return value && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function writeDefaultSkill(profile: string | undefined, skill: string | undefined): void {
  try {
    if (skill && skill.trim()) window.localStorage.setItem(key(profile), skill.trim());
    else window.localStorage.removeItem(key(profile));
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for the session only.
  }
  try {
    window.dispatchEvent(new CustomEvent(DEFAULT_SKILL_EVENT, { detail: { profile: profile ?? 'default', skill } }));
  } catch {
    // CustomEvent unsupported: listeners simply re-read on their next mount.
  }
}

/** `/skill text` when a default skill applies to this (new) chat, else the text unchanged. */
export function applyDefaultSkill(text: string, skill: string | undefined, isNewChat: boolean): string {
  const trimmed = text.trim();
  if (!skill || !isNewChat || !trimmed || trimmed.startsWith('/')) return text;
  return `/${skill} ${trimmed}`;
}
