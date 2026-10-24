/**
 * File references inside chat text.
 *
 * Hermes has no attachment channel on the dashboard chat: when it saves a
 * screenshot or an export it prints the absolute path, and when the user
 * attaches a file the composer appends `@file:/path`. This module finds both so
 * the UI can show an image or a file card and strip the raw `@file:` lines from
 * the user bubble. It is pure string work; fetching happens in the UI through
 * the plugin's `/file` route.
 */

export type FileRefKind = 'image' | 'file';

export interface FileRef {
  /** Absolute path as written, `~` kept as written. */
  path: string;
  /** Last path segment. */
  name: string;
  kind: FileRefKind;
  /** Lower-case extension without the dot. */
  ext: string;
}

export const MAX_FILE_REFS_PER_MESSAGE = 12;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp']);

const FILE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'log',
  'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'sql', 'rb', 'go', 'rs', 'swift', 'java',
  'zip', 'tar', 'gz', 'tgz', '7z', 'dmg',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'caf',
  'mp4', 'm4v', 'mov', 'webm', 'mkv',
  'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'key', 'numbers', 'pages', 'drp', 'fcpxml',
]);

/**
 * Absolute or home-relative paths. Backslash escapes for spaces (`My\ File.png`)
 * are accepted; otherwise a path ends at whitespace, a quote, a backtick, a
 * bracket or an angle bracket.
 */
const PATH_PATTERN = /(?:@file:)?((?:~|\/(?:Users|home|tmp|private|Volumes|var|opt))(?:\\ |[^\s"'`()[\]{}<>])*)/g;

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function cleanPath(raw: string): string {
  let path = raw.replace(/\\ /g, ' ').trim();
  path = path.replace(TRAILING_PUNCTUATION, '');
  // A markdown link or sentence may wrap the path in a trailing `)` already
  // excluded by the pattern; a stray closing quote is excluded as well.
  return path;
}

function refFromPath(path: string): FileRef | undefined {
  if (!path || path === '~') return undefined;
  const name = path.split('/').filter(Boolean).pop() ?? '';
  const ext = extensionOf(name);
  if (!ext || !FILE_EXTENSIONS.has(ext)) return undefined;
  return { path, name, ext, kind: IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file' };
}

/**
 * `@file:` references the composer appends. Hermes resolves a relative one
 * (`attachments/photo.jpg`) against its home directory, and so does the file
 * route, so the path is kept exactly as written.
 */
const ATTACHMENT_PATTERN = /@file:([^\s"'`<>]+)/g;

/** Find file references in `text`, in order of first appearance, de-duplicated. */
export function extractFileRefs(text: string | undefined): FileRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: FileRef[] = [];
  const add = (path: string) => {
    if (seen.has(path)) return;
    const ref = refFromPath(path);
    if (!ref) return;
    seen.add(path);
    refs.push(ref);
  };
  // Positions let prose paths and @file refs keep their order of appearance.
  const found: { index: number; path: string }[] = [];
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    found.push({ index: match.index ?? 0, path: cleanPath(match[1] ?? '') });
  }
  for (const match of text.matchAll(PATH_PATTERN)) {
    found.push({ index: match.index ?? 0, path: cleanPath(match[1] ?? '') });
  }
  found.sort((a, b) => a.index - b.index);
  for (const item of found) {
    add(item.path);
    if (refs.length >= MAX_FILE_REFS_PER_MESSAGE) break;
  }
  return refs;
}

/**
 * The user's message without the `@file:` reference lines the composer added,
 * so the bubble shows what they typed and the attachments render as cards.
 */
export function stripAttachmentRefs(text: string | undefined): string {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => !/^\s*@file:\S/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Attachment paths the composer appended as `@file:` lines. */
export function attachmentRefs(text: string | undefined): FileRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: FileRef[] = [];
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const path = cleanPath(match[1] ?? '');
    if (!path || seen.has(path)) continue;
    const ref = refFromPath(path);
    if (!ref) continue;
    seen.add(path);
    refs.push(ref);
    if (refs.length >= MAX_FILE_REFS_PER_MESSAGE) break;
  }
  return refs;
}

/** Query-string URL for the plugin's file route; `base` is the API origin ('' for same-origin). */
export function localFileUrl(base: string, path: string): string {
  return `${base}/api/plugins/hermes-pwa/file?path=${encodeURIComponent(path)}`;
}

export function localFileInfoUrl(base: string, path: string): string {
  return `${base}/api/plugins/hermes-pwa/file/info?path=${encodeURIComponent(path)}`;
}
