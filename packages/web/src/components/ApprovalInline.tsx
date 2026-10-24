import { useState } from 'react';
import type { RpcClient, Approval, ToolCall } from '@hermes-pwa/core';
import { useActivityStore, useChatStore } from '@hermes-pwa/core';
import { Icon } from './Icon';
import { approvalText } from './approvalText';
import { firstStringField } from '../lib/toolView';

interface ApprovalInlineProps {
  rpc: RpcClient;
  /** When present, render only as the inline control for the pending tool row. */
  toolName?: string;
  tool?: ToolCall;
}

const APPROVAL_TOOLS = new Set(['terminal', 'execute_code']);

type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

function riskStyle(risk: 'low' | 'medium' | 'high') {
  if (risk === 'high') return { bg: 'var(--hm-color-danger-bg)', color: 'var(--hm-color-danger-strong)', label: 'high risk' };
  if (risk === 'medium') return { bg: 'var(--hm-color-warning-bg)', color: 'var(--hm-color-warning-strong)', label: 'med risk' };
  return { bg: 'var(--hm-color-success-bg)', color: 'var(--hm-color-success-strong)', label: 'low risk' };
}

function isPendingApproval(item: { kind: string; status: string }): item is Approval {
  return item.kind === 'approval' && item.status === 'needs_you';
}

function compact(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function toolSummary(tool: ToolCall | undefined): string {
  if (!tool) return '';
  return firstStringField(tool.input, ['command', 'code', 'context', 'preview']);
}

function approvalMatchesToolSummary(item: Approval, summary: string): boolean {
  const approvalSummary = compact(item.summary);
  const tool = compact(summary);
  if (!approvalSummary || !tool) return false;
  return approvalSummary.includes(tool) || tool.includes(approvalSummary);
}

export function ApprovalInline({ rpc, toolName, tool }: ApprovalInlineProps) {
  const { items, respondApproval } = useActivityStore();
  const activeSessionId = useChatStore((s) => s.sessionId);
  const storedSessionId = useChatStore((s) => s.storedSessionId);
  const [submitting, setSubmitting] = useState<ApprovalChoice | null>(null);
  const effectiveToolName = tool?.name ?? toolName;
  const toolScoped = typeof effectiveToolName === 'string';

  if (toolScoped && !APPROVAL_TOOLS.has(effectiveToolName)) return null;

  const activeSessionIds = new Set([activeSessionId, storedSessionId].filter((value): value is string => Boolean(value)));
  const candidates = items.filter((item): item is Approval => {
    if (!isPendingApproval(item)) return false;
    if (!toolScoped) return true;

    // For recovered approvals, `sessionId` is the backend approval queue key,
    // not necessarily the chat runtime/durable session id. Only use the explicit
    // sourceSessionId for chat scoping; if it is absent, keep the approval
    // eligible and disambiguate by the tool command/summary below.
    if (!item.sourceSessionId || activeSessionIds.size === 0) return true;
    return activeSessionIds.has(item.sourceSessionId);
  });

  const summary = toolSummary(tool);
  let pending: Approval | undefined;
  if (toolScoped) {
    const sessionMatched = candidates.find((item) => {
      if (item.sourceSessionId) return activeSessionIds.has(item.sourceSessionId);
      return Boolean(item.sessionId && activeSessionIds.has(item.sessionId));
    });
    pending = summary ? candidates.find((item) => approvalMatchesToolSummary(item, summary)) ?? sessionMatched : sessionMatched;
  } else {
    pending = candidates[0];
  }

  if (!pending) return null;

  const approval = pending;
  const shown = approvalText(approval);
  const risk = approval.highImpact ? 'high' : 'low';
  const style = riskStyle(risk);
  const busy = submitting !== null;

  async function respond(choice: ApprovalChoice) {
    if (busy) return;
    if (choice === 'always') {
      const ok = window.confirm(
        'Always allow this approval pattern? This is persistent and can affect future Hermes actions.',
      );
      if (!ok) return;
    }
    if (choice === 'session') {
      const ok = window.confirm('Allow this pattern for the rest of this session without asking again?');
      if (!ok) return;
    }
    setSubmitting(choice);
    try {
      await respondApproval(
        rpc,
        approval.id,
        choice === 'deny' ? 'reject' : 'approve',
        approval.sessionId,
        choice,
      );
    } catch {
      setSubmitting(null);
    }
  }

  return (
    <div className="hm-approval-inline" data-slot="tool-approval-inline">
      <div className="hm-approval-inline__header">
        <span className="hm-approval-inline__icon">
          <Icon name="shield" size={17} />
        </span>
        <span className="hm-approval-inline__title">Approval required</span>
        <span className="hm-approval-inline__risk" style={{ background: style.bg, color: style.color }}>
          {style.label}
        </span>
      </div>
      <div className="hm-approval-inline__body">
        <div className="hm-approval-inline__label">{toolScoped ? 'Pending tool wants to run' : `${approval.title} wants to run`}</div>
        {shown.text && <pre className="hm-approval-inline__cmd">{shown.text}</pre>}
        {shown.incomplete && (
          <div className="hm-approval-inline__warning" role="alert">
            The command text is incomplete. Deny unless you know exactly what this is.
          </div>
        )}
        <div className="hm-approval-inline__actions">
          <button
            type="button"
            className="hm-approval-inline__approve"
            disabled={busy}
            onClick={() => void respond('once')}
          >
            {submitting === 'once' ? 'Running…' : toolScoped ? 'Run' : 'Approve'}
          </button>
          <button
            type="button"
            className="hm-approval-inline__deny"
            disabled={busy}
            onClick={() => void respond('deny')}
          >
            {submitting === 'deny' ? 'Rejecting…' : toolScoped ? 'Reject' : 'Deny'}
          </button>
          <button
            type="button"
            className="hm-approval-inline__always"
            disabled={busy}
            onClick={() => void respond('session')}
          >
            {submitting === 'session' ? 'Allowing…' : 'Session'}
          </button>
          <button
            type="button"
            className="hm-approval-inline__always"
            disabled={busy}
            onClick={() => void respond('always')}
          >
            {submitting === 'always' ? 'Allowing…' : 'Always'}
          </button>
        </div>
      </div>
    </div>
  );
}
