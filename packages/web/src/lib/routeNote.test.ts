import { describe, expect, it } from 'vitest';
import { routerTextKey, type Message, type RouterDecision } from '@hermes-pwa/core';
import { decisionsByKey, routeNoteText, routeNotesFor, tryResultText } from './routeNote';

function decision(partial: Partial<RouterDecision>): RouterDecision {
  return {
    at: '2026-10-27T20:00:00Z',
    bot: 'router',
    sessionId: 's-1',
    key: '',
    preview: '',
    route: null,
    guess: null,
    confidence: null,
    source: 'router',
    reason: '',
    ms: null,
    cost: null,
    provider: null,
    zdr: null,
    split: false,
    ...partial,
  };
}

describe('route notes', () => {
  it('says who took the message and how sure Jev was', () => {
    expect(routeNoteText(decision({ route: 'answer', source: 'jev', confidence: 0.934 }))).toBe('Quick answer · Jev 93% sure');
    expect(routeNoteText(decision({ route: 'gmail-connector', source: 'jev', confidence: 0.88 }))).toBe('Sent to Gmail Connector · Jev 88% sure');
    expect(routeNoteText(decision({ route: 'manager', source: 'jev', confidence: 0.97, split: true }))).toBe("Split across Manager's team · Jev 97% sure");
    expect(routeNoteText(decision({ route: 'answer', source: 'router' }))).toBe('Answered here');
    expect(routeNoteText(decision({ guess: 'manager', confidence: 0.4 }))).toBe('Router decided · Jev was not sure');
    expect(routeNoteText(decision({ reason: 'no OpenRouter key on the Mac' }))).toBe('Router decided · Jev not set up');
    expect(routeNoteText(decision({ reason: 'no Jev key on the Mac' }))).toBe('Router decided · Jev not set up');
    expect(routeNoteText(decision({ reason: 'Jev took too long' }))).toBe('Router decided · Jev unavailable');
    expect(routeNoteText(decision({ reason: 'Vercel AI Gateway is out of credits' }), { detailed: true })).toBe(
      'Router decided · Vercel AI Gateway is out of credits',
    );
  });

  it('puts each note under the first reply after the message it was about', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', text: 'Any email from clients?' },
      { id: 't1', role: 'tool', text: '' },
      { id: 'a1', role: 'assistant', text: 'Two from Kahunas clients.' },
      { id: 'a1b', role: 'assistant', text: 'Want replies drafted?' },
      { id: 'u2', role: 'user', text: 'thanks' },
      { id: 'a2', role: 'assistant', text: 'Anytime.' },
      { id: 'u3', role: 'user', text: 'not routed' },
      { id: 'a3', role: 'assistant', text: 'ok' },
    ] as Message[];
    const byKey = decisionsByKey([
      decision({ key: routerTextKey('thanks'), route: 'answer', source: 'jev', confidence: 0.99 }),
      decision({ key: routerTextKey('Any email from clients?'), route: 'gmail-connector', source: 'jev', confidence: 0.9 }),
      decision({ key: routerTextKey('thanks'), route: 'manager', source: 'jev', confidence: 0.7, at: '2026-10-26T10:00:00Z' }),
    ]);
    const notes = routeNotesFor(messages, byKey);
    expect(Object.fromEntries(notes)).toEqual({
      a1: 'Sent to Gmail Connector · Jev 90% sure',
      a2: 'Quick answer · Jev 99% sure',
    });
  });

  it('says where a tried message would go', () => {
    const base = { route: null, guess: null, confidence: null, source: 'router' as const, reason: '', split: false, team: [], ms: 200, cost: 0.00003 };
    expect(tryResultText({ ...base, route: 'answer', source: 'jev', confidence: 0.99 })).toBe('Router would answer it itself · Jev 99% sure');
    expect(tryResultText({ ...base, route: 'google-calander', source: 'jev', confidence: 1 })).toBe('It would go to Google Calander · Jev 100% sure');
    expect(
      tryResultText({ ...base, route: 'manager', source: 'jev', confidence: 0.97, split: true, team: ['default', 'gmail-connector', 'google-calander', 'signal-connector'] }),
    ).toBe("Router would split it across Manager's team (Default, Gmail Connector, Google Calander and 1 more) · Jev 97% sure");
    expect(tryResultText({ ...base, guess: 'manager', confidence: 0.42, reason: 'Jev was not sure' })).toBe(
      'Jev is not sure (best guess Manager, 42%), so Router would decide',
    );
    expect(tryResultText({ ...base, reason: 'Vercel AI Gateway is out of credits' })).toBe(
      'Jev did not decide: Vercel AI Gateway is out of credits. Router would decide',
    );
    expect(tryResultText({ ...base, route: 'answer', reason: 'no other bot to hand work to' })).toBe('Router would answer it: no other bot to hand work to');
  });
});
