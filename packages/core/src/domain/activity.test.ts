import { describe, it, expect } from 'vitest';
import { toActionItem } from './activity';

describe('toActionItem', () => {
  it('maps approval', () => {
    const item = toActionItem({
      id: 'a-1',
      kind: 'approval',
      status: 'needs_you',
      title: 'Deploy',
      summary: 'Deploy to prod',
      high_impact: true,
      visibility: 'public',
      created_at: 123,
    });
    expect(item.id).toBe('a-1');
    expect(item.kind).toBe('approval');
    expect(item.title).toBe('Deploy');
    expect(item.summary).toBe('Deploy to prod');
    expect((item as import('./activity').Approval).highImpact).toBe(true);
    expect((item as import('./activity').Approval).visibility).toBe('public');
    expect(item.createdAt).toBe(123);
  });

  it('keeps the approval-queue request id from a recovery record', () => {
    const snake = toActionItem({ id: 'a-1', kind: 'approval', title: 'Deploy', request_id: 'q-77', session_id: 's-1' });
    expect((snake as import('./activity').Approval).requestId).toBe('q-77');
    const camel = toActionItem({ id: 'a-2', kind: 'approval', title: 'Deploy', requestId: 'q-78' });
    expect((camel as import('./activity').Approval).requestId).toBe('q-78');
    const blank = toActionItem({ id: 'a-3', kind: 'approval', title: 'Deploy', request_id: '  ' });
    expect((blank as import('./activity').Approval).requestId).toBeUndefined();
  });

  it('maps clarify', () => {
    const item = toActionItem({
      id: 'c-1',
      kind: 'clarify',
      status: 'needs_you',
      title: 'Clarify',
      question: 'Which env?',
    });
    expect(item.kind).toBe('clarify');
    expect((item as import('./activity').Clarify).question).toBe('Which env?');
  });

  it('defaults missing fields', () => {
    const item = toActionItem({});
    expect(item.id).toBe('');
    expect(item.kind).toBe('system');
    expect(item.status).toBe('needs_you');
    expect(item.title).toBe('Untitled');
    expect(item.summary).toBeUndefined();
    expect(item.createdAt).toBeGreaterThan(0);
  });
});
