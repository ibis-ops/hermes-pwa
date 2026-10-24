import { describe, expect, it } from 'vitest';
import { groupRunsByDay, toAgentHistory, toAgentRun } from './agent-history';

describe('toAgentHistory', () => {
  it('maps runs, converting seconds to ms and unknown statuses', () => {
    const history = toAgentHistory({
      runs: [
        {
          id: 'sub1', bot: 'google-calander', owner_profile: 'default', goal: 'Check the calendar', model: 'claude-sonnet-5',
          status: 'completed', started_at: 1_792_859_832.1, ended_at: 1_792_859_895.4, duration_seconds: 63.3,
          message_count: 13, tool_call_count: 6, input_tokens: 12, output_tokens: 5492, cost_usd: null,
          last_activity: null, parent: { id: 'p', title: 'Check Google Calendar via delegate_task', source: 'oneshot', profile: 'default' },
          result: '## Summary',
        },
        { id: 'weird', bot: 'x', goal: 'y', status: 'exploded', started_at: 1_792_859_000 },
        { id: '', started_at: 1 },
      ],
      days: 30,
      total: 2,
      scanned_at: 1_792_860_000,
    });
    expect(history.runs).toHaveLength(2);
    expect(history.runs[0]).toMatchObject({ id: 'sub1', bot: 'google-calander', startedAt: 1_792_859_832_100, endedAt: 1_792_859_895_400, costUsd: undefined, status: 'completed' });
    expect(history.runs[0]?.parent?.title).toBe('Check Google Calendar via delegate_task');
    expect(history.runs[1]?.status).toBe('unknown');
    expect(history.scannedAt).toBe(1_792_860_000_000);
  });

  it('is empty for junk', () => {
    expect(toAgentHistory(undefined)).toEqual({ runs: [], days: undefined, total: 0, scannedAt: undefined, error: undefined });
    expect(toAgentRun('nope')).toBeUndefined();
  });
});

describe('groupRunsByDay', () => {
  it('buckets by local day newest first', () => {
    const base = { bot: 'b', ownerProfile: 'default', goal: 'g', model: undefined, status: 'completed' as const, endedAt: undefined, durationSeconds: 1, messageCount: 1, toolCallCount: 0, inputTokens: 0, outputTokens: 0, costUsd: undefined, lastActivity: undefined, parent: undefined, result: undefined };
    const groups = groupRunsByDay([
      { ...base, id: 'a', startedAt: new Date(2026, 9, 23, 22).getTime() },
      { ...base, id: 'b', startedAt: new Date(2026, 9, 24, 9).getTime() },
      { ...base, id: 'c', startedAt: new Date(2026, 9, 24, 10).getTime() },
    ]);
    expect(groups.map((g) => g.runs.map((r) => r.id))).toEqual([['c', 'b'], ['a']]);
  });
});
