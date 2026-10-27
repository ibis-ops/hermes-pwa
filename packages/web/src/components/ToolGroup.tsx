import { useMemo, useState } from 'react';
import { useActivityStore, type RpcClient, type ToolCall } from '@hermes-pwa/core';
import { Icon } from './Icon';
import { ApprovalInline } from './ApprovalInline';
import { buildToolView, truncate } from '../lib/toolView';

/** Lines of tool output shown before "Show all"; a long terminal result must not swallow the chat. */
const OUTPUT_PREVIEW_LINES = 80;

function OutputBlock({ text }: { text: string }) {
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = text.split('\n');
  const capped = !showAll && lines.length > OUTPUT_PREVIEW_LINES;
  const shown = capped ? lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n') : text;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ''));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable; the text is still selectable by hand.
    }
  }

  return (
    <>
      <pre className="hm-tool-group__row-output">{shown}</pre>
      <div className="hm-tool-group__row-tools">
        {capped ? (
          <button type="button" className="hm-tool-group__row-more" onClick={() => setShowAll(true)}>
            Show all {lines.length} lines
          </button>
        ) : null}
        <button type="button" className="hm-tool-group__row-more hm-tool-group__row-copy" onClick={() => void copy()} aria-live="polite">
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
    </>
  );
}

interface ToolGroupProps {
  tools: ToolCall[];
  rpc: RpcClient;
  streaming?: boolean | undefined;
}

interface ToolRowProps {
  tool: ToolCall;
  rpc: RpcClient;
  streaming?: boolean | undefined;
  /** An approval is waiting somewhere, so a result-less approval tool may really be paused. */
  approvalsPending: boolean;
}

/** Tools Hermes pauses on for approval; only these can be "waiting" after the stream ends. */
const APPROVAL_TOOLS = new Set(['terminal', 'execute_code']);

function selectApprovalsPending(state: { items: { kind: string; status: string }[] }): boolean {
  return state.items.some((item) => item.kind === 'approval' && item.status === 'needs_you');
}

/**
 * A call with no stored result is still running only while its reply streams,
 * or while an approval for it is open (a reload clears streaming but not the
 * approval). Otherwise it finished without Hermes keeping a result row, which
 * the history projection does for some tools, and it reads as done.
 */
function isUnfinished(tool: ToolCall, streaming: boolean | undefined, approvalsPending: boolean): boolean {
  if (tool.output !== undefined) return false;
  if (streaming) return true;
  return approvalsPending && APPROVAL_TOOLS.has(tool.name);
}

function ToolRow({ tool, rpc, streaming, approvalsPending }: ToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const unfinished = isUnfinished(tool, streaming, approvalsPending);
  const settled = useMemo<ToolCall>(
    () => (unfinished || tool.output !== undefined ? tool : { ...tool, output: '' }),
    [tool, unfinished],
  );
  const view = useMemo(() => buildToolView(settled), [settled]);
  const isPendingTool = unfinished && view.status === 'running';

  return (
    <div className={`hm-tool-group__row ${isPendingTool ? 'hm-tool-group__row--running' : 'hm-tool-group__row--done'}`}>
      <button
        type="button"
        className="hm-tool-group__row-button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="hm-tool-group__row-icon">
          <Icon name={view.icon as import('./Icon').IconName} size={14} />
        </span>
        <span className="hm-tool-group__row-title">{view.title}</span>
        {view.subtitle && (
          <>
            <span className="hm-tool-group__row-dot">·</span>
            <span className="hm-tool-group__row-target">{truncate(view.subtitle, 90)}</span>
          </>
        )}
        {isPendingTool && <span className="hm-tool-group__row-running" aria-label="running" />}
        {view.countLabel && <span className="hm-tool-group__row-count">{view.countLabel}</span>}
      </button>

      {expanded && view.detail && (
        <div className="hm-tool-group__row-detail">
          {view.detailLabel && <div className="hm-tool-group__row-detail-label">{view.detailLabel}</div>}
          <OutputBlock text={view.detail} />
        </div>
      )}
      {isPendingTool && <ApprovalInline rpc={rpc} tool={tool} />}
    </div>
  );
}

export function ToolGroup({ tools, rpc, streaming }: ToolGroupProps) {
  const approvalsPending = useActivityStore(selectApprovalsPending);
  // The pulsing dot means "still working". It follows the turn (or an open
  // approval), not the presence of a result row, so it stops when the reply does.
  const runningCount = tools.filter((t) => isUnfinished(t, streaming, approvalsPending)).length;
  const stateLabel = runningCount > 0 ? 'running' : 'done';

  return (
    <div className="hm-tool-group">
      <div className="hm-tool-group__header">
        <span className="hm-tool-group__header-icon" aria-hidden="true">
          <Icon name="terminal" size={12} />
        </span>
        <span className="hm-tool-group__header-title hm-sr-only">Tool actions</span>
        <span className="hm-tool-group__header-meta">
          {tools.length} {tools.length === 1 ? 'step' : 'steps'} · {stateLabel}
        </span>
        {runningCount > 0 && <span className="hm-tool-group__header-running" aria-label="running" />}
      </div>
      {tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} rpc={rpc} streaming={streaming} approvalsPending={approvalsPending} />
      ))}
    </div>
  );
}
