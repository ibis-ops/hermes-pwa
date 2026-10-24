import { beforeEach, describe, expect, it } from 'vitest';
import { applyDefaultSkill, readDefaultSkill, writeDefaultSkill } from './defaultSkill';

describe('default skill', () => {
  beforeEach(() => window.localStorage.clear());

  it('is stored per profile', () => {
    writeDefaultSkill('coach', 'memory-never-forget');
    expect(readDefaultSkill('coach')).toBe('memory-never-forget');
    expect(readDefaultSkill('default')).toBeUndefined();
    writeDefaultSkill('coach', undefined);
    expect(readDefaultSkill('coach')).toBeUndefined();
  });

  it('prefixes only the first message of a new chat', () => {
    expect(applyDefaultSkill('hello', 'obsidian', true)).toBe('/obsidian hello');
    expect(applyDefaultSkill('hello', 'obsidian', false)).toBe('hello');
    expect(applyDefaultSkill('/pdf read it', 'obsidian', true)).toBe('/pdf read it');
    expect(applyDefaultSkill('hello', undefined, true)).toBe('hello');
    expect(applyDefaultSkill('   ', 'obsidian', true)).toBe('   ');
  });
});
