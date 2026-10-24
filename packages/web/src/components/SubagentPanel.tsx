import { useEffect, useMemo, useState } from 'react';
import { useSpawnStore, type SpawnedAgent } from '@hermes-pwa/core';
import { formatClockTime, formatElapsed } from '../lib/chatTime';

interface SubagentPanelProps {
  /** Epoch seconds of the turn's prompt; agents started before it belong to an earlier turn. */
  since: number | undefined;
}

const ACTIVE = new Set(['running', 'queued']);

function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
}

function elapsedFor(agent: SpawnedAgent, nowMs: number): number {
  if (ACTIVE.has(agent.status)) return (nowMs - agent.startedAt) / 1000;
  if (agent.durationSeconds !== undefined) return agent.durationSeconds;
  return Math.max(0, (agent.updatedAt - agent.startedAt) / 1000);
}

function statusLabel(agent: SpawnedAgent): string {
  switch (agent.status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Working';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Stopped';
    default:
      return agent.status;
  }
}

/**
 * Delegated agents for the current turn, inside the reply that spawned them:
 * which model, what each was asked to do, what it is doing now, and how long
 * it has been at it (live while running, final once done).
 */
export function SubagentPanel({ since }: SubagentPanelProps) {
  const agents = useSpawnStore((s) => s.agents);
  const sinceMs = since !== undefined ? (since > 1_000_000_000_000 ? since : since * 1000) - 5_000 : undefined;
  const turnAgents = useMemo(
    () => agents.filter((agent) => sinceMs === undefined || agent.startedAt >= sinceMs),
    [agents, sinceMs],
  );
  const anyActive = turnAgents.some((agent) => ACTIVE.has(agent.status));
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!anyActive) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyActive]);

  if (turnAgents.length === 0) return null;
  const activeCount = turnAgents.filter((agent) => ACTIVE.has(agent.status)).length;

  return (
    <div className="hm-subagents" data-testid="subagent-panel">
      <div className="hm-subagents__header">
        <span className="hm-subagents__title">{turnAgents.length === 1 ? 'Subagent' : `${turnAgents.length} subagents`}</span>
        <span className="hm-subagents__meta">{activeCount > 0 ? `${activeCount} working` : 'all done'}</span>
      </div>
      {turnAgents.map((agent) => {
        const active = ACTIVE.has(agent.status);
        const latest = agent.stream.at(-1);
        const model = shortModel(agent.model);
        const who = [model ?? 'agent', agent.taskCount > 1 ? `${agent.taskIndex + 1}/${agent.taskCount}` : ''].filter(Boolean).join(' · ');
        return (
          <div key={agent.id} className={`hm-subagent hm-subagent--${agent.status}`} data-testid="subagent-row" data-status={agent.status}>
            <span className="hm-subagent__dot" aria-hidden="true" />
            <div className="hm-subagent__body">
              <div className="hm-subagent__line">
                <span className="hm-subagent__who">{who}</span>
                <span className="hm-subagent__elapsed" data-live={active ? 'true' : 'false'}>
                  {formatElapsed(elapsedFor(agent, nowMs))}
                  {active ? '…' : ''}
                </span>
              </div>
              <div className="hm-subagent__goal">{agent.goal}</div>
              <div className="hm-subagent__status">
                {statusLabel(agent)}
                {' · started '}
                {formatClockTime(agent.startedAt)}
                {latest && (active || latest.kind === 'summary') ? (
                  <span className={`hm-subagent__now ${latest.isError ? 'hm-subagent__now--error' : ''}`}>
                    {' · '}
                    {latest.text}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
