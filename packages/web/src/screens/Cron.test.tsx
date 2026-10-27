import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Cron } from './Cron';
import {
  useCronStore,
  useConnectionStore,
  useProfilesStore,
  type CronJob,
  type CronDeliveryTarget,
} from '@hermes-pwa/core';

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
  cronJobs: vi.fn(),
  cronJobDetail: vi.fn(),
  cronJobRuns: vi.fn(),
  cronCreateJob: vi.fn(),
  cronUpdateJob: vi.fn(),
  cronPauseJob: vi.fn(),
  cronResumeJob: vi.fn(),
  cronTriggerJob: vi.fn(),
  cronDeleteJob: vi.fn(),
  cronDeliveryTargets: vi.fn(),
  profileList: vi.fn(),
  profileActive: vi.fn(),
  profileActivate: vi.fn(),
  systemStats: vi.fn(),
  opsRun: vi.fn(),
  opsCheckpoints: vi.fn(),
  opsBackups: vi.fn(),
  profileSessions: vi.fn(),
  sessionMessages: vi.fn(),
  sessionArtifacts: vi.fn(),
  envList: vi.fn(),
  mcpServers: vi.fn(),
  mcpToggle: vi.fn(),
  skillsList: vi.fn(),
} as unknown as import('@hermes-pwa/core').RestClient;

const deliveryTargets: CronDeliveryTarget[] = [
  { id: 'local', name: 'Local', homeTargetSet: true, homeEnvVar: null },
];

const jobs: CronJob[] = [
  {
    id: 'job-1',
    profile: 'default',
    name: 'Daily backup',
    expression: '0 3 * * *',
    enabled: true,
    nextRun: Date.now() + 10000,
  },
  {
    id: 'job-2',
    profile: 'default',
    name: 'Health check',
    expression: '*/5 * * * *',
    enabled: false,
  },
];

describe('Cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ state: 'connected', error: undefined, user: undefined });
    useCronStore.setState({
      jobs: [],
      deliveryTargets: [],
      selectedProfile: 'all',
      loading: false,
      actionLoading: null,
      error: undefined,
    });
    useProfilesStore.setState({
      profiles: [{ name: 'default', displayName: 'Default', model: 'GPT-5.5', isActive: true }],
      activeName: 'default',
      currentName: 'default',
      loading: false,
      error: undefined,
    });
    vi.mocked(restMock.cronJobs).mockResolvedValue(jobs);
    vi.mocked(restMock.cronDeliveryTargets).mockResolvedValue(deliveryTargets);
    vi.mocked(restMock.profileList).mockResolvedValue([
      { name: 'default', displayName: 'Default', model: 'GPT-5.5', isActive: true },
    ]);
    vi.mocked(restMock.profileActive).mockResolvedValue({ active: 'default', current: 'default' });
  });

  it('renders cron jobs', async () => {
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Daily backup')).toBeInTheDocument());
    expect(screen.getByText('Health check')).toBeInTheDocument();
  });

  it('shows empty state when no jobs', async () => {
    vi.mocked(restMock.cronJobs).mockResolvedValue([]);
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText(/No cron jobs/i)).toBeInTheDocument());
  });

  it('pauses an enabled job', async () => {
    vi.mocked(restMock.cronPauseJob).mockResolvedValue({ ...jobs[0]!, enabled: false });
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Daily backup')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(restMock.cronPauseJob).toHaveBeenCalledWith('job-1', 'default'));
  });

  it('resumes a paused job', async () => {
    vi.mocked(restMock.cronResumeJob).mockResolvedValue({ ...jobs[1]!, enabled: true });
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Health check')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(restMock.cronResumeJob).toHaveBeenCalledWith('job-2', 'default'));
  });

  it('triggers a job run', async () => {
    vi.mocked(restMock.cronTriggerJob).mockResolvedValue(jobs[0]!);
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Daily backup')).toBeInTheDocument());
    fireEvent.click(screen.getAllByLabelText('Run now')[0]!);
    await waitFor(() => expect(restMock.cronTriggerJob).toHaveBeenCalledWith('job-1', 'default'));
  });

  it('deletes a job after confirm', async () => {
    vi.mocked(restMock.cronDeleteJob).mockResolvedValue({ ok: true });
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Daily backup')).toBeInTheDocument());
    vi.mocked(restMock.cronJobs).mockResolvedValue([jobs[1]!]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    expect(restMock.cronDeleteJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete job' }));
    await waitFor(() => expect(restMock.cronDeleteJob).toHaveBeenCalledWith('job-1', 'default'));
  });

  it('creates a job from the sheet', async () => {
    vi.mocked(restMock.cronCreateJob).mockResolvedValue({
      id: 'job-3',
      profile: 'default',
      name: 'New job',
      expression: 'every 30m',
      enabled: true,
    });
    vi.mocked(restMock.cronJobs)
      .mockResolvedValueOnce(jobs)
      .mockResolvedValueOnce([
        ...jobs,
        { id: 'job-3', profile: 'default', name: 'New job', expression: 'every 30m', enabled: true },
      ]);
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Daily backup')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('cron-new'));
    fireEvent.change(screen.getByPlaceholderText(/What should the cron job do/i), {
      target: { value: 'Run tests' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
    await waitFor(() =>
      expect(restMock.cronCreateJob).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Run tests', schedule: 'every 30m', deliver: 'local' }),
        'default',
      ),
    );
  });

  it('edits a job from the sheet', async () => {
    vi.mocked(restMock.cronUpdateJob).mockResolvedValue(jobs[0]!);
    render(<Cron rest={restMock} />);
    await waitFor(() => expect(screen.getByText('Daily backup')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    fireEvent.change(screen.getByPlaceholderText(/What should the cron job do/i), { target: { value: 'Back up files' } });
    fireEvent.change(screen.getByDisplayValue('Daily backup'), { target: { value: 'Daily backup v2' } });
    fireEvent.change(screen.getByDisplayValue('0 3 * * *'), { target: { value: '0 4 * * *' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(restMock.cronUpdateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ schedule: '0 4 * * *', name: 'Daily backup v2', prompt: 'Back up files' }),
        'default',
      ),
    );
  });
});
