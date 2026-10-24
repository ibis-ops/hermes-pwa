/** Timestamps in the chat list: iOS Messages style dividers between gaps. */

const DIVIDER_GAP_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Hermes stores epoch seconds; local rows may carry milliseconds. */
export function toMillis(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** A divider goes above `next` when it opens the list or follows a gap or a new day. */
export function needsTimeDivider(previous: number | undefined, next: number | undefined): boolean {
  if (next === undefined) return false;
  if (previous === undefined) return true;
  if (next - previous >= DIVIDER_GAP_MS) return true;
  return startOfDay(next) !== startOfDay(previous);
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "Today 6:42 PM", "Yesterday 3:10 PM", "Monday 9:12 AM", "Oct 12 at 9:12 AM". */
export function formatDividerTime(ms: number, nowMs = Date.now()): string {
  const time = TIME.format(ms);
  const dayDelta = Math.round((startOfDay(nowMs) - startOfDay(ms)) / DAY_MS);
  if (dayDelta <= 0) return `Today ${time}`;
  if (dayDelta === 1) return `Yesterday ${time}`;
  if (dayDelta < 7) return `${WEEKDAY.format(ms)} ${time}`;
  const sameYear = new Date(ms).getFullYear() === new Date(nowMs).getFullYear();
  return `${(sameYear ? MONTH_DAY : MONTH_DAY_YEAR).format(ms)} at ${time}`;
}

/** Short clock time for a single row, "6:42 PM". */
export function formatClockTime(ms: number): string {
  return TIME.format(ms);
}
