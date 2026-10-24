import ReactMarkdown from 'react-markdown';
import { memo } from 'react';
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

function MessageBubbleView({ message, rpc, rest, isLast, streaming, liveStatus, liveFace, pendingApprovals, activeSessionIds, elapsedFrom, onInterruptSteer }: MessageBubbleProps) {
  if (message.role === 'tool') {
    return null;
  }

  const isUser = message.role === 'user';

  if (isUser) {
    const attachments = attachmentRefs(message.text);
    const visibleText = attachments.length > 0 ? stripAttachmentRefs(message.text) : message.text;
    return (
      <div className="hm-message-group hm-message-group--user">
        {visibleText ? (
          <div className="hm-message hm-message--user" data-kind={message.displayKind ?? undefined}>
            <p>{visibleText}</p>
          </div>
        ) : null}
        <FileCards refs={attachments} rest={rest} tone="user" />
        <MessageMeta
          message={message}
          action={onInterruptSteer ? { label: 'Interrupt and send now', onClick: onInterruptSteer } : undefined}
        />
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
  const showHeaderStatus = active && Boolean(liveStatus?.trim());
  const statusFace = liveFace?.trim();

  return (
    <div className="hm-message hm-message--assistant">
      <div className="hm-message__header">
        <span className="hm-message__avatar">
          <img src="./icons/icon-192.png" alt="" aria-hidden="true" />
        </span>
        {showHeaderStatus ? (
          <span className="hm-live-status hm-live-status--inline" role="status" aria-live="polite">
            {statusFace ? <span className="hm-live-status__face" aria-hidden="true">{statusFace}</span> : null}
            <span className="hm-live-status__text">{liveStatus}</span>
            <span className="hm-live-status__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </span>
        ) : (
          <span className="hm-message__activity" aria-label={active ? 'Assistant is active' : 'Assistant response complete'}>
            {active ? (
              <span className="hm-message__activity-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            ) : (
              <span className="hm-message__activity-dot" aria-hidden="true" />
            )}
          </span>
        )}
      </div>

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

      {message.text ? (
        <div className="hm-message__text">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {message.text}
          </ReactMarkdown>
          {showCaret && <span className="hm-message__caret" />}
        </div>
      ) : null}

      {!active && <FileCards refs={extractFileRefs(message.text)} rest={rest} tone="assistant" />}
      <MessageMeta message={message} active={active} elapsedFrom={elapsedFrom} />
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleView, areMessageBubblePropsEqual);
MessageBubble.displayName = 'MessageBubble';
