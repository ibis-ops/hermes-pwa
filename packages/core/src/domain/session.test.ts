import { describe, expect, it } from 'vitest';
import {
  mergeBrowseOnlySessions,
  mergeSessionsByLineage,
  sessionCurrentSourceId,
  sessionFromAgentRun,
  sessionHasDifferentCurrentSource,
  sessionSourceId,
  toSession,
} from './session';
import type { AgentRun } from './agent-history';

function run(overrides: Partial<AgentRun> & Pick<AgentRun, 'id' | 'startedAt'>): AgentRun {
  return {
    bot: 'google-calander',
    ownerProfile: 'default',
    goal: 'Check the calendar',
    model: undefined,
    status: 'completed',
    endedAt: undefined,
    durationSeconds: undefined,
    messageCount: 13,
    toolCallCount: 2,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: undefined,
    lastActivity: undefined,
    parent: undefined,
    result: undefined,
    ...overrides,
  };
}

describe('session domain source helpers', () => {
  it('maps backend rows with a local source', () => {
    const session = toSession({ id: 's-1', title: 'CLI work', source: 'cli' });

    expect(session.source).toBe('cli');
    expect(sessionSourceId(session)).toBe('cli');
  });

  it('preserves lineage metadata while keeping the fresher openable local row', () => {
    const [merged] = mergeSessionsByLineage([], [
      toSession({
        id: 'old-branch',
        title: 'Local branch 18',
        source: 'cli',
        _lineage_root_id: 'root-chat',
        last_active: 100,
        message_count: 80,
      }),
      toSession({
        id: 'current-head',
        title: 'Local branch 22',
        source: 'tui',
        _lineage_root_id: 'root-chat',
        last_active: 300,
        message_count: 336,
      }),
    ]);

    expect(merged?.id).toBe('current-head');
    expect(merged?.lineageRootId).toBe('root-chat');
    expect(sessionSourceId(merged!)).toBe('tui');
  });

  it('uses origin source for primary identity and current source separately', () => {
    const session = toSession({ id: 'head', source: 'cli', origin_source: 'cli', current_source: 'tui' });

    expect(session.source).toBe('cli');
    expect(session.originSource).toBe('cli');
    expect(session.currentSource).toBe('tui');
    expect(sessionSourceId(session)).toBe('cli');
    expect(sessionCurrentSourceId(session)).toBe('tui');
    expect(sessionHasDifferentCurrentSource(session)).toBe(true);
  });

  it('keeps cli origin while opening the fresher tui head', () => {
    const [merged] = mergeSessionsByLineage([], [
      toSession({
        id: 'old-cli',
        title: 'CLI branch',
        source: 'cli',
        origin_source: 'cli',
        current_source: 'cli',
        _lineage_root_id: 'root-chat',
        last_active: 100,
        message_count: 80,
      }),
      toSession({
        id: 'head-tui',
        title: 'TUI head',
        source: 'tui',
        origin_source: 'cli',
        current_source: 'tui',
        _lineage_root_id: 'root-chat',
        last_active: 300,
        message_count: 336,
      }),
    ]);

    expect(merged?.id).toBe('head-tui');
    expect(merged?.lineageRootId).toBe('root-chat');
    expect(merged?.originSource).toBe('cli');
    expect(merged?.currentSource).toBe('tui');
    expect(sessionSourceId(merged!)).toBe('cli');
    expect(sessionCurrentSourceId(merged!)).toBe('tui');
  });
});

describe('browse-only sessions from the plugin agent history', () => {
  it('maps a delegated run to a read-only session row in the delegating store under the bot name', () => {
    const session = sessionFromAgentRun(
      run({
        id: 'sub-1',
        startedAt: 1_792_859_000_000,
        endedAt: 1_792_859_900_000,
        status: 'running',
        parent: { id: 'p-1', title: 'Morning chat', source: 'signal', profile: 'default' },
      }),
    );

    expect(session).toMatchObject({
      id: 'sub-1',
      title: 'Check the calendar',
      profile: 'default',
      profileName: 'google-calander',
      parentSessionId: 'p-1',
      source: 'subagent',
      originSource: 'subagent',
      messageCount: 13,
      isActive: true,
      archived: false,
      startedAt: 1_792_859_000_000,
      lastActive: 1_792_859_900_000,
      updatedAt: 1_792_859_900_000,
    });
    expect(sessionSourceId(session)).toBe('subagent');
  });

  it('adds delegated runs to the listed rows newest first, without doubling a listed run', () => {
    const listed = [
      toSession({ id: 'cron-1', title: 'Nightly review', source: 'cron', profile: 'default', last_active: 1_792_860_000 }),
      toSession({ id: 'sub-listed', title: 'Already listed', source: 'subagent', profile: 'default', last_active: 1_792_850_000 }),
    ];
    const runs = [
      run({ id: 'sub-old', startedAt: 1_792_840_000_000 }),
      run({ id: 'sub-listed', startedAt: 1_792_850_000_000 }),
      run({ id: 'sub-new', startedAt: 1_792_870_000_000, ownerProfile: 'manager', bot: 'signal-connector' }),
    ];

    const merged = mergeBrowseOnlySessions(listed, runs);

    expect(merged.map((s) => s.id)).toEqual(['sub-new', 'cron-1', 'sub-listed', 'sub-old']);
    expect(merged.filter((s) => s.id === 'sub-listed')).toHaveLength(1);
    expect(merged[0]?.profile).toBe('manager');
    expect(merged[0]?.profileName).toBe('signal-connector');
  });

  it('caps the delegated runs it adds to the newest ones', () => {
    const runs = [1, 2, 3, 4].map((n) => run({ id: `sub-${n}`, startedAt: 1_792_800_000_000 + n * 1000 }));

    const merged = mergeBrowseOnlySessions([], runs, 2);

    expect(merged.map((s) => s.id)).toEqual(['sub-4', 'sub-3']);
  });
});
