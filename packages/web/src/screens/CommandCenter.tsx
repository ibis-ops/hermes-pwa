import { useCallback, useEffect, useState } from 'react';
import type {
  SystemActionStatus,
  Checkpoint as DomainCheckpoint,
  OpsRunResult,
  RestClient,
  SystemStats as DomainSystemStats,
} from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { HERMES_PWA_VERSION_LABEL } from '../app/version';

interface SystemScreenProps {
  rest: RestClient;
}

interface SystemStats {
  cpuPercent: number | undefined;
  memoryMb: number | undefined;
  memoryTotalMb: number | undefined;
  memoryPercent: number | undefined;
  diskUsedMb: number | undefined;
  diskTotalMb: number | undefined;
  diskFreeMb: number | undefined;
  diskPercent: number | undefined;
  uptimeSeconds: number | undefined;
  hostUptimeSeconds: number | undefined;
  pid: number | undefined;
  activeSessions: number | undefined;
  platforms: string[] | undefined;
  version: string | undefined;
}

interface BackupEntry {
  id: string;
  name: string;
  createdAt: number | undefined;
  sizeMb: number | undefined;
  kind: string | undefined;
}

type OpsKey = 'doctor' | 'security-audit' | 'backup';

type TerminalState = {
  open: boolean;
  title: string;
  command: string;
  actionName?: string | undefined;
  running: boolean;
  lines: string[];
  pid?: number | null | undefined;
  exitCode?: number | null | undefined;
  error?: string | undefined;
};

function fmtUptime(s: number | undefined): string {
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtGb(mb: number | undefined): string {
  if (mb == null) return '—';
  return `${(mb / 1024).toFixed(1)} GB`;
}

function fmtMb(mb: number | undefined): string {
  if (mb == null) return '—';
  if (mb >= 1024) return fmtGb(mb);
  return `${mb.toFixed(1)} MB`;
}

function fmtPercent(value: number | undefined): string {
  return value == null ? '—' : `${value.toFixed(1)}%`;
}

function fmtDate(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts > 10_000_000_000 ? ts : ts * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return `today · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (diffDays === 1) return 'yesterday';
  return `${diffDays}d ago`;
}

function parseStats(raw: DomainSystemStats): SystemStats {
  return {
    cpuPercent: raw.cpuPercent,
    memoryMb: raw.memoryUsedMb,
    memoryTotalMb: raw.memoryTotalMb,
    memoryPercent: raw.memoryPercent,
    diskUsedMb: raw.diskUsedMb,
    diskTotalMb: raw.diskTotalMb,
    diskFreeMb: raw.diskFreeMb,
    diskPercent: raw.diskPercent,
    uptimeSeconds: raw.uptimeSeconds,
    hostUptimeSeconds: raw.hostUptimeSeconds,
    pid: raw.pid,
    activeSessions: raw.activeSessions,
    platforms: undefined,
    version: raw.version,
  };
}

function backupSortRank(item: BackupEntry): number {
  if (item.kind === 'archive') return 0;
  if (item.kind === 'directory') return 1;
  return 2;
}

function parseBackups(raw: DomainCheckpoint[]): BackupEntry[] {
  return raw
    .map((item) => ({
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      sizeMb: item.sizeMb,
      kind: item.kind,
    }))
    .sort((a, b) => backupSortRank(a) - backupSortRank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

interface OpDef {
  key: OpsKey;
  label: string;
  icon: 'shield' | 'alert' | 'archive';
  iconBg: string;
  iconColor: string;
  runLabel: string;
  command: string;
  defaultDetail: string;
  warning?: boolean;
}

const BACKUP_OP: OpDef = {
  key: 'backup',
  label: 'Backup',
  icon: 'archive',
  iconBg: 'var(--hm-color-primary-tint)',
  iconColor: 'var(--hm-color-primary)',
  runLabel: 'Back up',
  command: 'hermes backup',
  defaultDetail: 'Create a Hermes backup archive',
};

const OPS: OpDef[] = [
  {
    key: 'doctor',
    label: 'Doctor',
    icon: 'shield',
    iconBg: 'var(--hm-color-success-bg)',
    iconColor: 'var(--hm-color-success-strong)',
    runLabel: 'Run',
    command: 'hermes doctor',
    defaultDetail: 'Run Hermes CLI health checks',
  },
  {
    key: 'security-audit',
    label: 'Security audit',
    icon: 'alert',
    iconBg: 'var(--hm-color-warning-bg)',
    iconColor: 'var(--hm-color-warning-strong)',
    runLabel: 'Run',
    command: 'hermes security audit',
    defaultDetail: 'Run local security checks',
    warning: true,
  },
];

function terminalFromStatus(previous: TerminalState, status: SystemActionStatus): TerminalState {
  return {
    ...previous,
    actionName: status.name || previous.actionName,
    running: status.running,
    pid: status.pid,
    exitCode: status.exitCode,
    lines: status.lines.length > 0 ? status.lines : previous.lines,
  };
}

function fallbackLines(command: string, result: OpsRunResult): string[] {
  const lines = [`$ ${command}`];
  if (result.pid != null) lines.push(`started pid ${result.pid}`);
  if (result.message) lines.push(result.message);
  else if (result.status) lines.push(result.status);
  else if (result.ok === true) lines.push('Started. Waiting for action log…');
  else lines.push('Started.');
  return lines;
}

export function CommandCenter({ rest }: SystemScreenProps) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [opsResult, setOpsResult] = useState<Record<string, string>>({});
  const [opsRunning, setOpsRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [terminal, setTerminal] = useState<TerminalState | null>(null);
  const [pollAction, setPollAction] = useState<string | null>(null);

  const refreshSystem = useCallback(async () => {
    const [raw, backupRows] = await Promise.all([
      rest.systemStats(),
      rest.opsBackups().catch(() => []),
    ]);
    setStats(parseStats(raw));
    setBackups(parseBackups(backupRows));
  }, [rest]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshSystem();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshSystem]);

  useEffect(() => {
    if (!pollAction) return undefined;
    const actionName = pollAction;
    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const status = await rest.actionStatus(actionName, 800);
        if (cancelled) return;
        setTerminal((prev) => (prev ? terminalFromStatus(prev, status) : prev));
        if (status.running) {
          timer = window.setTimeout(() => void poll(), 1000);
        } else {
          setPollAction(null);
          setOpsRunning(null);
          void refreshSystem().catch(() => undefined);
        }
      } catch (err) {
        if (cancelled) return;
        setTerminal((prev) => prev
          ? { ...prev, running: false, error: err instanceof Error ? err.message : 'Failed to read action log' }
          : prev);
        setPollAction(null);
        setOpsRunning(null);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [pollAction, refreshSystem, rest]);

  async function startTerminalAction(
    title: string,
    command: string,
    start: () => Promise<OpsRunResult>,
    runningKey?: string,
  ) {
    setOpsRunning(runningKey ?? title);
    setTerminal({
      open: true,
      title,
      command,
      running: true,
      lines: [`$ ${command}`, 'starting…'],
    });
    try {
      const result = await start();
      const actionName = result.name ?? runningKey;
      if (actionName) {
        setTerminal((prev) => prev
          ? {
              ...prev,
              actionName,
              pid: result.pid,
              lines: fallbackLines(command, result),
            }
          : prev);
        setPollAction(actionName);
      } else {
        setTerminal((prev) => prev
          ? {
              ...prev,
              running: false,
              pid: result.pid,
              lines: fallbackLines(command, result),
            }
          : prev);
        setOpsRunning(null);
      }
    } catch (err) {
      setTerminal((prev) => prev
        ? {
            ...prev,
            running: false,
            error: err instanceof Error ? err.message : 'Action failed',
            lines: [...prev.lines, err instanceof Error ? err.message : 'Action failed'],
          }
        : prev);
      setOpsRunning(null);
    }
  }

  async function runOp(op: OpDef) {
    setOpsResult((prev) => ({ ...prev, [op.key]: 'Running in terminal…' }));
    await startTerminalAction(op.label, op.command, () => rest.opsRun(op.key), op.key);
  }

  async function runBackup() {
    setBackupsOpen(true);
    await runOp(BACKUP_OP);
  }

  async function runGatewayAction(action: 'restart' | 'stop') {
    const label = action === 'restart' ? 'Restart gateway' : 'Stop gateway';
    const command = `hermes gateway ${action}`;
    const ok = window.confirm(`${label}? This affects live messaging gateway runtime.`);
    if (!ok) return;
    await startTerminalAction(label, command, () => rest.gatewayAction(action), `gateway-${action}`);
  }

  function closeTerminal() {
    setTerminal((prev) => (prev ? { ...prev, open: false } : prev));
  }

  if (loading) {
    return (
      <div className="hm-command">
        <p className="hm-muted hm-loading">Loading system info…</p>
      </div>
    );
  }

  const latestArchive = backups.find((backup) => backup.kind === 'archive');
  const latestBackup = latestArchive ?? backups[0];
  const backupSummary = latestBackup
    ? `${latestArchive ? 'Latest archive' : 'Latest artifact'} ${fmtDate(latestBackup.createdAt) || '—'} · ${fmtMb(latestBackup.sizeMb)}`
    : 'No backups found';

  return (
    <div className="hm-command hm-scroll">
      {error && <div className="hm-warning-banner hm-warning-banner--error">{error}</div>}

      <div className="hm-command__gateway-card" data-testid="gateway-card">
        <div className="hm-command__gateway-head">
          <span className="hm-command__gateway-status-dot" aria-hidden="true" />
          <span className="hm-command__gateway-label">Gateway running</span>
          {stats?.pid != null && (
            <span className="hm-command__gateway-pid">pid {stats.pid}</span>
          )}
        </div>
        <div className="hm-command__gateway-stats">
          <div>
            <div className="hm-command__gateway-stat-label">gateway uptime</div>
            <div className="hm-command__gateway-stat-value">{fmtUptime(stats?.uptimeSeconds)}</div>
          </div>
          <div>
            <div className="hm-command__gateway-stat-label">platforms</div>
            <div className="hm-command__gateway-stat-value">
              {stats?.platforms && stats.platforms.length > 0 ? stats.platforms.join(', ') : '—'}
            </div>
          </div>
          <div>
            <div className="hm-command__gateway-stat-label">sessions</div>
            <div className="hm-command__gateway-stat-value">
              {stats?.activeSessions != null ? `${stats.activeSessions} live` : '—'}
            </div>
          </div>
        </div>
        <div className="hm-command__gateway-actions">
          <button
            className="hm-command__gw-btn"
            aria-label="Restart gateway"
            onClick={() => void runGatewayAction('restart')}
            disabled={opsRunning === 'gateway-restart'}
          >
            {opsRunning === 'gateway-restart' ? '…' : 'Restart'}
          </button>
          <button
            className="hm-command__gw-btn hm-command__gw-btn--danger"
            aria-label="Stop gateway"
            onClick={() => void runGatewayAction('stop')}
            disabled={opsRunning === 'gateway-stop'}
          >
            {opsRunning === 'gateway-stop' ? '…' : 'Stop'}
          </button>
        </div>
      </div>

      {(stats?.cpuPercent != null || stats?.memoryMb != null || stats?.diskUsedMb != null) && (
        <div className="hm-command__resources">
          {stats!.cpuPercent != null && (
            <div className="hm-command__resource-chip">
              <span className="hm-command__resource-label">CPU</span>
              <span className="hm-command__resource-value">{fmtPercent(stats!.cpuPercent)}</span>
              <span className="hm-command__resource-detail">current load</span>
            </div>
          )}
          {stats!.memoryMb != null && (
            <div className="hm-command__resource-chip">
              <span className="hm-command__resource-label">RAM</span>
              <span className="hm-command__resource-value">{fmtPercent(stats!.memoryPercent)}</span>
              <span className="hm-command__resource-detail">
                {fmtGb(stats!.memoryMb)} / {fmtGb(stats!.memoryTotalMb)} used
              </span>
            </div>
          )}
          {stats!.diskUsedMb != null && (
            <div className="hm-command__resource-chip">
              <span className="hm-command__resource-label">Disk</span>
              <span className="hm-command__resource-value">{fmtPercent(stats!.diskPercent)}</span>
              <span className="hm-command__resource-detail">
                {fmtGb(stats!.diskUsedMb)} / {fmtGb(stats!.diskTotalMb)} used
              </span>
            </div>
          )}
        </div>
      )}

      <div className="hm-command__ops-list">
        {OPS.map((op) => (
          <div key={op.key} className="hm-command__op-row">
            <span
              className="hm-command__op-icon"
              style={{ background: op.iconBg, color: op.iconColor }}
              aria-hidden="true"
            >
              <Icon name={op.icon} size={18} />
            </span>
            <div className="hm-command__op-body">
              <span className="hm-command__op-label">{op.label}</span>
              <span className={`hm-command__op-detail ${op.warning && !opsResult[op.key] ? 'hm-command__op-detail--warning' : 'hm-muted'}`}>
                {opsResult[op.key] || op.defaultDetail}
              </span>
            </div>
            <button
              className={`hm-command__op-btn ${op.key === 'backup' ? 'hm-command__op-btn--primary' : ''}`}
              onClick={() => void runOp(op)}
              disabled={opsRunning === op.key}
              aria-label={op.label}
            >
              {opsRunning === op.key ? '…' : op.runLabel}
            </button>
          </div>
        ))}
      </div>

      <section className={`hm-command__section hm-command__backups ${backupsOpen ? 'hm-command__backups--open' : ''}`}>
        <div className="hm-command__backups-head">
          <button
            type="button"
            className="hm-command__backups-toggle"
            aria-expanded={backupsOpen}
            onClick={() => setBackupsOpen((open) => !open)}
          >
            <span className="hm-command__backups-title">Backups</span>
            <span className="hm-command__backups-count">{backups.length}</span>
            <span className="hm-command__backups-summary">{backupSummary}</span>
            <span className="hm-command__backups-chevron" aria-hidden="true">{backupsOpen ? '⌃' : '⌄'}</span>
          </button>
          <button
            type="button"
            className="hm-command__backup-new"
            onClick={() => void runBackup()}
            disabled={opsRunning === 'backup'}
            aria-label="Create new backup"
          >
            {opsRunning === 'backup' ? 'Creating…' : 'New backup'}
          </button>
        </div>

        {backupsOpen && (
          <div className="hm-command__checkpoint-list" data-testid="backup-list">
            {backups.length === 0 ? (
              <div className="hm-command__backup-empty">No backups found yet. Use New backup to create one.</div>
            ) : backups.map((backup) => (
              <div key={backup.id} className="hm-command__checkpoint-row hm-command__backup-row">
                <span className="hm-command__checkpoint-id" title={backup.name}>{backup.name}</span>
                <span className="hm-command__checkpoint-when">{fmtDate(backup.createdAt)}</span>
                {backup.kind && <span className="hm-command__checkpoint-kind">{backup.kind}</span>}
                {backup.sizeMb != null && <span className="hm-command__checkpoint-size">{fmtMb(backup.sizeMb)}</span>}
                <span className="hm-command__backup-restore-note">restore pending</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="hm-command__versions">
        <span className="hm-command__version-chip">PWA {HERMES_PWA_VERSION_LABEL}</span>
        {stats?.version && <span className="hm-command__version-chip">backend {stats.version}</span>}
      </div>

      {terminal?.open && (
        <div className="hm-sheet hm-command__terminal" role="dialog" aria-modal="true" aria-label={`${terminal.title} terminal`}>
          <button className="hm-sheet__overlay" onClick={closeTerminal} aria-label="Close terminal" />
          <div className="hm-sheet__content hm-command__terminal-content">
            <div className="hm-command__terminal-head">
              <div>
                <h3 className="hm-sheet__title">{terminal.title}</h3>
                <div className="hm-command__terminal-meta">
                  {terminal.running ? 'running' : terminal.exitCode === 0 ? 'completed' : terminal.error ? 'error' : 'finished'}
                  {terminal.pid != null ? ` · pid ${terminal.pid}` : ''}
                  {terminal.exitCode != null ? ` · exit ${terminal.exitCode}` : ''}
                </div>
              </div>
              <button type="button" className="hm-ghost" onClick={closeTerminal}>Close</button>
            </div>
            {terminal.error && <div className="hm-warning-banner hm-warning-banner--error">{terminal.error}</div>}
            <pre className="hm-command__terminal-output" data-testid="terminal-output">
              {terminal.lines.join('\n')}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
