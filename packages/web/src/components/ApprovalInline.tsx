import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { RpcClient, Approval, ApprovalChoice, ToolCall } from '@hermes-pwa/core';
import { useActivityStore, useChatStore } from '@hermes-pwa/core';
import { Icon } from './Icon';
import { ConfirmSheet } from './ActionSheet';
import { approvalText } from './approvalText';
import { CommandBlock } from './approvalUi';
import { isLongCommand, needsConfirmation, riskLabel, useArmedAction } from '../lib/approvalRisk';
import { firstStringField } from '../lib/toolView';

interface ApprovalInlineProps {
  rpc: RpcClient;
  /** When present, render only as the inline control for the pending tool row. */
  toolName?: string;
  tool?: ToolCall;
}

const APPROVAL_TOOLS = new Set(['terminal', 'execute_code']);


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
  const items = useActivityStore(useShallow((s) => s.items));
  const respondApproval = useActivityStore((s) => s.respondApproval);
  const activeSessionId = useChatStore((s) => s.sessionId);
  const storedSessionId = useChatStore((s) => s.storedSessionId);
  const [submitting, setSubmitting] = useState<ApprovalChoice | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
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

  return (
    <ApprovalInlineView
      key={pending.id}
      rpc={rpc}
      approval={pending}
      toolScoped={toolScoped}
      toolName={effectiveToolName}
      submitting={submitting}
      setSubmitting={setSubmitting}
      error={error}
      setError={setError}
      respondApproval={respondApproval}
    />
  );
}

interface ApprovalInlineViewProps {
  rpc: RpcClient;
  approval: Approval;
  toolScoped: boolean;
  toolName: string | undefined;
  submitting: ApprovalChoice | null;
  setSubmitting: (value: ApprovalChoice | null) => void;
  error: string | undefined;
  setError: (value: string | undefined) => void;
  respondApproval: ReturnType<typeof useActivityStore.getState>['respondApproval'];
}

function ApprovalInlineView({ rpc, approval, toolScoped, toolName, submitting, setSubmitting, error, setError, respondApproval }: ApprovalInlineViewProps) {
  const shown = approvalText(approval);
  // The gateway says which answers it accepts; a guardian-flagged command only takes once/deny.
  const offers = (choice: ApprovalChoice) => !approval.choices || approval.choices.includes(choice);
  const risk = riskLabel(approval);
  const busy = submitting !== null;

  // Allowing a pattern for longer than this one run asks once more.
  const [asking, setAsking] = useState<'session' | 'always' | undefined>(undefined);
  // A folded command is opened before anything can run it.
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandSeen, setCommandSeen] = useState(false);
  const unread = isLongCommand(shown.text) && !commandSeen;
  const showCommand = (open: boolean) => {
    setCommandOpen(open);
    if (open) setCommandSeen(true);
  };

  async function respond(choice: ApprovalChoice) {
    if (busy) return;
    setSubmitting(choice);
    setError(undefined);
    try {
      const sent = await respondApproval(
        rpc,
        approval.id,
        choice === 'deny' ? 'reject' : 'approve',
        approval.sessionId,
        choice,
      );
      if (!sent) setError(useActivityStore.getState().error ?? 'Could not reach Hermes. Check the connection and try again.');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send the answer. Try again.');
    } finally {
      // Never left on "Running…": the card goes away once answered, and a
      // failed or replayed answer gets its buttons back.
      setSubmitting(null);
    }
  }

  const approve = useArmedAction(() => void respond('once'), needsConfirmation(approval));
  const approveLabel = submitting === 'once'
    ? 'Running…'
    : approve.armed
      ? 'Tap again to run'
      : toolScoped
        ? 'Run'
        : 'Approve';

  return (
    <div className="hm-approval-inline" data-slot="tool-approval-inline" data-risk={risk.tone}>
      <div className="hm-approval-inline__header">
        <span className="hm-approval-inline__icon">
          <Icon name="shield" size={17} />
        </span>
        <span className="hm-approval-inline__title">Approval required</span>
        <span className={`hm-approval-inline__risk hm-approval-inline__risk--${risk.tone}`}>{risk.label}</span>
      </div>
      <div className="hm-approval-inline__body">
        <div className="hm-approval-inline__label">
          {toolScoped ? `${toolName ?? 'A tool'} wants to run` : `${approval.title} wants to run`}
          {approval.session ? ` · ${approval.session}` : ''}
        </div>
        {shown.text && (
          <CommandBlock text={shown.text} className="hm-approval-inline__cmd" expanded={commandOpen} onExpandedChange={showCommand} />
        )}
        {shown.incomplete && (
          <div className="hm-approval-inline__warning" role="alert">
            The command text is incomplete. Deny unless you know exactly what this is.
          </div>
        )}
        {approval.smartDenied ? (
          <div className="hm-approval-inline__warning" role="alert">
            The safety check refused this command; approving overrides it for this one run.
          </div>
        ) : null}
        {error ? <div className="hm-approval-inline__error" role="alert">{error}</div> : null}
        <div className="hm-approval-inline__actions">
          <button
            type="button"
            className="hm-approval-inline__deny"
            disabled={busy}
            onClick={() => {
              approve.disarm();
              void respond('deny');
            }}
          >
            {submitting === 'deny' ? 'Rejecting…' : toolScoped ? 'Reject' : 'Deny'}
          </button>
          <button
            type="button"
            className={`hm-approval-inline__approve${approve.armed ? ' hm-approval-inline__approve--armed' : ''}`}
            disabled={busy}
            onClick={unread ? () => showCommand(true) : approve.trigger}
            aria-label={unread ? 'Show the full command before running it' : approve.armed ? 'Confirm run' : undefined}
          >
            {unread ? 'Read command' : approveLabel}
          </button>
        </div>
        {offers('session') || offers('always') ? (
          <div className="hm-approval-inline__secondary">
            {offers('session') ? (
              <button
                type="button"
                className="hm-approval-inline__always"
                disabled={busy}
                onClick={() => (unread ? showCommand(true) : setAsking('session'))}
              >
                {submitting === 'session' ? 'Allowing…' : 'Allow for this session'}
              </button>
            ) : null}
            {offers('always') ? (
              <button
                type="button"
                className="hm-approval-inline__always hm-approval-inline__always--persistent"
                disabled={busy}
                onClick={() => (unread ? showCommand(true) : setAsking('always'))}
              >
                {submitting === 'always' ? 'Allowing…' : 'Always allow'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {asking ? (
        <ConfirmSheet
          title={asking === 'always' ? 'Always allow this?' : 'Allow for this session?'}
          message={
            asking === 'always'
              ? 'Hermes stops asking about commands like this one, in every chat, until you remove the rule on the Mac.'
              : 'Hermes stops asking about commands like this one until this chat ends.'
          }
          confirmLabel={asking === 'always' ? 'Always allow' : 'Allow for this session'}
          destructive={asking === 'always'}
          onConfirm={() => {
            void respond(asking);
          }}
          onClose={() => setAsking(undefined)}
        />
      ) : null}
    </div>
  );
}
