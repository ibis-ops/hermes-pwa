/**
 * The chat data this phone keeps for a fast start: cached transcripts (per
 * bot) and unsent drafts. Clearing them changes nothing on the Mac.
 */
const LOCAL_CHAT_PREFIXES = ['hermes-pwa.activeSession.', 'hermes-pwa.draft.'];

export function clearLocalChatCache(): number {
  let removed = 0;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key && LOCAL_CHAT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {
    // Storage blocked: nothing was cached either.
  }
  return removed;
}
