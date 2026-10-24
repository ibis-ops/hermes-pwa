import { describe, expect, it } from 'vitest';
import { formatDividerTime, needsTimeDivider, toMillis } from './chatTime';

describe('chat time dividers', () => {
  it('converts Hermes seconds and local milliseconds', () => {
    expect(toMillis(1_792_802_606.6)).toBe(1_792_802_606_600);
    expect(toMillis(1_792_802_606_600)).toBe(1_792_802_606_600);
    expect(toMillis(undefined)).toBeUndefined();
  });

  it('places a divider at the start, after a gap and on a new day', () => {
    const t = Date.UTC(2026, 9, 23, 20, 0, 0);
    expect(needsTimeDivider(undefined, t)).toBe(true);
    expect(needsTimeDivider(t, t + 5 * 60_000)).toBe(false);
    expect(needsTimeDivider(t, t + 16 * 60_000)).toBe(true);
    expect(needsTimeDivider(t, undefined)).toBe(false);
    const late = new Date(2026, 9, 23, 23, 58).getTime();
    expect(needsTimeDivider(late, late + 4 * 60_000)).toBe(true);
  });

  it('labels today, yesterday, weekdays and dates', () => {
    const now = new Date(2026, 9, 23, 19, 0).getTime();
    expect(formatDividerTime(new Date(2026, 9, 23, 18, 42).getTime(), now)).toMatch(/^Today /);
    expect(formatDividerTime(new Date(2026, 9, 22, 15, 10).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatDividerTime(new Date(2026, 9, 20, 9, 12).getTime(), now)).toMatch(/^Tuesday /);
    expect(formatDividerTime(new Date(2026, 9, 1, 9, 12).getTime(), now)).toMatch(/^Oct 1 at /);
    expect(formatDividerTime(new Date(2025, 9, 1, 9, 12).getTime(), now)).toMatch(/2025 at /);
  });
});
