import { describe, expect, it } from 'vitest';
import {
  attachmentRefs,
  extractFileRefs,
  localFileUrl,
  stripAttachmentRefs,
  MAX_FILE_REFS_PER_MESSAGE,
} from './file-refs';

describe('extractFileRefs', () => {
  it('finds absolute image and file paths in prose', () => {
    const text =
      'Saved it to /Users/sean/.hermes/cache/images/computer_use_57de.png and the export is at /Users/sean/Desktop/report.pdf.';
    expect(extractFileRefs(text)).toEqual([
      { path: '/Users/sean/.hermes/cache/images/computer_use_57de.png', name: 'computer_use_57de.png', ext: 'png', kind: 'image' },
      { path: '/Users/sean/Desktop/report.pdf', name: 'report.pdf', ext: 'pdf', kind: 'file' },
    ]);
  });

  it('handles backticks, quotes, parentheses, tilde and escaped spaces', () => {
    const text = [
      'Here: `~/Desktop/My\\ Shot.png`',
      'and "/Users/sean/Documents/notes.md" (see /tmp/out.csv).',
      '<file:///Users/sean/Downloads/clip.mov>',
    ].join('\n');
    expect(extractFileRefs(text).map((r) => r.path)).toEqual([
      '~/Desktop/My Shot.png',
      '/Users/sean/Documents/notes.md',
      '/tmp/out.csv',
      '/Users/sean/Downloads/clip.mov',
    ]);
  });

  it('ignores paths without a known extension and directories', () => {
    expect(extractFileRefs('look in /Users/sean/Developer and /usr/bin/python3 and /Users/sean/.hermes/config')).toEqual([]);
    expect(extractFileRefs('run /Users/sean/script.unknownext')).toEqual([]);
  });

  it('de-duplicates and caps the count', () => {
    const many = Array.from({ length: 20 }, (_, i) => `/tmp/f${i}.png`).join(' ') + ' /tmp/f0.png';
    const refs = extractFileRefs(many);
    expect(refs).toHaveLength(MAX_FILE_REFS_PER_MESSAGE);
    expect(new Set(refs.map((r) => r.path)).size).toBe(MAX_FILE_REFS_PER_MESSAGE);
  });

  it('reads @file: references', () => {
    expect(extractFileRefs('@file:/Users/sean/.hermes/attachments/photo.jpg')).toEqual([
      { path: '/Users/sean/.hermes/attachments/photo.jpg', name: 'photo.jpg', ext: 'jpg', kind: 'image' },
    ]);
  });

  it('keeps relative @file references as written', () => {
    expect(extractFileRefs('see @file:attachments/gradient.png')).toEqual([
      { path: 'attachments/gradient.png', name: 'gradient.png', ext: 'png', kind: 'image' },
    ]);
    expect(attachmentRefs('hi\n\n@file:attachments/labs.pdf').map((r) => r.path)).toEqual(['attachments/labs.pdf']);
  });

  it('returns nothing for empty input', () => {
    expect(extractFileRefs(undefined)).toEqual([]);
    expect(extractFileRefs('')).toEqual([]);
  });
});

describe('stripAttachmentRefs and attachmentRefs', () => {
  const text = 'What is in this photo?\n\n@file:/Users/sean/.hermes/attachments/photo.jpg\n\n@file:/Users/sean/.hermes/attachments/labs.pdf';

  it('drops the attached-context block Hermes appends to stored prompts', () => {
    const stored =
      'What colors?\n\n@file:attachments/gradient.png\n\n--- Attached Context ---\n\n📎 @file:attachments/gradient.png (image/png, 103.4 KB) — binary file. It is available on disk at `/Users/x/.hermes/attachments/gradient.png`. Use your tools.';
    expect(stripAttachmentRefs(stored)).toBe('What colors?');
    expect(attachmentRefs(stored).map((r) => r.path)).toEqual(['attachments/gradient.png']);
  });

  it('removes the @file lines from the visible text', () => {
    expect(stripAttachmentRefs(text)).toBe('What is in this photo?');
    expect(stripAttachmentRefs('@file:/Users/sean/a.png')).toBe('');
    expect(stripAttachmentRefs('plain text')).toBe('plain text');
  });

  it('lists the attachments', () => {
    expect(attachmentRefs(text).map((r) => [r.name, r.kind])).toEqual([
      ['photo.jpg', 'image'],
      ['labs.pdf', 'file'],
    ]);
    expect(attachmentRefs('no attachments here')).toEqual([]);
  });
});

describe('localFileUrl', () => {
  it('encodes the path as a query parameter on the plugin route', () => {
    expect(localFileUrl('', '/Users/sean/Desktop/My Shot.png')).toBe(
      '/api/plugins/hermes-pwa/file?path=%2FUsers%2Fsean%2FDesktop%2FMy%20Shot.png',
    );
    expect(localFileUrl('https://mac.example', '/tmp/a.png')).toBe(
      'https://mac.example/api/plugins/hermes-pwa/file?path=%2Ftmp%2Fa.png',
    );
  });
});
