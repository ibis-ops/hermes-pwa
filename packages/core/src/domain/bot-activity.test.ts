import { describe, expect, it } from 'vitest';
import { describeActivity, toBotActivityReport, workingBots } from './bot-activity';

const RAW = {
  scanned_at: 1_793_150_000,
  working_window_seconds: 180,
  bots: {
    router: {
      working: true,
      work: [
        {
          kind: 'chat',
          title: 'Is the backup done?',
          activity: 'executing tool: delegate_task',
          requested_by: null,
          source: 'tui',
          session_id: 's-1',
          started_at: 1_793_149_950,
          updated_at: 1_793_149_990,
        },
      ],
      last_active_at: 1_793_149_990,
      last_title: 'Is the backup done?',
    },
    'google-calander': {
      working: true,
      work: [
        { kind: 'delegated', title: 'Count tomorrow', activity: 'starting API call #2', requested_by: 'router', source: 'subagent' },
        { kind: 'weird', title: 'Second job' },
      ],
      last_active_at: 1_793_149_999,
      last_title: 'Count tomorrow',
    },
    manager: { working: false, work: [], last_active_at: 1_793_000_000, last_title: 'Plan the week' },
    'Not A Bot!': { working: true, work: [{ kind: 'chat' }] },
    ghost: { working: true, work: [] },
  },
};

describe('toBotActivityReport', () => {
  it('reads each bot, its live work and when it was last active', () => {
    const report = toBotActivityReport(RAW);
    expect(Object.keys(report.bots).sort()).toEqual(['ghost', 'google-calander', 'manager', 'router']);
    expect(report.scannedAt).toBe(1_793_150_000_000);
    const router = report.bots.router!;
    expect(router.working).toBe(true);
    expect(router.work[0]).toMatchObject({
      kind: 'chat',
      title: 'Is the backup done?',
      activity: 'executing tool: delegate_task',
      requestedBy: undefined,
      sessionId: 's-1',
      startedAt: 1_793_149_950_000,
    });
    const calendar = report.bots['google-calander']!;
    expect(calendar.work[0]?.requestedBy).toBe('router');
    // An unknown kind is read as a chat rather than dropped.
    expect(calendar.work[1]?.kind).toBe('chat');
    expect(report.bots.manager).toMatchObject({ working: false, work: [], lastTitle: 'Plan the week' });
    // "Working" with nothing to show is not working.
    expect(report.bots.ghost?.working).toBe(false);
  });

  it('survives an empty or broken answer', () => {
    expect(toBotActivityReport(undefined)).toEqual({ bots: {}, scannedAt: undefined, error: undefined });
    expect(toBotActivityReport({ bots: [], error: 'scan failed' })).toEqual({ bots: {}, scannedAt: undefined, error: 'scan failed' });
  });

  it('lists the working bots, busiest first', () => {
    expect(workingBots(toBotActivityReport(RAW))).toEqual(['google-calander', 'router']);
    expect(workingBots(undefined)).toEqual([]);
  });
});

describe('describeActivity', () => {
  it('turns Hermes step labels into a few plain words', () => {
    expect(describeActivity('executing tool: search_files')).toBe('Searching files');
    expect(describeActivity('executing tool: terminal')).toBe('Using the terminal');
    expect(describeActivity('executing tool: delegate_task')).toBe('Handing work to a bot');
    expect(describeActivity('executing tool: browser_navigate')).toBe('Using the browser');
    expect(describeActivity('executing tool: mcp_signal_bridge_get_unread')).toBe('Using a connector');
    expect(describeActivity('executing tool: kanban_board')).toBe('Using kanban board');
    expect(describeActivity('executing 2 tools concurrently: read_file, web_search')).toBe('Reading a file and searching the web');
    expect(describeActivity('starting API call #3')).toBe('Thinking');
    expect(describeActivity('waiting for stream response (12s, no chunks yet)')).toBe('Thinking');
    expect(describeActivity('tool completed: search_files (2.1s)')).toBe('Thinking');
    expect(describeActivity('context compression in progress')).toBe('Compacting the chat');
    expect(describeActivity('stream retry 2/3 after TimeoutError')).toBe('Retrying the model');
    expect(describeActivity('something new')).toBe('Something new');
    expect(describeActivity('')).toBeUndefined();
    expect(describeActivity(undefined)).toBeUndefined();
  });
});
