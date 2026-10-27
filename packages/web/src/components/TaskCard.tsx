import type { Task } from '@hermes-pwa/core';
import { Icon } from './Icon';

interface TaskCardProps {
  task: Task;
  onClick(id: string): void;
}

function priorityBadge(priority: number | undefined) {
  const p = typeof priority === 'number' ? priority : 0;
  if (p <= 0) return null;
  let color = 'var(--hm-color-text-muted)';
  let background = 'var(--hm-color-fill)';
  if (p >= 10) {
    color = 'var(--hm-color-danger-strong)';
    background = 'var(--hm-color-danger-bg)';
  } else if (p >= 5) {
    color = 'var(--hm-color-primary)';
    background = 'var(--hm-color-primary-tint)';
  }
  return (
    <span className="hm-task-card__priority" style={{ color, background }}>
      P{p}
    </span>
  );
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  return (
    <button
      className="hm-task-card"
      onClick={() => onClick(task.id)}
      aria-label={`${task.title} · ${task.status}`}
    >
      <span className="hm-task-card__title">{task.title}</span>

      {task.latestSummary && <span className="hm-task-card__summary">{task.latestSummary}</span>}

      {task.block && (
        <span className="hm-task-card__block">
          <span aria-hidden="true">⚠</span> {task.block}
        </span>
      )}

      <span className="hm-task-card__footer">
        {priorityBadge(task.priority)}
        {task.commentCount ? (
          <span className="hm-task-card__comments">
            <Icon name="chat" size={12} />
            {task.commentCount}
          </span>
        ) : null}
        {task.assignee ? (
          <span className="hm-task-card__assignee">@{task.assignee}</span>
        ) : (
          <span className="hm-task-card__assignee hm-muted">unassigned</span>
        )}
      </span>
    </button>
  );
}
