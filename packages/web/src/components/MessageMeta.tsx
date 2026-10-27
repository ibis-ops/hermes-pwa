import { useEffect, useState } from 'react';
import type { Message } from '@hermes-pwa/core';
import { Icon } from './Icon';
import { formatClockTime, formatElapsed, toMillis } from '../lib/chatTime';

interface MessageMetaProps {
  message: Message;
  /** True while this assistant reply is still being produced. */
  active?: boolean | undefined;
  /** Epoch seconds of the prompt the reply answers. */
  elapsedFrom?: number | undefined;
  /** An inline action shown after the stamp, e.g. interrupting the turn a steered message went into. */
  action?: { label: string; onClick: () => void } | undefined;
  /** When set, a Copy control puts this text on the clipboard. */
  copyText?: string | undefined;
  /** The reply's turn was ended early (Stop, or an interrupt), not finished. */
  stopped?: boolean | undefined;
}

function elapsedSeconds(startMs: number | undefined, endMs: number | undefined): number | undefined {
  if (startMs === undefined || endMs === undefined) return undefined;
  const seconds = (endMs - startMs) / 1000;
  return seconds >= 0 ? seconds : undefined;
}

/**
 * The line under a bubble: when it was sent, for Hermes's replies how long
 * they took (counted from the prompt; a reply in progress ticks live), and a
 * Copy control. The chat shows it for the newest message and for any bubble
 * the person taps.
 */
export function MessageMeta({ message, active = false, elapsedFrom, action, copyText, stopped = false }: MessageMetaProps) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
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
  const canCopy = Boolean(copyText && copyText.trim()) && !active;
  const showStopped = stopped && isAssistant && !active;

  if (time === undefined && elapsed === undefined && !action && !canCopy && !showStopped) return null;

  async function copy() {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText.replace(/\n$/, ''));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission); the
      // text is still selectable by hand.
    }
  }

  const label = active ? 'Reply in progress' : 'Sent';
  const steered = message.role === 'user' && message.displayKind === 'steer';
  const parts: string[] = [];
  if (showStopped) parts.push('Stopped');
  if (time) parts.push(time);
  if (elapsed !== undefined) parts.push(`${formatElapsed(elapsed)}${active ? '…' : ''}`);
  return (
    <div className={`hm-message__meta hm-message__meta--${message.role}`} data-testid="message-meta" aria-label={label}>
      {steered ? <span className="hm-message__meta-note">Added to the running task · </span> : null}
      {showStopped ? (
        <span className="hm-message__meta-note hm-message__meta-note--stopped" data-testid="reply-stopped">
          Stopped{time || elapsed !== undefined ? ' · ' : ''}
        </span>
      ) : null}
      {time ? <time dateTime={new Date(stampMs ?? 0).toISOString()}>{time}</time> : null}
      {elapsed !== undefined ? (
        <span className="hm-message__elapsed" data-live={active ? 'true' : 'false'}>
          {time ? ' · ' : ''}
          {formatElapsed(elapsed)}
          {active ? '…' : ''}
        </span>
      ) : null}
      {action ? (
        <>
          {parts.length > 0 ? ' · ' : ''}
          <button type="button" className="hm-message__meta-action" onClick={action.onClick}>
            {action.label}
          </button>
        </>
      ) : null}
      {canCopy ? (
        <>
          {parts.length > 0 || action ? ' · ' : ''}
          <button type="button" className="hm-message__meta-action hm-message__copy" onClick={() => void copy()} aria-live="polite">
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}
