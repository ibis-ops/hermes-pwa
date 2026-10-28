import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appleCss = readFileSync(join(process.cwd(), 'packages/web/src/styles/apple.css'), 'utf8');

describe('layout source guards', () => {
  it('lets a scrolling screen scroll instead of squeezing what is on it', () => {
    // A screen marked .hm-scroll scrolls inside itself.
    expect(appleCss).toMatch(/\.hm-screen > \.hm-scroll \{[^}]*overflow-y: auto;/);
    // The rounded Bots list clips its own overflow, so as a flex item it had no minimum height: it
    // shrank to the screen and its last bots could not be reached. Children of a scrolling screen
    // keep their full height.
    expect(appleCss).toMatch(/\.hm-screen > \.hm-scroll > \* \{\s*flex-shrink: 0;\s*\}/);
  });
});
