import { useEffect, useState } from 'react';
import type { Message } from '@hermes-pwa/core';
import { formatClockTime, formatElapsed, toMillis } from '../lib/chatTime';

interface MessageMetaProps {
  message: Message;
  /** True while this assistant reply is still being produced. */
  active?: boolean | undefined;
  /** Epoch seconds of the prompt the reply answers. */
  elapsedFrom?: number | undefined;
}

function elapsedSeconds(startMs: number | undefined, endMs: number | undefined): number | undefined {
  if (startMs === undefined || endMs === undefined) return undefined;
  const seconds = (endMs - startMs) / 1000;
  return seconds >= 0 ? seconds : undefined;
}

/**
 * The line under a bubble: when it was sent, and for Hermes's replies how long
 * they took, counted from the prompt. A reply in progress ticks live.
 */
export function MessageMeta({ message, active = false, elapsedFrom }: MessageMetaProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const createdMs = toMillis(message.createdAt);
  const isAssistant = message.role === 'assistant';
  const startMs = toMillis(elapsedFrom) ?? createdMs;
  const endMs = active ? now : toMillis(message.completedAt);
  const elapsed = isAssistant ? elapsedSeconds(startMs, endMs) : undefined;
  const stampMs = isAssistant ? (toMillis(message.completedAt) ?? createdMs) : createdMs;
  const time = stampMs !== undefined && !active ? formatClockTime(stampMs) : undefined;

  if (time === undefined && elapsed === undefined) return null;
  const label = active ? 'Reply in progress' : 'Sent';
  const steered = message.role === 'user' && message.displayKind === 'steer';
  return (
    <div className={`hm-message__meta hm-message__meta--${message.role}`} data-testid="message-meta" aria-label={label}>
      {steered ? <span className="hm-message__meta-note">Added to the running task · </span> : null}
      {time ? <time dateTime={new Date(stampMs ?? 0).toISOString()}>{time}</time> : null}
      {elapsed !== undefined ? (
        <span className="hm-message__elapsed" data-live={active ? 'true' : 'false'}>
          {time ? ' · ' : ''}
          {formatElapsed(elapsed)}
          {active ? '…' : ''}
        </span>
      ) : null}
    </div>
  );
}
