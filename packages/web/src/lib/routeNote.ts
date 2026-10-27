import { botLabel, ROUTER_SELF, routerTextKey, type Message, type RouterDecision } from '@hermes-pwa/core';

function sure(decision: RouterDecision): string {
  return decision.confidence !== null ? ` · Jev ${Math.round(decision.confidence * 100)}% sure` : '';
}

function capitalized(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * The small line under a router reply: who took the message, and how sure Jev
 * was. `detailed` (the Router sheet's list) also says why Jev did not decide.
 */
export function routeNoteText(decision: RouterDecision, options: { detailed?: boolean } = {}): string {
  if (decision.source === 'jev' && decision.route === ROUTER_SELF) return `Quick answer${sure(decision)}`;
  if (decision.source === 'jev' && decision.route && decision.split) return `Split across ${botLabel(decision.route)}'s team${sure(decision)}`;
  if (decision.source === 'jev' && decision.route) return `Sent to ${botLabel(decision.route)}${sure(decision)}`;
  if (decision.route === ROUTER_SELF) return 'Answered here';
  if (decision.guess) return 'Router decided · Jev was not sure';
  if (/no (jev|openrouter) key/i.test(decision.reason)) return 'Router decided · Jev not set up';
  if (options.detailed && decision.reason) return `Router decided · ${capitalized(decision.reason)}`;
  return 'Router decided · Jev unavailable';
}

/** Newest decision per message fingerprint (the log comes newest first). */
export function decisionsByKey(decisions: RouterDecision[]): Map<string, RouterDecision> {
  const byKey = new Map<string, RouterDecision>();
  for (const decision of decisions) if (decision.key && !byKey.has(decision.key)) byKey.set(decision.key, decision);
  return byKey;
}

/**
 * The note for each reply that answers a routed message: the first assistant
 * message after each of Sean's messages, keyed by that reply's id.
 */
export function routeNotesFor(messages: Message[], byKey: Map<string, RouterDecision>): Map<string, string> {
  const notes = new Map<string, string>();
  if (byKey.size === 0) return notes;
  let pending: RouterDecision | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      pending = byKey.get(routerTextKey(message.text));
    } else if (message.role === 'assistant' && pending) {
      notes.set(message.id, routeNoteText(pending));
      pending = undefined;
    }
  }
  return notes;
}
