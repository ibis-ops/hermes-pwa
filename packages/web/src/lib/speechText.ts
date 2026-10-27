/**
 * A reply as it should be heard: markdown, code, links and file references
 * turned into plain sentences, then cut into pieces a voice reads one at a
 * time. Pure, so it is tested without a browser.
 */

const FENCE = /^\s*(```|~~~)/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
// Emoji and pictographs read as their names ("smiling face with..."): left out.
// Alternation, not one class: joiners and selectors inside a class are flagged as misleading.
const PICTOGRAPHS = /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|\u200D|\uFE0F|\u20E3/gu;
const SENTENCE_END = /[.!?:;,…]["')\]”’]*$/;

/** The first piece is short so the voice starts quickly; later ones are longer. */
export const FIRST_CHUNK_CHARS = 180;
export const CHUNK_CHARS = 600;

function basename(path: string): string {
  const clean = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1) || clean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'a link';
  }
}

function inlineSpeech(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g, (_m, target: string, alias: string | undefined) =>
      (alias ?? target).trim(),
    )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/@file:(\S+)/g, (_m, path: string) => `attached file ${basename(path)}`)
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/https?:\/\/[^\s)>\]]+/g, (url) => hostOf(url))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s*(?:→|⇒|->)\s*/g, ' to ')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s&\s/g, ' and ')
    .replace(PICTOGRAPHS, '')
    .replace(/[ \t]{2,}/g, ' ');
}

/** Plain sentences, one line per paragraph or list item, each ending with a pause. */
export function speakableText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (FENCE.test(raw)) {
      // Code is not read; one mention per block says something was skipped.
      if (!inFence) out.push('Code block.');
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (TABLE_RULE.test(raw) || HORIZONTAL_RULE.test(raw)) continue;
    let line = raw;
    if (TABLE_ROW.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', ');
    }
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^\s*[-*+•]\s+/, '');
    line = inlineSpeech(line).trim();
    if (!line) {
      out.push('');
      continue;
    }
    if (!SENTENCE_END.test(line)) line += '.';
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Sentences of one paragraph. A period inside a number ("3.5") does not end one. */
function sentences(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < paragraph.length; i += 1) {
    const ch = paragraph[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    let end = i + 1;
    while (end < paragraph.length && /[.!?…"')\]”’]/.test(paragraph[end] ?? '')) end += 1;
    if (end < paragraph.length && !/\s/.test(paragraph[end] ?? '')) continue;
    const sentence = paragraph.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
    i = end - 1;
  }
  const rest = paragraph.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

function hardSplit(word: string, limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i += limit) out.push(word.slice(i, i + limit));
  return out;
}

/**
 * A sentence longer than a piece, split after commas, semicolons and colons
 * first, then between words. No lookbehind: older Safari fails to parse it,
 * and a regex that does not parse takes the whole app down at load.
 */
function splitLong(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const units: string[] = [];
  for (const clause of sentence.replace(/([,;:])\s+/g, '$1\n').split('\n')) {
    if (clause.length <= limit) {
      units.push(clause);
      continue;
    }
    for (const word of clause.split(/\s+/)) units.push(...(word.length > limit ? hardSplit(word, limit) : [word]));
  }
  const pieces: string[] = [];
  let current = '';
  for (const unit of units) {
    if (!unit) continue;
    const next = current ? `${current} ${unit}` : unit;
    if (next.length > limit && current) {
      pieces.push(current);
      current = unit;
    } else {
      current = next;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Pieces of whole sentences, the first short so playback starts fast. */
export function speechChunks(text: string, firstLimit = FIRST_CHUNK_CHARS, limit = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  const cap = () => (chunks.length === 0 ? firstLimit : limit);
  for (const paragraph of text.split(/\n+/)) {
    for (const sentence of sentences(paragraph)) {
      for (const piece of splitLong(sentence, cap())) {
        const next = current ? `${current} ${piece}` : piece;
        if (next.length > cap() && current) {
          chunks.push(current);
          current = piece;
        } else {
          current = next;
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
