/**
 * Obsidian's [[wikilinks]] in a note, turned into links the note viewer can
 * follow. They become fragment links (`#wikilink=…`), which the markdown
 * renderer keeps as they are; the viewer catches them and opens the target
 * note in place. Fenced code is left alone, and so are embeds (`![[…]]`).
 */
export const WIKILINK_HREF_PREFIX = '#wikilink=';

// No lookbehind: older Safari fails to parse it, and a regex that does not
// parse takes the whole app down at load.
const WIKILINK = /(!?)\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g;
const FENCE = /^\s*(```|~~~)/;

function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

export function linkifyWikilinks(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(WIKILINK, (match, bang: string, target: string, heading: string | undefined, alias: string | undefined) => {
        const name = target.trim();
        if (bang || !name) return match;
        const label = (alias ?? (heading ? `${name}${heading}` : name)).trim();
        return `[${escapeLinkText(label)}](${WIKILINK_HREF_PREFIX}${encodeURIComponent(name).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})`;
      });
    })
    .join('\n');
}

/** The note name a wikilink href points at, or undefined for any other link. */
export function wikilinkTarget(href: string | undefined): string | undefined {
  if (!href || !href.startsWith(WIKILINK_HREF_PREFIX)) return undefined;
  try {
    return decodeURIComponent(href.slice(WIKILINK_HREF_PREFIX.length)) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a link's target may live, most likely first: a path as written, the
 * linking note's own folder, then the vault root. Obsidian resolves by name
 * across the whole vault; these cover how notes here link in practice, and
 * the viewer offers the Obsidian app when none of them exists.
 */
export function wikilinkCandidates(target: string, fromFolder: string): string[] {
  const withExtension = /\.(md|canvas|base)$/i.test(target) ? target : `${target}.md`;
  const candidates: string[] = [];
  if (target.includes('/')) candidates.push(withExtension.replace(/^\/+/, ''));
  if (fromFolder) candidates.push(`${fromFolder.replace(/\/+$/, '')}/${withExtension}`);
  candidates.push(withExtension);
  return [...new Set(candidates)];
}
