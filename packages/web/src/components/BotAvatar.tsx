import { botLabel } from '@hermes-pwa/core';

// Two-tone fills in the spirit of the Contacts monograms, one per bot.
const FILLS: ReadonlyArray<readonly [string, string]> = [
  ['#64B5FF', '#1A73E8'],
  ['#6FDC8C', '#1E9E4A'],
  ['#FFB86B', '#E8730C'],
  ['#C59BFF', '#8540E0'],
  ['#FF8FA8', '#D93366'],
  ['#6ED9E8', '#1593A8'],
  ['#9A98FF', '#4B48D6'],
  ['#B7BCC6', '#7C828E'],
];

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

function botInitials(name: string): string {
  const words = botLabel(name).split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? name).slice(0, 1);
  return letters.toUpperCase();
}

/** A bot's monogram: its initials on a color of its own. */
export function BotAvatar({ name, size = 44 }: { name: string; size?: number }) {
  const [from, to] = FILLS[hash(name) % FILLS.length]!;
  return (
    <span
      className="hm-bot-avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `linear-gradient(180deg, ${from}, ${to})`,
      }}
    >
      {botInitials(name)}
    </span>
  );
}
