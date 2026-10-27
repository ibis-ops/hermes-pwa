import { describe, it, expect } from 'vitest';
import { linkifyWikilinks, wikilinkCandidates, wikilinkTarget } from './wikilinks';

describe('wikilinks', () => {
  it('turns plain, aliased and heading links into followable links', () => {
    expect(linkifyWikilinks('See [[Ann Lee]] and [[Ann Lee|her file]] or [[Plan#Week 2]].')).toBe(
      'See [Ann Lee](#wikilink=Ann%20Lee) and [her file](#wikilink=Ann%20Lee) or [Plan#Week 2](#wikilink=Plan).',
    );
  });

  it('leaves embeds and fenced code alone', () => {
    const text = '![[photo.png]]\n```\n[[not a link]]\n```\n[[Real]]';
    expect(linkifyWikilinks(text)).toBe('![[photo.png]]\n```\n[[not a link]]\n```\n[Real](#wikilink=Real)');
  });

  it('keeps parentheses in a name from ending the link early', () => {
    expect(linkifyWikilinks('[[Labs (May)]]')).toBe('[Labs (May)](#wikilink=Labs%20%28May%29)');
    expect(wikilinkTarget('#wikilink=Labs%20%28May%29')).toBe('Labs (May)');
  });

  it('reads the target back only from wikilink hrefs', () => {
    expect(wikilinkTarget('#wikilink=Ann%20Lee')).toBe('Ann Lee');
    expect(wikilinkTarget('https://example.com')).toBeUndefined();
    expect(wikilinkTarget(undefined)).toBeUndefined();
  });

  it('looks next to the linking note first, then at the vault root', () => {
    expect(wikilinkCandidates('Ann Lee', 'Clients/Ann Lee')).toEqual(['Clients/Ann Lee/Ann Lee.md', 'Ann Lee.md']);
    expect(wikilinkCandidates('Hermes/Open items', '')).toEqual(['Hermes/Open items.md']);
  });
});
