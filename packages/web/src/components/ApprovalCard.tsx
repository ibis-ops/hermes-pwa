import type { Approval } from '@hermes-pwa/core';
import { Icon } from './Icon';
import { approvalText } from './approvalText';

interface ApprovalCardProps {
  item: Approval;
  onApprove(id: string): void;
  onReject(id: string): void;
}

export function ApprovalCard({ item, onApprove, onReject }: ApprovalCardProps) {
  const isHighImpact = item.highImpact;
  const shown = approvalText(item);
  const riskLabel = isHighImpact ? 'High risk' : 'Low risk';
  const riskColor = isHighImpact ? 'var(--hm-color-danger-strong)' : 'var(--hm-color-success-strong)';
  const riskBg = isHighImpact ? 'var(--hm-color-danger-bg)' : 'var(--hm-color-success-bg)';

  return (
    <div className="hm-approval-card" data-testid="approval-card">
      <div className="hm-approval-card__header">
        <span className="hm-approval-card__shield" aria-hidden="true">
          <Icon name="shield" size={16} />
        </span>
        <span className="hm-approval-card__tool">{item.title}</span>
        <span
          className="hm-approval-card__risk"
          style={{ background: riskBg, color: riskColor }}
        >
          {riskLabel}
        </span>
      </div>

      <div className="hm-approval-card__body">
        {item.session && (
          <div className="hm-approval-card__session">{item.session}</div>
        )}
        {shown.text && (
          <pre className="hm-approval-card__cmd">{shown.text}</pre>
        )}
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
        <div className="hm-approval-card__actions">
          <button
            type="button"
            className="hm-approval-card__approve"
            onClick={() => onApprove(item.id)}
            aria-label="Approve"
          >
            Approve
          </button>
          <button
            type="button"
            className="hm-approval-card__deny"
            onClick={() => onReject(item.id)}
            aria-label="Deny"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
