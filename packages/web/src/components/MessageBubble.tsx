import ReactMarkdown from 'react-markdown';
import { memo, useState } from 'react';
import { attachmentRefs, extractFileRefs, stripAttachmentRefs, type Approval, type Message, type ToolCall } from '@hermes-pwa/core';
import { FileCards } from './FileCards';
import { ToolGroup } from './ToolGroup';
import { TodoPanel } from './TodoPanel';
import { ThinkingDisclosure } from './ThinkingDisclosure';
import { MessageMeta } from './MessageMeta';
import { SubagentPanel } from './SubagentPanel';
import { MARKDOWN_COMPONENTS, REHYPE_PLUGINS, REMARK_PLUGINS, areMessageBubblePropsEqual, type MessageBubbleProps } from './MessageBubble.helpers';

const APPROVAL_TOOL_NAMES = new Set(['terminal', 'execute_code']);
const APPROVAL_INLINE_TIME_WINDOW_MS = 5 * 60_000;

function toMillis(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : value;
}

function firstApprovalLine(summary: string | undefined): string {
  return (summary ?? '').split(/\r?\n/u).find((line) => line.trim())?.trim() ?? '';
}

function approvalBelongsToActiveChat(approval: Approval, activeSessionIds: Set<string>): boolean {
  if (activeSessionIds.size === 0) return false;
  if (approval.sourceSessionId) return activeSessionIds.has(approval.sourceSessionId);
  return Boolean(approval.sessionId && activeSessionIds.has(approval.sessionId));
}

function approvalNearMessage(approval: Approval, message: Message): boolean {
  const approvalTime = toMillis(approval.createdAt);
  const messageTime = toMillis(message.createdAt);
  return Boolean(
    approvalTime !== undefined &&
    messageTime !== undefined &&
    Math.abs(approvalTime - messageTime) <= APPROVAL_INLINE_TIME_WINDOW_MS,
  );
}

function recoveredApprovalTool(
  message: Message,
  isLast: boolean | undefined,
  pendingApprovals: Approval[] | undefined,
  activeSessionIds: string[] | undefined,
): ToolCall | undefined {
  if (message.role !== 'assistant' || isLast === false) return undefined;
  const pendingApprovalTools = message.toolCalls?.filter(
    (tool) => tool.output === undefined && APPROVAL_TOOL_NAMES.has(tool.name),
  ) ?? [];
  if (pendingApprovalTools.length > 0) return undefined;

  const approvals = pendingApprovals ?? [];
  if (approvals.length === 0) return undefined;
  const activeSessionIdSet = new Set(activeSessionIds ?? []);

  const scoped = approvals.find((approval) => approvalBelongsToActiveChat(approval, activeSessionIdSet));
  const timeScoped = approvals.find((approval) => approvalNearMessage(approval, message));
  const singleApproval = approvals.length === 1 ? approvals[0] : undefined;
  const fallback = singleApproval && !singleApproval.sourceSessionId ? singleApproval : undefined;
  const approval = scoped ?? timeScoped ?? fallback;
  const command = firstApprovalLine(approval?.summary);
  if (!approval || !command) return undefined;
  return {
    id: `recovered-${approval.id}`,
    name: 'terminal',
    input: { command },
  };
}

/**
 * One row of the conversation, laid out like Messages: the person's text in a
 * blue bubble on the right, Hermes's reply in a grey bubble on the left, no
 * avatars and no names. The time of a message stays out of the way until the
 * bubble is tapped; the newest message always shows it.
 */
function MessageBubbleView({
  message,
  rpc,
  rest,
  isLast,
  streaming,
  liveStatus,
  pendingApprovals,
  activeSessionIds,
  elapsedFrom,
  onInterruptSteer,
  stopped,
  readAloudStatus = 'idle',
  readAloudError,
  onReadAloud,
}: MessageBubbleProps) {
  // Tapping a bubble reveals its time stamp, as a swipe does in Messages.
  const [revealed, setRevealed] = useState(false);
  const toggleRevealed = () => setRevealed((value) => !value);

  if (message.role === 'tool') {
    return null;
  }

  const isUser = message.role === 'user';
  const showMeta = revealed || isLast !== false;

  if (isUser) {
    const attachments = attachmentRefs(message.text);
    const visibleText = attachments.length > 0 ? stripAttachmentRefs(message.text) : message.text;
    return (
      <div className="hm-message-group hm-message-group--user" data-revealed={revealed ? 'true' : 'false'}>
        {visibleText ? (
          <div className="hm-message hm-message--user" data-kind={message.displayKind ?? undefined} onClick={toggleRevealed}>
            <p>{visibleText}</p>
          </div>
        ) : null}
        <FileCards refs={attachments} rest={rest} tone="user" />
        <div className="hm-message__meta-reveal" data-collapsed={showMeta || onInterruptSteer ? 'false' : 'true'}>
          <MessageMeta
            message={message}
            action={onInterruptSteer ? { label: 'Interrupt and send now', onClick: onInterruptSteer } : undefined}
          />
        </div>
      </div>
    );
  }

  const active = Boolean(streaming && isLast !== false);
  const showCaret = active && message.role === 'assistant';
  const completedTodoTool = message.toolCalls?.filter((t) => t.name === 'todo' && typeof t.output === 'string').at(-1);
  const recoveredTool = recoveredApprovalTool(message, isLast, pendingApprovals, activeSessionIds);
  const otherTools = [
    ...(message.toolCalls?.filter((t) => t.name !== 'todo') ?? []),
    ...(recoveredTool ? [recoveredTool] : []),
  ];
  // Delegated agents belong to the latest reply; the panel hides itself when
  // the spawn store holds nothing for this turn.
  const showSubagents = isLast !== false;
  const hasActions = Boolean(message.thinking?.trim()) || Boolean(completedTodoTool) || otherTools.length > 0;
  const status = active ? liveStatus?.trim() ?? '' : '';
  const hasText = message.text.trim().length > 0;

  return (
    <div className="hm-message hm-message--assistant" data-active={active ? 'true' : 'false'} data-revealed={revealed ? 'true' : 'false'}>
      {hasActions && (
        <div className="hm-message__actions">
          {message.thinking && message.thinking.trim().length > 0 && (
            <ThinkingDisclosure text={message.thinking} streaming={active} />
          )}

          {completedTodoTool && (
            <div className="hm-message__todos">
              <TodoPanel tool={completedTodoTool} />
            </div>
          )}

          {otherTools.length > 0 && <ToolGroup tools={otherTools} rpc={rpc} streaming={active} />}
        </div>
      )}

      {showSubagents ? <SubagentPanel since={elapsedFrom ?? message.createdAt} /> : null}

      {hasText ? (
        <div className="hm-message__text" onClick={toggleRevealed}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {message.text}
          </ReactMarkdown>
          {showCaret && <span className="hm-message__caret" />}
        </div>
      ) : active ? (
        <div className="hm-message__typing" role="img" aria-label="Hermes is typing" data-testid="typing-indicator">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {status ? (
        <div className="hm-live-status" role="status" aria-live="polite" data-testid="live-status">
          <span className="hm-live-status__text">{status}</span>
        </div>
      ) : null}

      {!active && <FileCards refs={extractFileRefs(message.text)} rest={rest} tone="assistant" />}
      {/* Older bubbles keep their time, Copy and Listen in the page, out of
          sight until tapped or reached with the keyboard (screen readers
          always hear it). A reply being read keeps its Stop in view. */}
      <div
        className="hm-message__meta-reveal"
        data-collapsed={showMeta || active || readAloudStatus !== 'idle' || readAloudError ? 'false' : 'true'}
      >
        <MessageMeta
          message={message}
          active={active}
          elapsedFrom={elapsedFrom}
          copyText={hasText ? message.text : undefined}
          stopped={stopped}
          readAloud={
            hasText && onReadAloud
              ? { status: readAloudStatus, error: readAloudError, onToggle: () => onReadAloud(message.id, message.text) }
              : undefined
          }
        />
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleView, areMessageBubblePropsEqual);
MessageBubble.displayName = 'MessageBubble';
