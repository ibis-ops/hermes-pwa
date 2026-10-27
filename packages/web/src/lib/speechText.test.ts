import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, FIRST_CHUNK_CHARS, speakableText, speechChunks } from './speechText';

describe('speakableText', () => {
  it('reads markdown as plain sentences', () => {
    const reply = [
      '## Plan for today',
      '',
      'Here is **the short version** with a [link](https://example.com/docs) and `npm test`.',
      '- First item',
      '- [x] Done item',
      '> A quoted line',
    ].join('\n');
    expect(speakableText(reply)).toBe(
      [
        'Plan for today.',
        '',
        'Here is the short version with a link and npm test.',
        'First item.',
        'Done item.',
        'A quoted line.',
      ].join('\n'),
    );
  });

  it('skips code, names the block once, and keeps the text around it', () => {
    const reply = 'Run this:\n```bash\nrm -rf build\nnpm ci\n```\nThen restart.';
    expect(speakableText(reply)).toBe('Run this:\nCode block.\nThen restart.');
  });

  it('turns links, files, wikilinks, tables and dashes into speech', () => {
    const reply = [
      'See https://www.anthropic.com/news and @file:/Users/me/Desktop/report.pdf, plus [[Client Notes|the notes]].',
      '| Name | Dose |',
      '| --- | --- |',
      '| ApoB | 80 |',
      'Fast \u2014 but careful \u2192 done \u{1F680}',
    ].join('\n');
    expect(speakableText(reply)).toBe(
      [
        'See anthropic.com and attached file report.pdf, plus the notes.',
        'Name, Dose.',
        'ApoB, 80.',
        'Fast, but careful to done.',
      ].join('\n'),
    );
  });
});

describe('speechChunks', () => {
  it('starts with a short piece, then longer ones, without losing words', () => {
    const sentence = 'This sentence is about sixty characters long, give or take. ';
    const text = sentence.repeat(30).trim();
    const chunks = speechChunks(text);
    expect(chunks[0]!.length).toBeLessThanOrEqual(FIRST_CHUNK_CHARS);
    for (const chunk of chunks.slice(1)) expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(chunks.join(' ')).toBe(text);
  });

  it('does not end a sentence at a decimal point', () => {
    const chunks = speechChunks('Take 3.5 mg at night. Then 2.25 mg in the morning.', 30, 30);
    expect(chunks).toEqual(['Take 3.5 mg at night.', 'Then 2.25 mg in the morning.']);
  });

  it('splits a very long sentence at commas, then between words', () => {
    const long = `${'word '.repeat(60).trim()}, and then ${'more '.repeat(60).trim()}.`;
    const chunks = speechChunks(long, 120, 120);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long);
  });

  it('gives nothing for empty text', () => {
    expect(speechChunks(speakableText('   \n\n  '))).toEqual([]);
  });
});
