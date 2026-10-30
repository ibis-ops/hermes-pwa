import { useEffect, useMemo, useState } from 'react';
import { useProjectsStore, useConnectionStore, useProfilesStore } from '@hermes-pwa/core';
import type { RestClient, TaskStatus } from '@hermes-pwa/core';
import { TaskCard } from '../components/TaskCard';
import { Icon } from '../components/Icon';
import { BottomSheet } from '../components/BottomSheet';
import { SkeletonRows } from '../components/Skeleton';

interface ProjectsProps {
  rest: RestClient;
}

const COLUMNS: TaskStatus[] = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
];

const COLUMN_LABEL: Record<TaskStatus, string> = {
  triage: 'Triage',
  todo: 'To do',
  scheduled: 'Scheduled',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  archived: 'Archived',
  backlog: 'Backlog',
  in_progress: 'In Progress',
};

const COLUMN_TINT: Record<TaskStatus, string> = {
  triage: 'var(--hm-color-text-muted)',
  todo: 'var(--hm-color-primary)',
  scheduled: 'var(--hm-color-purple)',
  ready: 'var(--hm-color-primary)',
  running: 'var(--hm-color-success)',
  blocked: 'var(--hm-color-danger)',
  review: 'var(--hm-color-warning)',
  done: 'var(--hm-color-success)',
  archived: 'var(--hm-color-text-faint)',
  backlog: 'var(--hm-color-text-faint)',
  in_progress: 'var(--hm-color-primary)',
};

const MOVE_STATUSES: TaskStatus[] = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
];

function formatTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** A bot is running the card now (`in_progress` is the legacy name). */
function isRunning(status: TaskStatus): boolean {
  return status === 'running' || status === 'in_progress';
}

export function Projects({ rest }: ProjectsProps) {
  const {
    boards,
    activeBoardSlug,
    tasks,
    loading,
    error,
    selectedTask,
    selectedTaskComments,
    loadBoards,
    setActiveBoard,
    createBoard,
    loadTaskDetail,
    createTask,
    moveTask,
    assignTask,
    addComment,
    clearSelectedTask,
  } = useProjectsStore();
  const connection = useConnectionStore();
  const profiles = useProfilesStore((s) => s.profiles);

  const [selectorOpen, setSelectorOpen] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [createForm, setCreateForm] = useState<{
    open: boolean;
    column: TaskStatus | null;
    title: string;
    body: string;
    assignee: string;
    priority: string;
    skills: string;
    goalMode: boolean;
    goalMaxTurns: string;
    workspaceKind: 'scratch' | 'dir';
    workspacePath: string;
    parentId: string;
    tenant: string;
    maxRuntimeSeconds: string;
  }>({
    open: false,
    column: null,
    title: '',
    body: '',
    assignee: '',
    priority: '0',
    skills: '',
    goalMode: false,
    goalMaxTurns: '',
    workspaceKind: 'scratch',
    workspacePath: '',
    parentId: '',
    tenant: '',
    maxRuntimeSeconds: '',
  });

  useEffect(() => {
    if (connection.state === 'connected') {
      void loadBoards(rest);
    }
  }, [connection.state, rest, loadBoards]);

  const activeBoard = useMemo(
    () => boards?.find((b) => b.slug === activeBoardSlug),
    [boards, activeBoardSlug],
  );

  const columns = useMemo(() => {
    return COLUMNS.map((status) => ({
      status,
      label: COLUMN_LABEL[status],
      tint: COLUMN_TINT[status],
      tasks: tasks.filter((t) => t.status === status),
    }));
  }, [tasks]);

  const assigneeOptions = useMemo(
    () => profiles.map((p) => ({ value: p.name, label: p.displayName ?? p.name })),
    [profiles],
  );

  if (connection.state === 'init' || connection.state === 'login' || connection.state === 'offline') {
    return (
      <div className="hm-empty-state">
        <p>Connecting to Hermes…</p>
        <p className="hm-muted">{connection.error ?? 'Please wait.'}</p>
      </div>
    );
  }

  if (boards?.length === 0 && !loading) {
    return (
      <div className="hm-empty-state">
        <p>No boards available</p>
        <p className="hm-muted">Create a board to start tracking tasks.</p>
      </div>
    );
  }

  async function handleOpenTask(id: string) {
    await loadTaskDetail(rest, id);
  }

  function openCreateForm(status: TaskStatus) {
    setCreateForm({
      open: true,
      column: status,
      title: '',
      body: '',
      assignee: '',
      priority: '0',
      skills: '',
      goalMode: false,
      goalMaxTurns: '',
      workspaceKind: 'scratch',
      workspacePath: '',
      parentId: '',
      tenant: '',
      maxRuntimeSeconds: '',
    });
  }

  function closeCreateForm() {
    setCreateForm((f) => ({ ...f, open: false }));
  }

  async function handleSubmitCreate() {
    const {
      column,
      title,
      body,
      assignee,
      priority,
      skills,
      goalMode,
      goalMaxTurns,
      workspaceKind,
      workspacePath,
      parentId,
      tenant,
      maxRuntimeSeconds,
    } = createForm;
    if (!column || !title.trim()) return;
    const payload: Parameters<typeof createTask>[1] = {
      column,
      title: title.trim(),
      priority: Number(priority) || 0,
      workspaceKind,
    };
    const trimmedBody = body.trim();
    const trimmedAssignee = assignee.trim();
    const parsedSkills = skills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (trimmedBody) payload.body = trimmedBody;
    if (trimmedAssignee) payload.assignee = trimmedAssignee;
    if (parsedSkills.length > 0) payload.skills = parsedSkills;
    if (goalMode) payload.goalMode = true;
    const parsedGoalMaxTurns = goalMode && goalMaxTurns ? Number(goalMaxTurns) : 0;
    if (parsedGoalMaxTurns > 0) payload.goalMaxTurns = parsedGoalMaxTurns;
    if (workspaceKind === 'dir' && workspacePath.trim()) payload.workspacePath = workspacePath.trim();
    if (parentId) payload.parentId = parentId;
    if (tenant.trim()) payload.tenant = tenant.trim();
    const parsedRuntime = maxRuntimeSeconds ? Number(maxRuntimeSeconds) : 0;
    if (parsedRuntime > 0) payload.maxRuntimeSeconds = parsedRuntime;
    await createTask(rest, payload);
    closeCreateForm();
  }

  async function handleMove(status: TaskStatus) {
    if (!selectedTask) return;
    await moveTask(rest, selectedTask.id, status);
  }

  async function handleAssign(assignee: string) {
    if (!selectedTask) return;
    await assignTask(rest, selectedTask.id, assignee);
  }

  async function handleComment() {
    if (!selectedTask || !commentText.trim()) return;
    await addComment(rest, selectedTask.id, commentText.trim());
    setCommentText('');
  }

  function handleStartCreateBoard() {
    setCreatingBoard(true);
    setNewBoardName('');
  }

  function handleCancelCreateBoard() {
    setCreatingBoard(false);
    setNewBoardName('');
  }

  async function handleSubmitCreateBoard() {
    const name = newBoardName.trim();
    if (!name) return;
    await createBoard(rest, name);
    setCreatingBoard(false);
    setNewBoardName('');
    setSelectorOpen(false);
  }

  return (
    <div className="hm-projects">
      <div className="hm-projects__topbar">
        <button
          className="hm-projects__board-select"
          onClick={() => setSelectorOpen(!selectorOpen)}
          aria-expanded={selectorOpen}
        >
          <span className="hm-projects__board-name">{activeBoard?.name ?? 'Boards'}</span>
          <Icon name="chevD" size={14} />
        </button>
        <button
          className="hm-projects__refresh"
          onClick={() => void loadBoards(rest)}
          aria-label="Refresh board"
          title="Refresh board"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {selectorOpen && (
        <div className="hm-projects__board-menu">
          {boards.map((b) => (
            <button
              key={b.slug}
              className={`hm-projects__board-option ${b.slug === activeBoardSlug ? 'hm-projects__board-option--active' : ''}`}
              onClick={() => {
                void setActiveBoard(rest, b.slug);
                setSelectorOpen(false);
              }}
            >
              {b.name}
              <span className="hm-muted">{b.taskCount} tasks</span>
            </button>
          ))}
          {boards.length === 0 && <div className="hm-muted hm-projects__board-option">No boards</div>}

          {creatingBoard ? (
            <div className="hm-projects__board-create">
              <input
                type="text"
                className="hm-input hm-projects__board-create-input"
                placeholder="Board name…"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSubmitCreateBoard();
                  if (e.key === 'Escape') handleCancelCreateBoard();
                }}
                autoFocus
              />
              <div className="hm-projects__board-create-actions">
                <button
                  type="button"
                  className="hm-primary hm-projects__board-create-save"
                  disabled={!newBoardName.trim()}
                  onClick={() => void handleSubmitCreateBoard()}
                >
                  Create
                </button>
                <button type="button" className="hm-ghost" onClick={handleCancelCreateBoard}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="hm-projects__board-create-toggle"
              onClick={handleStartCreateBoard}
            >
              <Icon name="plus" size={14} />
              <span>Create new board</span>
            </button>
          )}
        </div>
      )}

      {error && <div className="hm-warning-banner hm-warning-banner--error">{error}</div>}
      {loading && tasks.length === 0 && <SkeletonRows rows={4} kind="cards" label="Loading board" />}

      <div className="hm-projects__board">
        {columns.map((col) => (
          <div key={col.status} className="hm-projects__column">
            <div className="hm-projects__column-header">
              <span className="hm-projects__column-dot" style={{ background: col.tint }} />
              <span className="hm-projects__column-title">{col.label}</span>
              <span className="hm-projects__column-count">{col.tasks.length}</span>
              <button
                type="button"
                className="hm-projects__column-add"
                onClick={() => openCreateForm(col.status)}
                aria-label={`Add task to ${col.label}`}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>

            <div className="hm-projects__column-tasks">
              {col.tasks.map((t) => (
                <TaskCard key={t.id} task={t} onClick={(id) => void handleOpenTask(id)} />
              ))}
            </div>
          </div>
        ))}

        {tasks.length === 0 && !loading && (
          <div className="hm-projects__empty-board">
            <p>No tasks on this board</p>
            <p className="hm-muted">Tap + in a column to add one.</p>
          </div>
        )}
      </div>

      {createForm.open && createForm.column && (
        <BottomSheet
          title={`New task · ${COLUMN_LABEL[createForm.column]}`}
          onClose={closeCreateForm}
          footer={
            <div className="hm-projects__inline-actions">
              <button
                type="button"
                className="hm-primary hm-projects__inline-save"
                disabled={!createForm.title.trim()}
                onClick={() => void handleSubmitCreate()}
              >
                Create
              </button>
              <button type="button" className="hm-ghost" onClick={closeCreateForm}>
                Cancel
              </button>
            </div>
          }
        >
          <div className="hm-projects__field">
            <label className="hm-projects__label">Title</label>
            <textarea
              className="hm-textarea"
              rows={2}
              placeholder="What needs to be done?"
              value={createForm.title}
              onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
              autoFocus
            />
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Description</label>
            <textarea
              className="hm-textarea"
              rows={3}
              placeholder="Optional details…"
              value={createForm.body}
              onChange={(e) => setCreateForm((f) => ({ ...f, body: e.target.value }))}
            />
          </div>

          <div className="hm-projects__form-row">
            <div className="hm-projects__field">
              <label className="hm-projects__label" htmlFor="hm-projects-assignee">
                Assignee
              </label>
              <select
                id="hm-projects-assignee"
                className="hm-select"
                value={createForm.assignee}
                onChange={(e) => setCreateForm((f) => ({ ...f, assignee: e.target.value }))}
              >
                <option value="">— Unassigned —</option>
                {assigneeOptions.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hm-projects__field">
              <label className="hm-projects__label">Priority</label>
              <input
                type="number"
                className="hm-input"
                min={0}
                value={createForm.priority}
                onChange={(e) => setCreateForm((f) => ({ ...f, priority: e.target.value }))}
              />
            </div>
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Skills</label>
            <input
              type="text"
              className="hm-input"
              placeholder="comma-separated, e.g. python, git"
              value={createForm.skills}
              onChange={(e) => setCreateForm((f) => ({ ...f, skills: e.target.value }))}
            />
          </div>

          <div className="hm-projects__form-row">
            <div className="hm-projects__field">
              <label className="hm-projects__label">Workspace</label>
              <select
                className="hm-select"
                value={createForm.workspaceKind}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, workspaceKind: e.target.value as 'scratch' | 'dir' }))
                }
              >
                <option value="scratch">scratch</option>
                <option value="dir">dir</option>
              </select>
            </div>
            <div className="hm-projects__field">
              <label className="hm-projects__label">Parent</label>
              <select
                className="hm-select"
                value={createForm.parentId}
                onChange={(e) => setCreateForm((f) => ({ ...f, parentId: e.target.value }))}
              >
                <option value="">— no parent —</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {createForm.workspaceKind === 'dir' && (
            <div className="hm-projects__field">
              <label className="hm-projects__label">Workspace path</label>
              <input
                type="text"
                className="hm-input"
                placeholder="/path/to/workspace"
                value={createForm.workspacePath}
                onChange={(e) => setCreateForm((f) => ({ ...f, workspacePath: e.target.value }))}
              />
            </div>
          )}

          <div className="hm-projects__form-row">
            <div className="hm-projects__field">
              <label className="hm-projects__label">Tenant</label>
              <input
                type="text"
                className="hm-input"
                placeholder="default"
                value={createForm.tenant}
                onChange={(e) => setCreateForm((f) => ({ ...f, tenant: e.target.value }))}
              />
            </div>
            <div className="hm-projects__field">
              <label className="hm-projects__label">Max runtime (s)</label>
              <input
                type="number"
                className="hm-input"
                min={0}
                placeholder="seconds"
                value={createForm.maxRuntimeSeconds}
                onChange={(e) => setCreateForm((f) => ({ ...f, maxRuntimeSeconds: e.target.value }))}
              />
            </div>
          </div>

          <label className="hm-check-card hm-projects__goal-mode">
            <input
              type="checkbox"
              checked={createForm.goalMode}
              onChange={(e) => setCreateForm((f) => ({ ...f, goalMode: e.target.checked }))}
            />
            <span className="hm-status-label">Goal mode</span>
          </label>

          {createForm.goalMode && (
            <div className="hm-projects__field">
              <label className="hm-projects__label">Goal max turns</label>
              <input
                type="number"
                className="hm-input"
                min={0}
                placeholder="e.g. 10"
                value={createForm.goalMaxTurns}
                onChange={(e) => setCreateForm((f) => ({ ...f, goalMaxTurns: e.target.value }))}
              />
            </div>
          )}
        </BottomSheet>
      )}

      {selectedTask && (
        <BottomSheet
          title={selectedTask.title}
          onClose={clearSelectedTask}
          meta={
            <div className="hm-sheet__meta">
              <span className="hm-badge hm-badge--info">{COLUMN_LABEL[selectedTask.status]}</span>
              {selectedTask.assignee && <span className="hm-muted">@{selectedTask.assignee}</span>}
              {typeof selectedTask.priority === 'number' && selectedTask.priority > 0 && (
                <span className="hm-badge">P{selectedTask.priority}</span>
              )}
            </div>
          }
          footer={
            <button className="hm-ghost hm-sheet__close" onClick={clearSelectedTask}>
              Close
            </button>
          }
        >
          <div className="hm-projects__field">
            <label className="hm-projects__label" htmlFor="hm-projects-task-status">Status</label>
            <select
              id="hm-projects-task-status"
              className="hm-select"
              value={selectedTask.status}
              onChange={(e) => void handleMove(e.target.value as TaskStatus)}
            >
              {MOVE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {COLUMN_LABEL[s]}
                </option>
              ))}
            </select>
          </div>

          {/* The bot that runs the card. Hermes will not move a card while a bot is running it. */}
          <div className="hm-projects__field">
            <label className="hm-projects__label" htmlFor="hm-projects-task-assignee">Assignee</label>
            <select
              id="hm-projects-task-assignee"
              className="hm-select"
              value={selectedTask.assignee ?? ''}
              disabled={isRunning(selectedTask.status)}
              title={isRunning(selectedTask.status) ? 'Running now: change the bot when it stops' : undefined}
              onChange={(e) => void handleAssign(e.target.value)}
            >
              <option value="">— Unassigned —</option>
              {selectedTask.assignee && !assigneeOptions.some((p) => p.value === selectedTask.assignee) && (
                <option value={selectedTask.assignee}>{selectedTask.assignee}</option>
              )}
              {assigneeOptions.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {selectedTask.body && (
            <div className="hm-projects__field">
              <label className="hm-projects__label">Description</label>
              <p className="hm-projects__body">{selectedTask.body}</p>
            </div>
          )}

          <div className="hm-projects__field">
            <label className="hm-projects__label">Comments</label>
            {selectedTaskComments.length === 0 ? (
              <p className="hm-muted">No comments yet.</p>
            ) : (
              <div className="hm-projects__comments">
                {selectedTaskComments.map((c) => (
                  <div key={c.id} className="hm-projects__comment">
                    <div className="hm-projects__comment-head">
                      <span className="hm-projects__comment-author">{c.author}</span>
                      <span className="hm-projects__comment-time">{formatTime(c.createdAt)}</span>
                    </div>
                    <p className="hm-projects__comment-body">{c.body}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="hm-clarify-form">
            <input
              aria-label="Add comment"
              placeholder="Add a comment…"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleComment();
                }
              }}
              className="hm-input"
            />
            <button
              className="hm-primary"
              disabled={commentText.trim().length === 0}
              onClick={() => void handleComment()}
              aria-label="Send comment"
            >
              Send
            </button>
          </div>
        </BottomSheet>
      )}
    </div>
  );
}
