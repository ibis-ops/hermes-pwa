import { useCallback, useEffect, useMemo, useState } from 'react';
import { HermesHttpError, type Message, type RestClient, type RouterDecision, type RouterStatus } from '@hermes-pwa/core';
import { decisionsByKey, routeNotesFor } from '../lib/routeNote';

export interface RouterStatusState {
  status: RouterStatus | undefined;
  /** The dashboard on the Mac still runs code from before the router (it needs a restart). */
  missing: boolean;
  error: string | undefined;
  reload: () => void;
  setStatus: (status: RouterStatus) => void;
}

/** The router's settings and newest decisions, from the plugin on the Mac. */
export function useRouterStatus(rest: RestClient): RouterStatusState {
  const [status, setStatus] = useState<RouterStatus | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    // Promise.resolve first: a client without the call (an older shell) rejects instead of throwing.
    Promise.resolve()
      .then(() => rest.routerStatus())
      .then((next) => {
        if (!alive) return;
        setStatus(next);
        setMissing(false);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof HermesHttpError && err.status === 404) setMissing(true);
        else setError(err instanceof Error && err.message ? err.message : 'Could not reach the router settings.');
      });
    return () => {
      alive = false;
    };
  }, [rest, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { status, missing, error, reload, setStatus };
}

/**
 * Under each reply in the router bot's chat, who Jev sent the message to.
 * Asks the Mac for the newest decisions when the chat opens and after each turn.
 */
export function useRouteNotes(rest: RestClient, activeBot: string | undefined, messages: Message[], streaming: boolean): Map<string, string> {
  const [routerBot, setRouterBot] = useState<string | undefined>(undefined);
  const [decisions, setDecisions] = useState<RouterDecision[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => rest.routerStatus())
      .then((status) => {
        if (alive) setRouterBot(status.settings.enabled ? status.settings.bot : undefined);
      })
      .catch(() => {
        if (alive) setRouterBot(undefined);
      });
    return () => {
      alive = false;
    };
  }, [rest, activeBot]);

  const isRouter = Boolean(activeBot && routerBot && activeBot === routerBot);
  const userCount = useMemo(() => messages.filter((message) => message.role === 'user').length, [messages]);

  // Asked when the chat opens, a moment after each message (Jev has decided by the time the
  // reply starts), and when the reply ends.
  useEffect(() => {
    if (!isRouter) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      Promise.resolve()
        .then(() => rest.routerDecisions(undefined, 100))
        .then((next) => {
          if (alive) setDecisions(next);
        })
        .catch(() => undefined);
    }, streaming ? 1500 : 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [rest, isRouter, streaming, userCount]);

  return useMemo(() => (isRouter ? routeNotesFor(messages, decisionsByKey(decisions)) : new Map<string, string>()), [isRouter, messages, decisions]);
}
