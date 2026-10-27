import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  groupRunsByDay,
  useSpawnStore,
  useChatStore,
  type AgentHistory,
  type AgentRun,
  type RestClient,
  type RpcClient,
  type SpawnNode,
  type SpawnStatus,
} from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { MARKDOWN_COMPONENTS, REHYPE_PLUGINS, REMARK_PLUGINS } from '../components/MessageBubble.helpers';
import { formatClockTime, formatDayLabel, formatElapsed } from '../lib/chatTime';
import { SkeletonRows } from '../components/Skeleton';

interface AgentsProps {
  rpc: RpcClient;
  rest?: RestClient | undefined;
}

const HISTORY_DAYS = 30;
const HISTORY_REFRESH_MS = 30_000;


function fmtDuration(s: number | undefined): string {
  if (!s || s <= 0) return '';
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem > 0 ? ` ${rem}s` : ''}`;
}

function fmtTokens(n: number | undefined): string {
  if (!n) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

function fmtAge(updatedAt: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - updatedAt) / 1000));
  if (s < 2) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function StatusDot({ status }: { status: SpawnStatus }) {
  const color =
    status === 'running' || status === 'queued'
      ? 'var(--hm-color-running)'
      : status === 'completed'
        ? 'var(--hm-color-success)'
        : 'var(--hm-color-danger)';
  const isActive = status === 'running' || status === 'queued';
  return (
    <span
      className="hm-spawn-dot"
      style={{
        background: color,
        animation: isActive ? 'hm-pulse 1.6s infinite' : undefined,
      }}
      aria-label={status}
    />
  );
}

function StreamLine({ text, kind, isError }: { text: string; kind: string; isError?: boolean }) {
  const isMono = kind === 'tool';
  return (
    <div className={`hm-spawn-stream-line${isError ? ' hm-spawn-stream-line--error' : ''}`}>
      <span className="hm-spawn-stream-glyph" aria-hidden="true">
        {kind === 'tool' ? '·' : kind === 'summary' ? '✓' : kind === 'thinking' ? '…' : '›'}
      </span>
      <span className={isMono ? 'hm-mono hm-spawn-stream-text' : 'hm-spawn-stream-text'}>{text}</span>
    </div>
  );
}

function SpawnRow({ node, depth = 0, nowMs }: { node: SpawnNode; depth?: number; nowMs: number }) {
  const running = node.status === 'running' || node.status === 'queued';
  const [open, setOpen] = useState(() => running || depth < 2);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const tokens = (node.inputTokens ?? 0) + (node.outputTokens ?? 0);
  const meta = [
    node.model,
    fmtDuration(node.durationSeconds),
    fmtTokens(tokens),
    node.costUsd ? `$${node.costUsd.toFixed(2)}` : '',
    fmtAge(node.updatedAt, nowMs),
  ].filter(Boolean);

  const visibleStream = open ? node.stream.slice(-8) : node.stream.slice(-1);

  return (
    <div className={`hm-spawn-row${depth > 0 ? ' hm-spawn-row--child' : ''}`} data-testid="spawn-row">
      <button className="hm-spawn-row__header" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <StatusDot status={node.status} />
        <span className={`hm-spawn-row__goal${running ? ' hm-spawn-row__goal--active' : ''}`}>{node.goal}</span>
        <span className="hm-spawn-row__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {meta.length > 0 && <p className="hm-spawn-row__meta">{meta.join(' · ')}</p>}

      {open && visibleStream.length > 0 && (
        <div className="hm-spawn-stream">
          {visibleStream.map((entry, i) => (
            <StreamLine key={`${entry.kind}:${entry.at}:${i}`} {...entry} />
          ))}
        </div>
      )}

      {open && (node.filesWritten.length > 0 || node.filesRead.length > 0) && (
        <div className="hm-spawn-files">
          {node.filesWritten.slice(0, 4).map((f) => (
            <span key={f} className="hm-spawn-files__line hm-mono">
              + {f}
            </span>
          ))}
          {node.filesRead.slice(0, 4).map((f) => (
            <span key={f} className="hm-spawn-files__line hm-mono">
              · {f}
            </span>
          ))}
        </div>
      )}

      {node.children.length > 0 && open && (
        <div className="hm-spawn-children">
          {node.children.map((child) => (
            <SpawnRow key={child.id} node={child} depth={depth + 1} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}

function runStatusLabel(run: AgentRun): string {
  switch (run.status) {
    case 'running':
      return 'Working';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Stopped';
    default:
      return 'Unknown';
  }
}

function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
}

function RunRow({ run, nowMs }: { run: AgentRun; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const live = run.status === 'running';
  const elapsed = live ? (nowMs - run.startedAt) / 1000 : run.durationSeconds;
  const tokens = run.inputTokens + run.outputTokens;
  const meta = [
    shortModel(run.model),
    elapsed !== undefined ? formatElapsed(elapsed) + (live ? '…' : '') : '',
    run.toolCallCount > 0 ? `${run.toolCallCount} tool${run.toolCallCount === 1 ? '' : 's'}` : '',
    tokens > 0 ? fmtTokens(tokens) : '',
    run.costUsd ? `$${run.costUsd.toFixed(2)}` : '',
  ].filter(Boolean);
  return (
    <div className={`hm-run hm-run--${run.status}`} data-testid="agent-run" data-status={run.status}>
      <button type="button" className="hm-run__row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="hm-run__dot" aria-hidden="true" />
        <span className="hm-run__body">
          <span className="hm-run__line">
            <span className="hm-run__bot">{run.bot}</span>
            <span className="hm-run__time hm-muted">{formatClockTime(run.startedAt)}</span>
          </span>
          <span className="hm-run__goal">{run.goal}</span>
          <span className="hm-run__meta hm-muted">
            {runStatusLabel(run)}
            {meta.length ? ` · ${meta.join(' · ')}` : ''}
          </span>
        </span>
        <span className="hm-run__chevron" aria-hidden="true">
          <Icon name="chevD" size={14} />
        </span>
      </button>
      {open ? (
        <div className="hm-run__detail">
          {run.parent ? (
            <p className="hm-run__parent hm-muted">
              Asked by {run.parent.title ? `“${run.parent.title}”` : 'a chat'}
              {run.parent.profile && run.parent.profile !== run.bot ? ` (${run.parent.profile})` : ''}
            </p>
          ) : null}
          {run.result ? (
            <div className="hm-message__text hm-run__result" data-testid="agent-run-result">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
                {run.result}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="hm-muted">{live ? run.lastActivity ?? 'Still working.' : 'No answer was recorded for this run.'}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Agents({ rpc, rest }: AgentsProps) {
  const { tree, agents } = useSpawnStore();
  const sessionId = useChatStore((s) => s.sessionId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [history, setHistory] = useState<AgentHistory | undefined>(undefined);
  const [historyError, setHistoryError] = useState<string | undefined>(undefined);

  const loadHistory = useCallback(async () => {
    if (!rest) return;
    try {
      setHistory(await rest.agentHistory(HISTORY_DAYS));
      setHistoryError(undefined);
      setNowMs(Date.now());
    } catch (err) {
      setHistoryError(err instanceof Error && err.message ? err.message : 'Could not load the agent history.');
    }
  }, [rest]);

  useEffect(() => {
    if (!rest) return undefined;
    void loadHistory();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadHistory();
    }, HISTORY_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadHistory();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [rest, loadHistory]);

  // The shell feeds the spawn store from the live events; this screen only
  // renders it. A session switch while open still binds the store here.
  useEffect(() => {
    if (sessionId) useSpawnStore.getState().setSession(sessionId);
  }, [sessionId]);
  void rpc;

  const historyRuns = useMemo(() => history?.runs ?? [], [history]);
  const anyRunLive = historyRuns.some((run) => run.status === 'running');
  const hasActive = agents.some((a) => a.status === 'running' || a.status === 'queued') || anyRunLive;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [hasActive]);
  const dayGroups = useMemo(() => groupRunsByDay(historyRuns), [historyRuns]);

  const active = agents.filter((a) => a.status === 'running' || a.status === 'queued').length;
  const failed = agents.filter((a) => a.status === 'failed' || a.status === 'interrupted').length;
  const totalTokens = agents.reduce((s, a) => s + (a.inputTokens ?? 0) + (a.outputTokens ?? 0), 0);
  const totalCost = agents.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  const summary = [
    agents.length > 0 ? `${agents.length} agent${agents.length !== 1 ? 's' : ''}` : '',
    active > 0 ? `${active} active` : '',
    failed > 0 ? `${failed} failed` : '',
    totalTokens > 0 ? fmtTokens(totalTokens) : '',
    totalCost > 0 ? `$${totalCost.toFixed(2)}` : '',
  ].filter(Boolean);

  const historySection = rest ? (
    <section className="hm-run-history" data-testid="agent-history">
      <h3 className="hm-run-history__title">
        History
        {history ? <span className="hm-run-history__count hm-muted">{history.total}</span> : null}
      </h3>
      {historyError ? <div className="hm-warning-banner hm-warning-banner--error">{historyError}</div> : null}
      {history === undefined && !historyError ? <SkeletonRows rows={5} label="Loading agent history" /> : null}
      {history && dayGroups.length === 0 ? (
        <p className="hm-run-history__empty hm-muted">No bot has been delegated to in the last {HISTORY_DAYS} days.</p>
      ) : null}
      {dayGroups.map((group) => (
        <div key={group.day} className="hm-run-history__day" data-testid="agent-history-day">
          <h4 className="hm-run-history__day-title">
            {formatDayLabel(group.day, nowMs)}
            <span className="hm-muted">{group.runs.length}</span>
          </h4>
          <div className="hm-run-history__list">
            {group.runs.map((run) => (
              <RunRow key={`${run.ownerProfile}/${run.id}`} run={run} nowMs={nowMs} />
            ))}
          </div>
        </div>
      ))}
    </section>
  ) : null;

  if (tree.length === 0) {
    return (
      <div className="hm-agents-screen hm-scroll">
        <div className="hm-empty-state hm-empty-state--compact" data-testid="agents-empty">
          <span style={{ fontSize: 36 }} aria-hidden="true">
            ✦
          </span>
          <p className="hm-body-semibold">No active agents</p>
          <p className="hm-muted">Subagents show here live while a chat delegates work. Past runs stay in the history below.</p>
        </div>
        {historySection}
      </div>
    );
  }

  return (
    <div className="hm-agents-screen hm-scroll">
      <div className="hm-spawn-tree">
        {summary.length > 0 && <p className="hm-spawn-tree__summary">{summary.join(' · ')}</p>}
        <div className="hm-spawn-tree__list">
          {tree.map((node) => (
            <SpawnRow key={node.id} node={node} depth={0} nowMs={nowMs} />
          ))}
        </div>
      </div>
      {historySection}
    </div>
  );
}
