import { afterEach, describe, expect, it } from 'vitest';
import { applyTextSize } from './textSize';

describe('applyTextSize', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('font-size');
  });

  it('leaves the 17px root alone where the system font keyword is unknown', () => {
    document.documentElement.style.fontSize = '30px';
    applyTextSize();
    expect(document.documentElement.style.fontSize).toBe('');
  });
});
