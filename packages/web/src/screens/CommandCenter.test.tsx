import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CommandCenter } from './CommandCenter';
import { HERMES_PWA_RELEASE_VERSION } from '../app/version';

const VERSION_RE = new RegExp(`PWA\\s+${HERMES_PWA_RELEASE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const makeRest = (overrides = {}) => ({
  systemStats: vi.fn().mockResolvedValue({
    pid: 1234,
    uptimeSeconds: 7200,
    cpuPercent: 12.5,
    memoryUsedMb: 512,
    memoryTotalMb: 2048,
    memoryPercent: 25,
    diskUsedMb: 64 * 1024,
    diskTotalMb: 128 * 1024,
    diskPercent: 50,
    activeSessions: 3,
    version: 'v0.9.0',
  }),
  opsRun: vi.fn().mockResolvedValue({ ok: true, name: 'doctor', pid: 4567 }),
  gatewayAction: vi.fn().mockResolvedValue({ ok: true, name: 'gateway-restart', pid: 4568 }),
  actionStatus: vi.fn().mockResolvedValue({
    name: 'doctor',
    running: false,
    exitCode: 0,
    pid: 4567,
    lines: ['=== doctor started ===', 'doctor ok'],
  }),
  opsCheckpoints: vi.fn().mockResolvedValue([]),
  opsBackups: vi.fn().mockResolvedValue([
    { id: 'backup-state', name: 'hermes-pwa-state-20260611T184500Z', createdAt: Date.now(), sizeMb: 31.1, kind: 'directory' },
    { id: 'backup-archive', name: 'before-hermes-pwa-redesign-20260611T184500Z.zip', createdAt: Date.now() - 5000, sizeMb: 251.6, kind: 'archive' },
  ]),
  ...overrides,
}) as unknown as import('@hermes-pwa/core').RestClient;

describe('CommandCenter', () => {
  it('shows gateway card with stats', async () => {
    render(<CommandCenter rest={makeRest()} />);
    await waitFor(() => expect(screen.getByTestId('gateway-card')).toBeInTheDocument());
    expect(screen.getByText(/pid 1234/i)).toBeInTheDocument();
    expect(screen.getByText(/3 live/i)).toBeInTheDocument();
    expect(screen.getByText(VERSION_RE)).toBeInTheDocument();
    expect(screen.getByText(/backend v0\.9\.0/)).toBeInTheDocument();
  });

  it('shows CPU, RAM, and disk resource chips', async () => {
    render(<CommandCenter rest={makeRest()} />);
    await waitFor(() => expect(screen.getByText('CPU')).toBeInTheDocument());
    expect(screen.getByText('RAM')).toBeInTheDocument();
    expect(screen.getByText('Disk')).toBeInTheDocument();
    expect(screen.getByText(/12\.5%/)).toBeInTheDocument();
    expect(screen.getByText(/25\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/50\.0%/)).toBeInTheDocument();
  });

  it('runs doctor op in a terminal modal and shows CLI output', async () => {
    const rest = makeRest();
    render(<CommandCenter rest={rest} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Doctor' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Doctor' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Doctor terminal/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('terminal-output')).toHaveTextContent('doctor ok'));
    expect(rest.opsRun).toHaveBeenCalledWith('doctor');
    expect(rest.actionStatus).toHaveBeenCalledWith('doctor', 800);
  });

  it('runs security audit through the terminal action path', async () => {
    const rest = makeRest({
      opsRun: vi.fn().mockResolvedValue({ ok: true, name: 'security-audit', pid: 4569 }),
      actionStatus: vi.fn().mockResolvedValue({
        name: 'security-audit',
        running: false,
        exitCode: 0,
        pid: 4569,
        lines: ['security-audit ok'],
      }),
    });
    render(<CommandCenter rest={rest} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Security audit' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Security audit' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Security audit terminal/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('terminal-output')).toHaveTextContent('security-audit ok'));
    expect(rest.opsRun).toHaveBeenCalledWith('security-audit');
  });

  it('shows backups collapsed by default, summarizes archives, and expands the adaptive list', async () => {
    render(<CommandCenter rest={makeRest()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Backups/i })).toBeInTheDocument());
    expect(screen.getByText(/Latest archive/i)).toBeInTheDocument();
    expect(screen.getByText(/251\.6 MB/i)).toBeInTheDocument();
    expect(screen.queryByTestId('backup-list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Backups/i }));
    await waitFor(() => expect(screen.getByTestId('backup-list')).toBeInTheDocument());
    expect(screen.getByText('before-hermes-pwa-redesign-20260611T184500Z.zip')).toBeInTheDocument();
    expect(screen.getByText('hermes-pwa-state-20260611T184500Z')).toBeInTheDocument();
    expect(screen.getByText('directory')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore hermes-pwa-state-20260611T184500Z/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/restore pending/i).length).toBeGreaterThan(0);
  });

  it('creates a new backup from the Backups panel', async () => {
    const rest = makeRest({
      opsRun: vi.fn().mockResolvedValue({ ok: true, name: 'backup', pid: 4570 }),
      actionStatus: vi.fn().mockResolvedValue({
        name: 'backup',
        running: false,
        exitCode: 0,
        pid: 4570,
        lines: ['backup ok'],
      }),
    });
    render(<CommandCenter rest={rest} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Create new backup/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Create new backup/i }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Backup terminal/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('terminal-output')).toHaveTextContent('backup ok'));
    expect(rest.opsRun).toHaveBeenCalledWith('backup');
  });

  it('confirms and starts gateway restart in the terminal modal', async () => {
    const rest = makeRest({
      actionStatus: vi.fn().mockResolvedValue({
        name: 'gateway-restart',
        running: false,
        exitCode: 0,
        pid: 4568,
        lines: ['gateway restart ok'],
      }),
    });
    render(<CommandCenter rest={rest} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Restart gateway/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Restart gateway/i }));
    expect(rest.gatewayAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart gateway' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Restart gateway terminal/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('terminal-output')).toHaveTextContent('gateway restart ok'));
    expect(rest.gatewayAction).toHaveBeenCalledWith('restart');
  });

  it('shows error on load failure', async () => {
    const rest = makeRest({ systemStats: vi.fn().mockRejectedValue(new Error('network error')) });
    render(<CommandCenter rest={rest} />);
    await waitFor(() => expect(screen.getByText(/network error/)).toBeInTheDocument());
  });
});
