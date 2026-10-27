import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useProjectsStore } from './projects';
import type { RestClient } from '../transport/rest';

describe('useProjectsStore', () => {
  let restMock: RestClient;

  beforeEach(() => {
    localStorage.clear();
    useProjectsStore.setState({
      boards: [],
      activeBoardSlug: undefined,
      tasks: [],
      workers: [],
      loading: false,
      error: undefined,
      selectedTask: undefined,
      selectedTaskComments: [],
    });
    restMock = {
      status: vi.fn(),
      providers: vi.fn(),
      passwordLogin: vi.fn(),
      me: vi.fn(),
      wsTicket: vi.fn(),
      logout: vi.fn(),
      kanbanBoards: vi.fn(),
      kanbanCreateBoard: vi.fn(),
      kanbanDeleteBoard: vi.fn(),
      kanbanSwitchBoard: vi.fn(),
      kanbanBoard: vi.fn(),
      kanbanCreateTask: vi.fn(),
      kanbanUpdateTask: vi.fn(),
      kanbanTaskDetail: vi.fn(),
      kanbanComment: vi.fn(),
    } as unknown as RestClient;
  });

  it('loads boards and auto-opens the current board', async () => {
    vi.mocked(restMock.kanbanBoards).mockResolvedValue([
      { slug: 'main', name: 'Main', taskCount: 3, isCurrent: true },
    ]);
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({
      slug: 'main',
      name: 'Main',
      columns: [
        {
          status: 'todo',
          tasks: [{ id: 't-1', title: 'Task 1', status: 'todo', createdAt: 1 }],
        },
      ],
    });
    await useProjectsStore.getState().loadBoards(restMock);
    expect(useProjectsStore.getState().boards).toHaveLength(1);
    expect(useProjectsStore.getState().activeBoardSlug).toBe('main');
    expect(useProjectsStore.getState().tasks).toHaveLength(1);
  });

  it('loadBoards handles empty array', async () => {
    vi.mocked(restMock.kanbanBoards).mockResolvedValue([]);
    await useProjectsStore.getState().loadBoards(restMock);
    expect(useProjectsStore.getState().boards).toEqual([]);
    expect(useProjectsStore.getState().activeBoardSlug).toBeUndefined();
  });

  it('loadBoards handles error', async () => {
    vi.mocked(restMock.kanbanBoards).mockRejectedValue(new Error('down'));
    await useProjectsStore.getState().loadBoards(restMock);
    expect(useProjectsStore.getState().error).toBe('down');
    expect(useProjectsStore.getState().loading).toBe(false);
  });

  it('loadBoards handles non-error rejection', async () => {
    vi.mocked(restMock.kanbanBoards).mockRejectedValue('bad');
    await useProjectsStore.getState().loadBoards(restMock);
    expect(useProjectsStore.getState().error).toBe('Failed to load boards.');
    expect(useProjectsStore.getState().loading).toBe(false);
  });

  it('still loads boards when storage is blocked', async () => {
    // Safari with all cookies blocked throws on every localStorage access.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: localStorage is blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError: localStorage is blocked');
    });
    try {
      vi.mocked(restMock.kanbanBoards).mockResolvedValue([{ slug: 'main', name: 'Main', taskCount: 1, isCurrent: true }]);
      vi.mocked(restMock.kanbanBoard).mockResolvedValue({ slug: 'main', name: 'Main', columns: [{ status: 'todo', tasks: [] }] });

      await useProjectsStore.getState().loadBoards(restMock);
      expect(useProjectsStore.getState().activeBoardSlug).toBe('main');
      expect(useProjectsStore.getState().error).toBeUndefined();

      vi.mocked(restMock.kanbanBoards).mockResolvedValue([
        { slug: 'main', name: 'Main', taskCount: 1 },
        { slug: 'ops', name: 'Ops', taskCount: 1 },
      ]);
      vi.mocked(restMock.kanbanBoard).mockResolvedValue({ slug: 'ops', name: 'Ops', columns: [] });
      await expect(useProjectsStore.getState().setActiveBoard(restMock, 'ops')).resolves.toBeUndefined();
      expect(useProjectsStore.getState().activeBoardSlug).toBe('ops');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('restores stored board when available', async () => {
    localStorage.setItem('hermes-kanban-board', 'stored');
    vi.mocked(restMock.kanbanBoards).mockResolvedValue([
      { slug: 'main', name: 'Main', taskCount: 1 },
      { slug: 'stored', name: 'Stored', taskCount: 1 },
    ]);
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({
      slug: 'stored',
      name: 'Stored',
      columns: [{ status: 'todo', tasks: [] }],
    });
    await useProjectsStore.getState().loadBoards(restMock);
    expect(useProjectsStore.getState().activeBoardSlug).toBe('stored');
  });

  it('opens board and loads tasks from columns', async () => {
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({
      slug: 'main',
      name: 'Main',
      columns: [
        {
          status: 'todo',
          tasks: [{ id: 't-1', title: 'Task 1', status: 'todo', createdAt: 1 }],
        },
      ],
    });
    await useProjectsStore.getState().openBoard(restMock, 'main');
    expect(useProjectsStore.getState().activeBoardSlug).toBe('main');
    expect(useProjectsStore.getState().tasks).toHaveLength(1);
    expect(useProjectsStore.getState().tasks[0]?.title).toBe('Task 1');
  });

  it('openBoard handles empty columns', async () => {
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({ slug: 'main', name: 'Main', columns: [] });
    await useProjectsStore.getState().openBoard(restMock, 'main');
    expect(useProjectsStore.getState().tasks).toEqual([]);
  });

  it('openBoard handles error', async () => {
    vi.mocked(restMock.kanbanBoard).mockRejectedValue(new Error('fail'));
    await useProjectsStore.getState().openBoard(restMock, 'main');
    expect(useProjectsStore.getState().error).toBe('fail');
    expect(useProjectsStore.getState().loading).toBe(false);
  });

  it('openBoard handles non-error rejection', async () => {
    vi.mocked(restMock.kanbanBoard).mockRejectedValue('bad');
    await useProjectsStore.getState().openBoard(restMock, 'main');
    expect(useProjectsStore.getState().error).toBe('Failed to open board.');
    expect(useProjectsStore.getState().loading).toBe(false);
  });

  it('creates a task and reloads the board', async () => {
    vi.mocked(restMock.kanbanCreateTask).mockResolvedValue({ id: 't-2', title: 'New', status: 'todo', createdAt: 1 });
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({
      slug: 'main',
      name: 'Main',
      columns: [{ status: 'todo', tasks: [{ id: 't-2', title: 'New', status: 'todo', createdAt: 1 }] }],
    });
    useProjectsStore.setState({ activeBoardSlug: 'main' });
    await useProjectsStore.getState().createTask(restMock, { column: 'todo', title: 'New', assignee: 'dev', priority: 5, skills: ['python'] });
    expect(restMock.kanbanCreateTask).toHaveBeenCalledWith('main', {
      title: 'New',
      assignee: 'dev',
      priority: 5,
      workspace_kind: 'scratch',
      triage: false,
      skills: ['python'],
    });
    expect(useProjectsStore.getState().tasks[0]?.title).toBe('New');
  });

  it('creates a task with all donor API fields', async () => {
    vi.mocked(restMock.kanbanCreateTask).mockResolvedValue({ id: 't-3', title: 'Advanced', status: 'todo', createdAt: 1 });
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({
      slug: 'main',
      name: 'Main',
      columns: [{ status: 'todo', tasks: [{ id: 't-3', title: 'Advanced', status: 'todo', createdAt: 1 }] }],
    });
    useProjectsStore.setState({ activeBoardSlug: 'main' });
    await useProjectsStore.getState().createTask(restMock, {
      column: 'todo',
      title: 'Advanced',
      body: 'details',
      assignee: 'dev',
      priority: 4,
      skills: ['python'],
      goalMode: true,
      goalMaxTurns: 7,
      workspaceKind: 'dir',
      workspacePath: '/tmp/ws',
      parentId: 't-1',
      tenant: 'acme',
      maxRuntimeSeconds: 120,
    });
    expect(restMock.kanbanCreateTask).toHaveBeenCalledWith('main', {
      title: 'Advanced',
      body: 'details',
      assignee: 'dev',
      priority: 4,
      workspace_kind: 'dir',
      workspace_path: '/tmp/ws',
      parents: ['t-1'],
      triage: false,
      skills: ['python'],
      goal_mode: true,
      goal_max_turns: 7,
      tenant: 'acme',
      max_runtime_seconds: 120,
    });
  });

  it('moves a task to another status', async () => {
    vi.mocked(restMock.kanbanUpdateTask).mockResolvedValue({ id: 't-1', title: 'T', status: 'done', createdAt: 1 });
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({
      slug: 'main',
      name: 'Main',
      columns: [{ status: 'done', tasks: [{ id: 't-1', title: 'T', status: 'done', createdAt: 1 }] }],
    });
    useProjectsStore.setState({ activeBoardSlug: 'main' });
    await useProjectsStore.getState().moveTask(restMock, 't-1', 'done');
    expect(restMock.kanbanUpdateTask).toHaveBeenCalledWith('main', 't-1', { status: 'done' });
    expect(useProjectsStore.getState().tasks[0]?.status).toBe('done');
  });

  it('loads task detail', async () => {
    vi.mocked(restMock.kanbanTaskDetail).mockResolvedValue({
      task: { id: 't-1', title: 'T', status: 'todo', createdAt: 1, body: 'desc' },
      comments: [{ id: 1, taskId: 't-1', author: 'mobile', body: 'hello', createdAt: 1 }],
    });
    useProjectsStore.setState({ activeBoardSlug: 'main' });
    await useProjectsStore.getState().loadTaskDetail(restMock, 't-1');
    expect(useProjectsStore.getState().selectedTask?.body).toBe('desc');
    expect(useProjectsStore.getState().selectedTaskComments).toHaveLength(1);
  });

  it('adds a comment', async () => {
    vi.mocked(restMock.kanbanComment).mockResolvedValue({});
    vi.mocked(restMock.kanbanTaskDetail).mockResolvedValue({
      task: { id: 't-1', title: 'T', status: 'todo', createdAt: 1 },
      comments: [{ id: 1, taskId: 't-1', author: 'mobile', body: 'hello', createdAt: 1 }],
    });
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({
      slug: 'main',
      name: 'Main',
      columns: [],
    });
    useProjectsStore.setState({ activeBoardSlug: 'main' });
    await useProjectsStore.getState().addComment(restMock, 't-1', 'hello');
    expect(restMock.kanbanComment).toHaveBeenCalledWith('t-1', { body: 'hello', author: 'mobile' });
    expect(useProjectsStore.getState().selectedTaskComments).toHaveLength(1);
  });

  it('creates a board and switches to it', async () => {
    vi.mocked(restMock.kanbanCreateBoard).mockResolvedValue({ slug: 'new-board', name: 'New Board', taskCount: 0 });
    vi.mocked(restMock.kanbanBoards).mockResolvedValue([
      { slug: 'new-board', name: 'New Board', taskCount: 0 },
    ]);
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({ slug: 'new-board', name: 'New Board', columns: [] });
    await useProjectsStore.getState().createBoard(restMock, 'New Board');
    expect(restMock.kanbanCreateBoard).toHaveBeenCalledWith({ slug: 'new-board', name: 'New Board', switch: true });
    expect(useProjectsStore.getState().activeBoardSlug).toBe('new-board');
  });

  it('steer sends comment', async () => {
    vi.mocked(restMock.kanbanComment).mockResolvedValue({});
    vi.mocked(restMock.kanbanTaskDetail).mockResolvedValue({
      task: { id: 't-1', title: 'T', status: 'todo', createdAt: 1 },
      comments: [],
    });
    vi.mocked(restMock.kanbanBoard).mockResolvedValue({ slug: 'main', name: 'Main', columns: [] });
    useProjectsStore.setState({ activeBoardSlug: 'main' });
    await useProjectsStore.getState().steer(restMock, 't-1', 'do this');
    expect(restMock.kanbanComment).toHaveBeenCalledWith('t-1', { body: 'do this', author: 'mobile' });
  });

  it('clear resets', () => {
    useProjectsStore.setState({
      boards: [{ slug: 'main', name: 'Main', taskCount: 0 }],
      tasks: [{ id: 't-1', title: 'T', status: 'backlog', createdAt: 1 }],
    });
    useProjectsStore.getState().clear();
    expect(useProjectsStore.getState().boards).toEqual([]);
    expect(useProjectsStore.getState().tasks).toEqual([]);
    expect(useProjectsStore.getState().activeBoardSlug).toBeUndefined();
    expect(useProjectsStore.getState().selectedTask).toBeUndefined();
  });
});
