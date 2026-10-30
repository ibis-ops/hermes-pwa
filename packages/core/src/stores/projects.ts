import { create } from 'zustand';
import type { Board, BoardDetail, Column, Comment, Task, TaskDetail, TaskStatus, Worker } from '../domain/project';
import type { RestClient } from '../transport/rest';

const BOARD_STORAGE_KEY = 'hermes-kanban-board';

function readStoredBoard(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const v = window.localStorage.getItem(BOARD_STORAGE_KEY);
    return v || undefined;
  } catch {
    // Storage blocked (Safari with cookies off): the board choice is not remembered.
    return undefined;
  }
}

function writeStoredBoard(slug: string | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    if (slug) window.localStorage.setItem(BOARD_STORAGE_KEY, slug);
    else window.localStorage.removeItem(BOARD_STORAGE_KEY);
  } catch {
    // Best-effort preference only.
  }
}

export interface ProjectsStore {
  boards: Board[];
  activeBoardSlug: string | undefined;
  tasks: Task[];
  workers: Worker[];
  loading: boolean;
  error: string | undefined;
  selectedTask: Task | undefined;
  selectedTaskComments: Comment[];

  loadBoards(rest: RestClient): Promise<void>;
  setActiveBoard(rest: RestClient, slug: string): Promise<void>;
  createBoard(rest: RestClient, name: string): Promise<void>;
  deleteBoard(rest: RestClient, slug: string): Promise<void>;
  openBoard(rest: RestClient, slug: string): Promise<void>;
  reloadBoard(rest: RestClient): Promise<void>;
  createTask(
    rest: RestClient,
    params: {
      column: TaskStatus;
      title: string;
      body?: string;
      assignee?: string;
      priority?: number;
      skills?: string[];
      goalMode?: boolean;
      goalMaxTurns?: number;
      workspaceKind?: 'scratch' | 'dir';
      workspacePath?: string;
      parentId?: string;
      tenant?: string;
      maxRuntimeSeconds?: number;
    },
  ): Promise<void>;
  moveTask(rest: RestClient, taskId: string, status: TaskStatus): Promise<void>;
  /** Hand a task to another bot (`''` leaves it unassigned). Hermes refuses while it is running. */
  assignTask(rest: RestClient, taskId: string, assignee: string): Promise<void>;
  loadTaskDetail(rest: RestClient, taskId: string): Promise<void>;
  addComment(rest: RestClient, taskId: string, body: string): Promise<void>;
  steer(rest: RestClient, taskId: string, text: string): Promise<void>;
  clear(): void;
  clearSelectedTask(): void;
}

function pickActiveSlug(boards: Board[]): string | undefined {
  if (boards.length === 0) return undefined;
  const stored = readStoredBoard();
  if (stored && boards.some((b) => b.slug === stored)) return stored;
  const current = boards.find((b) => b.isCurrent)?.slug;
  if (current) return current;
  return boards[0]?.slug;
}

function boardFromDetail(detail: BoardDetail): Column[] {
  return detail.columns;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  boards: [],
  activeBoardSlug: undefined,
  tasks: [],
  workers: [],
  loading: false,
  error: undefined,
  selectedTask: undefined,
  selectedTaskComments: [],

  async loadBoards(rest) {
    set({ loading: true, error: undefined });
    try {
      const boards = await rest.kanbanBoards();
      const activeBoardSlug = pickActiveSlug(boards);
      set({ boards, activeBoardSlug, loading: false });
      if (activeBoardSlug) {
        await get().openBoard(rest, activeBoardSlug);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load boards.';
      set({ loading: false, error: msg });
    }
  },

  async setActiveBoard(rest, slug) {
    if (get().activeBoardSlug === slug) return;
    writeStoredBoard(slug);
    await get().openBoard(rest, slug);
  },

  async createBoard(rest, name) {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 64);
    if (!slug) throw new Error('Invalid board name.');
    set({ loading: true, error: undefined });
    try {
      await rest.kanbanCreateBoard({ slug, name, switch: true });
      await get().loadBoards(rest);
      await get().setActiveBoard(rest, slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create board.';
      set({ loading: false, error: msg });
      throw err;
    }
  },

  async deleteBoard(rest, slug) {
    set({ loading: true, error: undefined });
    try {
      await rest.kanbanDeleteBoard(slug);
      await get().loadBoards(rest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete board.';
      set({ loading: false, error: msg });
      throw err;
    }
  },

  async openBoard(rest, slug) {
    set({ loading: true, error: undefined, activeBoardSlug: slug });
    try {
      const detail = await rest.kanbanBoard(slug);
      const columns = boardFromDetail(detail);
      const tasks = columns.flatMap((col) => col.tasks);
      set({ tasks, workers: [], loading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to open board.';
      set({ loading: false, error: msg });
    }
  },

  async reloadBoard(rest) {
    const slug = get().activeBoardSlug;
    if (!slug) return;
    await get().openBoard(rest, slug);
  },

  async createTask(
    rest,
    { column, title, body, assignee, priority, skills, goalMode, goalMaxTurns, workspaceKind, workspacePath, parentId, tenant, maxRuntimeSeconds },
  ) {
    const slug = get().activeBoardSlug;
    if (!slug) return;
    set({ loading: true, error: undefined });
    try {
      const payload: Parameters<RestClient['kanbanCreateTask']>[1] = {
        title,
        priority: typeof priority === 'number' ? priority : 0,
        workspace_kind: workspaceKind ?? 'scratch',
        triage: column === 'triage',
      };
      if (body) payload.body = body;
      if (assignee) payload.assignee = assignee;
      if (parentId) payload.parents = [parentId];
      if (skills && skills.length > 0) payload.skills = skills;
      if (goalMode) payload.goal_mode = goalMode;
      if (goalMode && typeof goalMaxTurns === 'number' && goalMaxTurns > 0) payload.goal_max_turns = goalMaxTurns;
      if (workspaceKind === 'dir' && workspacePath) payload.workspace_path = workspacePath;
      if (tenant) payload.tenant = tenant;
      if (typeof maxRuntimeSeconds === 'number' && maxRuntimeSeconds > 0) payload.max_runtime_seconds = maxRuntimeSeconds;
      await rest.kanbanCreateTask(slug, payload);
      await get().openBoard(rest, slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create task.';
      set({ loading: false, error: msg });
    }
  },

  async moveTask(rest, taskId, status) {
    const slug = get().activeBoardSlug;
    if (!slug) return;
    try {
      await rest.kanbanUpdateTask(slug, taskId, { status });
      await get().openBoard(rest, slug);
      // Refresh selected task if it is the one being moved.
      if (get().selectedTask?.id === taskId) {
        await get().loadTaskDetail(rest, taskId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to move task.';
      set({ error: msg });
      throw err;
    }
  },

  async assignTask(rest, taskId, assignee) {
    const slug = get().activeBoardSlug;
    if (!slug) return;
    try {
      await rest.kanbanUpdateTask(slug, taskId, { assignee });
      await get().openBoard(rest, slug);
      if (get().selectedTask?.id === taskId) {
        await get().loadTaskDetail(rest, taskId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to change the bot.';
      set({ error: msg });
      throw err;
    }
  },

  async loadTaskDetail(rest, taskId) {
    const slug = get().activeBoardSlug;
    if (!slug) return;
    try {
      const { task, comments }: TaskDetail = await rest.kanbanTaskDetail(slug, taskId);
      set({ selectedTask: task, selectedTaskComments: comments });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load task details.';
      set({ error: msg });
    }
  },

  async addComment(rest, taskId, body) {
    const slug = get().activeBoardSlug;
    if (!slug) return;
    try {
      await rest.kanbanComment(taskId, { body, author: 'mobile' });
      await get().loadTaskDetail(rest, taskId);
      await get().openBoard(rest, slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add comment.';
      set({ error: msg });
      throw err;
    }
  },

  async steer(rest, taskId, text) {
    await get().addComment(rest, taskId, text);
  },

  clear() {
    set({
      boards: [],
      activeBoardSlug: undefined,
      tasks: [],
      workers: [],
      loading: false,
      error: undefined,
      selectedTask: undefined,
      selectedTaskComments: [],
    });
  },

  clearSelectedTask() {
    set({ selectedTask: undefined, selectedTaskComments: [] });
  },
}));

// Type-only re-export so callers do not need to import from domain separately.
export type { Column };
