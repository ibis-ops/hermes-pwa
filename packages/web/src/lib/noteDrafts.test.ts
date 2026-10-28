import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftedNoteNames, noteDraftKey, readNoteDraft, writeNoteDraft } from './noteDrafts';

describe('noteDrafts', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps one draft per note and one for a new note, under the prefix signing out clears', () => {
    writeNoteDraft(noteDraftKey(undefined), {
      title: 'Groceries',
      text: 'Milk',
      version: undefined,
    });
    writeNoteDraft(noteDraftKey('Gym ideas.md'), { title: '', text: 'Leg day', version: 'v1' });
    writeNoteDraft(noteDraftKey('50% plan.md'), { title: '', text: 'x', version: 'v2' });

    expect(readNoteDraft(noteDraftKey(undefined))).toEqual({
      title: 'Groceries',
      text: 'Milk',
      version: undefined,
    });
    expect(readNoteDraft(noteDraftKey('Gym ideas.md'))).toEqual({
      title: '',
      text: 'Leg day',
      version: 'v1',
    });
    expect([...draftedNoteNames()].sort()).toEqual(['50% plan.md', 'Gym ideas.md']);
    for (let i = 0; i < window.localStorage.length; i += 1) {
      expect(window.localStorage.key(i)).toMatch(/^hermes-pwa\.obsidian\./);
    }

    writeNoteDraft(noteDraftKey('Gym ideas.md'), undefined);
    expect(readNoteDraft(noteDraftKey('Gym ideas.md'))).toBeUndefined();
    expect([...draftedNoteNames()]).toEqual(['50% plan.md']);
  });

  it('ignores what it cannot read, and works without storage', () => {
    window.localStorage.setItem('hermes-pwa.obsidian.noteDraft.v1:note%3ABroken.md', '{not json');
    window.localStorage.setItem('hermes-pwa.obsidian.noteDraft.v1:%E0%A4%A', '{"text":"x"}');
    expect(readNoteDraft(noteDraftKey('Broken.md'))).toBeUndefined();
    expect([...draftedNoteNames()]).toEqual([]);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() =>
      writeNoteDraft(noteDraftKey(undefined), { title: '', text: 'x', version: undefined }),
    ).not.toThrow();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readNoteDraft(noteDraftKey(undefined))).toBeUndefined();
  });
});
