import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const prototypeCss = readFileSync(join(process.cwd(), 'packages/web/src/styles/prototype.css'), 'utf8');
const tokensCss = readFileSync(join(process.cwd(), 'packages/web/src/styles/tokens.css'), 'utf8');
const appleCss = readFileSync(join(process.cwd(), 'packages/web/src/styles/apple.css'), 'utf8');
const approvalCardSource = readFileSync(join(process.cwd(), 'packages/web/src/components/ApprovalCard.tsx'), 'utf8');
const approvalInlineSource = readFileSync(join(process.cwd(), 'packages/web/src/components/ApprovalInline.tsx'), 'utf8');

describe('accessibility source guards', () => {
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
