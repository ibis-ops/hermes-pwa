import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const prototypeCss = readFileSync(join(process.cwd(), 'packages/web/src/styles/prototype.css'), 'utf8');
const tokensCss = readFileSync(join(process.cwd(), 'packages/web/src/styles/tokens.css'), 'utf8');
const appleCss = readFileSync(join(process.cwd(), 'packages/web/src/styles/apple.css'), 'utf8');
const approvalCardSource = readFileSync(join(process.cwd(), 'packages/web/src/components/ApprovalCard.tsx'), 'utf8');
const approvalInlineSource = readFileSync(join(process.cwd(), 'packages/web/src/components/ApprovalInline.tsx'), 'utf8');

function hexLuminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function lightToken(name: string): string {
  const light = tokensCss.slice(tokensCss.indexOf(':root {'), tokensCss.indexOf(":root[data-theme='dark']"));
  const match = light.match(new RegExp(`--hm-color-${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match?.[1]) throw new Error(`token ${name} not found`);
  return match[1];
}

describe('accessibility source guards', () => {
  it('keeps text tokens at WCAG AA on the light surfaces', () => {
    for (const surface of ['#ffffff', '#f2f2f7']) {
      expect(contrast(lightToken('accent-text'), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(lightToken('danger-text'), surface)).toBeGreaterThanOrEqual(4.5);
    }
    // White on the blue fill (user bubbles, primary buttons) and on badges.
    expect(contrast('#ffffff', lightToken('primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', lightToken('badge'))).toBeGreaterThanOrEqual(4.5);
    expect(tokensCss).toContain('--hm-color-text-muted: rgba(60, 60, 67, 0.74);');
  });

  it('gives small controls a 44pt hit area', () => {
    expect(appleCss).toMatch(/width: max\(100%, 44px\);\s*height: max\(100%, 44px\);/);
  });

  it('keeps keyboard focus-visible rings available for interactive controls', () => {
    expect(prototypeCss).toContain('button:focus-visible');
    expect(prototypeCss).toContain('textarea:focus-visible');
    expect(prototypeCss).toContain('outline: 2px solid var(--hm-color-primary)');
  });

  it('keeps approval risk badges on high-contrast semantic tokens', () => {
    expect(tokensCss).toContain('--hm-color-danger-strong');
    expect(tokensCss).toContain('--hm-color-success-strong');
    expect(approvalCardSource).not.toMatch(/#(?:c4413c|15a06a|fdeaea|e3fbef)/i);
    expect(approvalInlineSource).not.toMatch(/#(?:dc4b46|15a06a|fdeaea|e3fbef|fff4e3|d98a16)/i);
    // The risk pill colors live in the stylesheet, on semantic tokens.
    expect(appleCss).toMatch(/\.hm-approval-card__risk--danger[^}]*var\(--hm-color-danger-strong\)/);
    expect(appleCss).toMatch(/\.hm-approval-inline__risk--danger[^}]*var\(--hm-color-danger-strong\)/);
  });
});
