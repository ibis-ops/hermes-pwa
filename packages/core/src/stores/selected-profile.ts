/**
 * The bot chosen on this phone. It is a per-device choice: binding chats to a
 * profile needs nothing server-side, and POSTing the gateway's sticky active
 * profile would also switch the `hermes` CLI's default on the Mac.
 *
 * Lives apart from the profiles store so the chat store can scope its cold
 * start cache read by it without importing the profiles store (which imports
 * the chat store).
 */
export const SELECTED_PROFILE_STORAGE_KEY = 'hermes-pwa.selectedProfile.v1';

export function readSelectedProfile(): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(SELECTED_PROFILE_STORAGE_KEY);
    return raw ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writeSelectedProfile(name: string | undefined): void {
  try {
    if (name === undefined) globalThis.localStorage?.removeItem(SELECTED_PROFILE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(SELECTED_PROFILE_STORAGE_KEY, name);
  } catch {
    // Storage blocked: the choice lasts for this app session only.
  }
}
