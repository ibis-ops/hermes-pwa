import { useState } from 'react';
import type { Approval } from '@hermes-pwa/core';
import { Icon } from './Icon';
import { approvalText } from './approvalText';
import { CommandBlock } from './approvalUi';
import { needsConfirmation, riskLabel, useArmedAction } from '../lib/approvalRisk';

interface ApprovalCardProps {
  item: Approval;
  onApprove(id: string): void | Promise<void>;
  onReject(id: string): void | Promise<void>;
}

/**
 * One approval on the Approvals screen: the command exactly as it will run,
 * Deny on the left as the quiet choice, Approve on the right. A command the
 * safety check refused takes two taps to approve.
 */
export function ApprovalCard({ item, onApprove, onReject }: ApprovalCardProps) {
  const shown = approvalText(item);
  const risk = riskLabel(item);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  async function run(kind: 'approve' | 'deny') {
    if (busy) return;
    setBusy(kind);
    setError(undefined);
    try {
      await (kind === 'approve' ? onApprove(item.id) : onReject(item.id));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send the answer. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const approve = useArmedAction(() => void run('approve'), needsConfirmation(item));

  return (
    <div className="hm-approval-card" data-testid="approval-card" data-risk={risk.tone}>
      <div className="hm-approval-card__header">
        <span className="hm-approval-card__shield" aria-hidden="true">
          <Icon name="shield" size={16} />
        </span>
        <span className="hm-approval-card__tool">{item.title}</span>
        <span className={`hm-approval-card__risk hm-approval-card__risk--${risk.tone}`}>{risk.label}</span>
      </div>

      <div className="hm-approval-card__body">
        {item.session && (
          <div className="hm-approval-card__session">{item.session}</div>
        )}
        {shown.text && <CommandBlock text={shown.text} className="hm-approval-card__cmd" />}
        {shown.incomplete && (
          <div className="hm-approval-card__warning" role="alert">
            The command text is incomplete. Deny unless you know exactly what this is.
          </div>
        )}
        {item.smartDenied ? (
          <div className="hm-approval-card__warning" role="alert">
            The safety check refused this command; approving overrides it for this one run.
          </div>
        ) : null}
        {error ? (
          <div className="hm-approval-card__error" role="alert">{error}</div>
        ) : null}
        <div className="hm-approval-card__actions">
          <button
            type="button"
            className="hm-approval-card__deny"
            onClick={() => {
              approve.disarm();
              void run('deny');
            }}
            disabled={busy !== null}
            aria-label="Deny"
          >
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button
            type="button"
            className={`hm-approval-card__approve${approve.armed ? ' hm-approval-card__approve--armed' : ''}`}
            onClick={approve.trigger}
            disabled={busy !== null}
            aria-label={approve.armed ? 'Confirm approve' : 'Approve'}
          >
            {busy === 'approve' ? 'Approving…' : approve.armed ? 'Tap again to confirm' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
