import { useShallow } from 'zustand/react/shallow';
import { useActivityStore, useConnectionStore } from '@hermes-pwa/core';
import type { ActionItem, Approval, Clarify, RpcClient } from '@hermes-pwa/core';
import { ApprovalCard } from '../components/ApprovalCard';
import { ClarifyCard } from '../components/ClarifyCard';
import { SkeletonRows } from '../components/Skeleton';

interface ActivityProps {
  rpc: RpcClient;
}

function isApproval(item: ActionItem): item is Approval {
  return item.kind === 'approval';
}

function isClarify(item: ActionItem): item is Clarify {
  return item.kind === 'clarify';
}

export function Activity({ rpc }: ActivityProps) {
  const items = useActivityStore((s) => s.items);
  const loading = useActivityStore((s) => s.loading);
  const error = useActivityStore((s) => s.error);
  const respondApproval = useActivityStore((s) => s.respondApproval);
  const respondClarify = useActivityStore((s) => s.respondClarify);
  const connection = useConnectionStore(useShallow((s) => ({ state: s.state, error: s.error })));

  if (connection.state === 'init' || connection.state === 'login' || connection.state === 'offline') {
    return (
      <div className="hm-empty-state">
        <p>Connecting to Hermes…</p>
        <p className="hm-muted">{connection.error ?? 'Please wait.'}</p>
      </div>
    );
  }

  return (
    <div className="hm-activity">
      <p className="hm-activity__lead">
        Actions Hermes paused on. Approve or deny them here, or reply in the chat.
      </p>

      {error && <div className="hm-warning-banner hm-warning-banner--error">{error}</div>}

      {loading && items.length === 0 && <SkeletonRows rows={3} kind="cards" label="Loading approvals" />}

      {items.length === 0 && !loading ? (
        <div className="hm-empty-state">
          <div className="hm-empty-state__icon">
            <span>✓</span>
          </div>
          <p>All clear</p>
          <p className="hm-muted">No actions waiting on you.</p>
        </div>
      ) : (
        <div className="hm-activity__list">
          {items.map((item) => (
            <div key={item.id} className="hm-activity__item">
              {isApproval(item) && (
                <ApprovalCard
                  item={item}
                  onApprove={(id) => void respondApproval(rpc, id, 'approve', item.sessionId)}
                  onReject={(id) => void respondApproval(rpc, id, 'reject', item.sessionId)}
                />
              )}
              {isClarify(item) && (
                <ClarifyCard
                  item={item}
                  onRespond={(id, answer) => void respondClarify(rpc, id, answer)}
                />
              )}
              {!isApproval(item) && !isClarify(item) && (
                <div className="hm-card">
                  <h3 className="hm-card__title">{item.title}</h3>
                  {item.summary && <p className="hm-muted">{item.summary}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
