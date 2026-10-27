import { describe, expect, it } from 'vitest';
import { ENGLISH_SCHEDULE_STRINGS, describeSchedule } from './cron';

const say = (expr: string) => describeSchedule(undefined, expr, ENGLISH_SCHEDULE_STRINGS);

describe('describeSchedule', () => {
  it('reads a bare cron expression as words', () => {
    expect(say('0 3 * * *')).toBe('Daily at 03:00');
    expect(say('0 4 * * 0')).toBe('Weekly on Sun at 04:00');
    expect(say('*/15 * * * *')).toBe('Every 15 minutes');
    expect(say('0 */6 * * *')).toBe('Every 6 hours');
    expect(say('0 * * * *')).toBe('Every hour');
    expect(say('* * * * *')).toBe('Every minute');
    expect(say('5 4 1 */2 *')).toBe('5 4 1 */2 *');
  });

  it('still prefers the structured schedule', () => {
    expect(describeSchedule({ kind: 'interval', minutes: 120 } as never, '0 3 * * *', ENGLISH_SCHEDULE_STRINGS)).toBe('Every 2 hours');
  });
});
