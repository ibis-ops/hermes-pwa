import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Projects } from './Projects';
import { useProjectsStore, useConnectionStore, useProfilesStore, type Task, type Board, type BoardDetail } from '@hermes-pwa/core';

const restMock = {
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
} as unknown as import('@hermes-pwa/core').RestClient;

const boardTasks: Task[] = [
  { id: 't-1', title: 'Task 1', status: 'todo', priority: 5, assignee: 'default', createdAt: Date.now() },
  { id: 't-2', title: 'Task 2', status: 'ready', priority: 2, createdAt: Date.now() },
];

const boardDetail: BoardDetail = {
  slug: 'main',
  name: 'Main',
  columns: [
    { status: 'todo', tasks: [boardTasks[0]!] },
    { status: 'ready', tasks: [boardTasks[1]!] },
  ],
};

describe('Projects', () => {
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
    useConnectionStore.setState({ state: 'connected', error: undefined } as ReturnType<typeof useConnectionStore.getState>);
    useProfilesStore.setState({
      profiles: [
        { name: 'default', displayName: 'Default', isActive: true },
        { name: 'dev', displayName: 'Dev', isActive: false },
      ],
      activeName: 'default',
      currentName: 'default',
      loading: false,
      error: undefined,
    });
    vi.clearAllMocks();
    vi.mocked(restMock.kanbanBoards).mockResolvedValue([{ id: 'b-1', slug: 'main', name: 'Main', taskCount: 2 }] as Board[]);
    vi.mocked(restMock.kanbanBoard).mockResolvedValue(boardDetail);
    vi.mocked(restMock.kanbanTaskDetail).mockResolvedValue({ task: boardTasks[0]!, comments: [] });
  });

  it('renders empty board list', async () => {
    vi.mocked(restMock.kanbanBoards).mockResolvedValue([]);
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText(/No boards available/i)).toBeInTheDocument());
  });

  it('auto-opens first board and shows columns', async () => {
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    expect(screen.getByText('Task 2')).toBeInTheDocument();
  });

  it('shows connecting state when init/offline', () => {
    useConnectionStore.setState({ state: 'init', error: undefined } as ReturnType<typeof useConnectionStore.getState>);
    render(<Projects rest={restMock} />);
    expect(screen.getByText(/Connecting to Hermes/i)).toBeInTheDocument();
  });

  it('keeps cached content visible while reconnecting', () => {
    useProjectsStore.setState({
      boards: [{ id: 'b-1', slug: 'main', name: 'Cached board', taskCount: 0 }],
      activeBoardSlug: 'main',
      tasks: boardTasks,
      workers: [],
    });
    useConnectionStore.setState({ state: 'reconnecting', error: undefined } as ReturnType<typeof useConnectionStore.getState>);
    render(<Projects rest={restMock} />);
    expect(screen.getByText('Cached board')).toBeInTheDocument();
  });

  it('opens task detail and adds a comment', async () => {
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Task 1'));
    await waitFor(() => expect(screen.getByLabelText(/Add comment/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Add comment/i), { target: { value: 'do it' } });
    fireEvent.click(screen.getByRole('button', { name: /Send comment/i }));
    await waitFor(() => expect(restMock.kanbanComment).toHaveBeenCalledWith('t-1', { body: 'do it', author: 'mobile' }));
  });

  it('closes task sheet without commenting', async () => {
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Task 1'));
    await waitFor(() => expect(screen.getByLabelText(/Add comment/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Close/i));
    await waitFor(() => expect(screen.queryByLabelText(/Add comment/i)).not.toBeInTheDocument());
  });

  it('creates a task in a column with full payload', async () => {
    vi.mocked(restMock.kanbanCreateTask).mockResolvedValue({ id: 't-3', title: 'New task', status: 'todo', createdAt: Date.now() });
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Add task to To do'));
    fireEvent.change(screen.getByPlaceholderText(/What needs to be done/i), { target: { value: 'New task' } });
    fireEvent.change(screen.getByLabelText(/Assignee/i), { target: { value: 'dev' } });
    fireEvent.change(screen.getByPlaceholderText(/comma-separated/i), { target: { value: 'python, git' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
    await waitFor(() =>
      expect(restMock.kanbanCreateTask).toHaveBeenCalledWith('main', {
        title: 'New task',
        assignee: 'dev',
        priority: 0,
        workspace_kind: 'scratch',
        triage: false,
        skills: ['python', 'git'],
      }),
    );
  });

  it('creates a task with all donor API fields from the sheet', async () => {
    vi.mocked(restMock.kanbanCreateTask).mockResolvedValue({ id: 't-3', title: 'Advanced', status: 'todo', createdAt: Date.now() });
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Add task to To do'));

    fireEvent.change(screen.getByPlaceholderText(/What needs to be done/i), { target: { value: 'Advanced' } });
    fireEvent.change(screen.getByPlaceholderText(/Optional details/i), { target: { value: 'details' } });
    fireEvent.change(screen.getByLabelText(/Assignee/i), { target: { value: 'dev' } });

    const [priorityInput, runtimeInput] = screen.getAllByRole('spinbutton');
    fireEvent.change(priorityInput!, { target: { value: '4' } });
    fireEvent.change(screen.getByPlaceholderText(/comma-separated/i), { target: { value: 'python' } });

    const [, workspaceSelect, parentSelect] = screen.getAllByRole('combobox');
    fireEvent.change(workspaceSelect!, { target: { value: 'dir' } });
    fireEvent.change(parentSelect!, { target: { value: 't-1' } });

    fireEvent.change(screen.getByPlaceholderText(/\/path\/to\/workspace/i), { target: { value: '/tmp/ws' } });
    fireEvent.change(screen.getByPlaceholderText(/default/i), { target: { value: 'acme' } });
    fireEvent.change(runtimeInput!, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('checkbox'));
    const goalTurnsInput = screen.getByPlaceholderText(/e\.g\. 10/i);
    fireEvent.change(goalTurnsInput, { target: { value: '7' } });

    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
    await waitFor(() =>
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
      }),
    );
  });

  it('moves task status from detail sheet', async () => {
    vi.mocked(restMock.kanbanUpdateTask).mockResolvedValue({ id: 't-1', title: 'Task 1', status: 'done', createdAt: Date.now() });
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Task 1'));
    await waitFor(() => expect(screen.getByLabelText(/Add comment/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'done' } });
    await waitFor(() => expect(restMock.kanbanUpdateTask).toHaveBeenCalledWith('main', 't-1', { status: 'done' }));
  });

  it('hands a task to another bot from the detail sheet, or leaves it unassigned', async () => {
    vi.mocked(restMock.kanbanUpdateTask).mockResolvedValue({ id: 't-1', title: 'Task 1', status: 'ready', createdAt: Date.now() });
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Task 1'));
    await waitFor(() => expect(screen.getByLabelText('Assignee')).toBeInTheDocument());
    const picker = screen.getByLabelText('Assignee') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['— Unassigned —', 'Default', 'Dev']);
    fireEvent.change(picker, { target: { value: 'dev' } });
    await waitFor(() => expect(restMock.kanbanUpdateTask).toHaveBeenCalledWith('main', 't-1', { assignee: 'dev' }));
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: '' } });
    await waitFor(() => expect(restMock.kanbanUpdateTask).toHaveBeenCalledWith('main', 't-1', { assignee: '' }));
  });

  it('restores the last selected board from localStorage', async () => {
    localStorage.setItem('hermes-kanban-board', 'other');
    vi.mocked(restMock.kanbanBoards).mockResolvedValue([
      { id: 'b-1', slug: 'main', name: 'Main', taskCount: 1 },
      { id: 'b-2', slug: 'other', name: 'Other', taskCount: 1 },
    ] as Board[]);
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(restMock.kanbanBoard).toHaveBeenCalledWith('other'));
  });

  it('creates a board from the selector menu', async () => {
    vi.mocked(restMock.kanbanCreateBoard).mockResolvedValue({ slug: 'new-board', name: 'New Board', taskCount: 0 });
    vi.mocked(restMock.kanbanBoard).mockImplementation((slug: string) =>
      Promise.resolve(
        slug === 'new-board'
          ? { slug: 'new-board', name: 'New Board', columns: [] }
          : boardDetail,
      ),
    );
    render(<Projects rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Task 1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Main/i }));
    fireEvent.click(screen.getByText(/Create new board/i));
    fireEvent.change(screen.getByPlaceholderText(/Board name/i), { target: { value: 'New Board' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
    await waitFor(() =>
      expect(restMock.kanbanCreateBoard).toHaveBeenCalledWith({ slug: 'new-board', name: 'New Board', switch: true }),
    );
  });
});
