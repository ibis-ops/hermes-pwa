import { useEffect, useState } from 'react';
import {
  projectHistoryMessages,
  sessionSourceId,
  sessionSourceLabel,
  type Message,
  type RestClient,
  type RpcClient,
  type Session,
} from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { MessageBubble } from './MessageBubble';
import { formatDividerTime, needsTimeDivider, toMillis } from '../lib/chatTime';

interface SessionTranscriptProps {
  session: Session;
  rpc: RpcClient;
  rest: RestClient;
  onClose: () => void;
}

function promptTimeBefore(messages: Message[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role === 'user') return candidate.createdAt;
  }
  return undefined;
}

/**
 * A session the phone can read but not continue (Signal, scheduled job,
 * delegated bot run): its transcript straight from the Mac, no composer.
 */
export function SessionTranscript({ session, rpc, rest, onClose }: SessionTranscriptProps) {
  const [messages, setMessages] = useState<Message[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setMessages(undefined);
    setError(undefined);
    rest
      .sessionMessages(session.id, session.profile)
      .then((raw) => {
        if (!cancelled) setMessages(projectHistoryMessages(raw));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : 'Could not load this session.');
      });
    return () => {
      cancelled = true;
    };
  }, [rest, session.id, session.profile]);

  const source = sessionSourceId(session);
  const sourceLabel = sessionSourceLabel(source) ?? 'Session';
  const bot = session.profileName && session.profileName !== session.profile ? session.profileName : undefined;
  const meta = [sourceLabel, bot ? `bot: ${bot}` : session.profile, session.messageCount != null ? `${session.messageCount} msgs` : undefined]
    .filter(Boolean)
    .join(' · ');

  return (
    <BottomSheet
      title={session.title?.trim() || 'Untitled'}
      onClose={onClose}
      className="hm-sheet--transcript"
      contentClassName="hm-transcript"
      meta={<p className="hm-transcript__meta hm-muted">{meta}</p>}
      footer={
        <p className="hm-transcript__hint hm-muted">
          Read-only. {source === 'cron' ? 'A scheduled job runs only its job.' : source === 'subagent' ? 'A delegated run belongs to the chat that asked for it.' : 'This conversation lives on its own platform.'} Start a new chat to ask about it.
        </p>
      }
    >
      {error ? <div className="hm-warning-banner hm-warning-banner--error">{error}</div> : null}
      {messages === undefined && !error ? <p className="hm-muted hm-loading">Loading…</p> : null}
      {messages && messages.length === 0 ? <p className="hm-muted hm-transcript__empty">Nothing recorded in this session.</p> : null}
      {messages ? (
        <div className="hm-transcript__list" data-testid="transcript">
          {messages.map((m, index) => {
            const at = toMillis(m.createdAt);
            const previousAt = index > 0 ? toMillis(messages[index - 1]?.createdAt) : undefined;
            const divider = needsTimeDivider(previousAt, at) && at !== undefined ? formatDividerTime(at) : undefined;
            return (
              <div key={m.id} className="hm-chat__entry">
                {divider ? (
                  <div className="hm-chat__time" role="separator" aria-label={divider}>
                    {divider}
                  </div>
                ) : null}
                <MessageBubble
                  message={m}
                  rpc={rpc}
                  rest={rest}
                  isLast={false}
                  streaming={false}
                  liveStatus=""
                  pendingApprovals={[]}
                  activeSessionIds={[]}
                  elapsedFrom={m.role === 'assistant' ? promptTimeBefore(messages, index) : undefined}
                  onInterruptSteer={undefined}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </BottomSheet>
  );
}
