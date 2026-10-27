import { useEffect, useMemo, useState } from 'react';
import {
  useCronStore,
  useProfilesStore,
  useConnectionStore,
  DEFAULT_SCHEDULE_STATE,
  buildScheduleString,
  describeSchedule,
  ENGLISH_SCHEDULE_STRINGS,
} from '@hermes-pwa/core';
import type { CronJob, CronJobRun, RestClient, ScheduleBuilderState } from '@hermes-pwa/core';
import { Icon } from '../components/Icon';
import { ScheduleBuilder } from '../components/ScheduleBuilder';
import { BottomSheet } from '../components/BottomSheet';
import { SkeletonRows } from '../components/Skeleton';

interface CronProps {
  rest: RestClient;
}

type SheetMode =
  | { mode: 'create' }
  | { mode: 'edit'; job: CronJob }
  | { mode: 'detail'; job: CronJob };

function formatTime(ts: string | number | undefined): string {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'string' ? ts : ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getJobTitle(job: CronJob): string {
  if (job.name) return job.name;
  if (job.prompt) return job.prompt.slice(0, 60) + (job.prompt.length > 60 ? '…' : '');
  if (job.script) return job.script.slice(0, 60) + (job.script.length > 60 ? '…' : '');
  return job.id || 'Cron job';
}

function isPaused(job: CronJob): boolean {
  return job.state === 'paused' || !job.enabled;
}

export function Cron({ rest }: CronProps) {
  const connection = useConnectionStore();
  const profiles = useProfilesStore();
  const loadProfiles = useProfilesStore((state) => state.load);
  const {
    jobs,
    deliveryTargets,
    selectedProfile,
    loading,
    actionLoading,
    error,
    setProfile,
    loadJobs,
    loadDeliveryTargets,
    createJob,
    updateJob,
    deleteJob,
    pauseJob,
    resumeJob,
    triggerJob,
    loadJobRuns,
  } = useCronStore();

  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [runs, setRuns] = useState<CronJobRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const [createForm, setCreateForm] = useState<{
    name: string;
    prompt: string;
    schedule: ScheduleBuilderState;
    deliver: string;
    profile: string;
  }>({
    name: '',
    prompt: '',
    schedule: DEFAULT_SCHEDULE_STATE,
    deliver: 'local',
    profile: 'default',
  });

  const [editForm, setEditForm] = useState<{
    name: string;
    prompt: string;
    schedule: string;
    deliver: string;
  }>({
    name: '',
    prompt: '',
    schedule: '',
    deliver: 'local',
  });

  useEffect(() => {
    if (connection.state === 'connected') {
      void loadJobs(rest);
      void loadDeliveryTargets(rest);
      void loadProfiles(rest);
    }
  }, [connection.state, rest, loadJobs, loadDeliveryTargets, loadProfiles]);

  useEffect(() => {
    if (connection.state === 'connected') {
      void loadJobs(rest);
    }
  }, [selectedProfile, rest, loadJobs, connection.state]);

  const scheduleString = useMemo(() => buildScheduleString(createForm.schedule), [createForm.schedule]);

  const profileOptions = useMemo(
    () => [{ name: 'all', displayName: 'All profiles' }, ...profiles.profiles],
    [profiles.profiles],
  );

  const deliverOptions = useMemo(() => {
    if (deliveryTargets.length === 0) {
      return [{ id: 'local', name: 'Local', homeTargetSet: true, homeEnvVar: null }];
    }
    return deliveryTargets;
  }, [deliveryTargets]);

  function openCreate() {
    const defaultProfile =
      selectedProfile === 'all'
        ? (profiles.currentName ?? profiles.activeName ?? 'default')
        : selectedProfile;
    setCreateForm({
      name: '',
      prompt: '',
      schedule: DEFAULT_SCHEDULE_STATE,
      deliver: 'local',
      profile: defaultProfile,
    });
    setSheet({ mode: 'create' });
  }

  function openEdit(job: CronJob) {
    setEditForm({
      name: job.name ?? '',
      prompt: job.prompt ?? '',
      schedule: job.schedule?.expr ?? job.expression ?? '',
      deliver: job.deliver ?? 'local',
    });
    setSheet({ mode: 'edit', job });
  }

  async function openDetail(job: CronJob) {
    setSheet({ mode: 'detail', job });
    setRunsLoading(true);
    const result = await loadJobRuns(rest, job.id, job.profile);
    setRuns(result);
    setRunsLoading(false);
  }

  function closeSheet() {
    setSheet(null);
    setRuns([]);
  }

  async function handleCreate() {
    if (!createForm.prompt.trim() || !scheduleString) return;
    await createJob(rest, {
      prompt: createForm.prompt,
      schedule: scheduleString,
      name: createForm.name,
      deliver: createForm.deliver,
      profile: createForm.profile,
    });
    closeSheet();
  }

  async function handleUpdate() {
    if (!sheet || sheet.mode !== 'edit') return;
    if (!editForm.prompt.trim() || !editForm.schedule.trim()) return;
    await updateJob(rest, sheet.job.id, {
      prompt: editForm.prompt,
      schedule: editForm.schedule,
      name: editForm.name,
      deliver: editForm.deliver,
      profile: sheet.job.profile,
    });
    closeSheet();
  }

  async function handleDelete(job: CronJob) {
    if (!confirm(`Delete job "${getJobTitle(job)}"?`)) return;
    await deleteJob(rest, job.id, job.profile);
  }

  async function handlePauseResume(job: CronJob) {
    if (isPaused(job)) {
      await resumeJob(rest, job.id, job.profile);
    } else {
      await pauseJob(rest, job.id, job.profile);
    }
  }

  async function handleTrigger(job: CronJob) {
    await triggerJob(rest, job.id, job.profile);
  }

  function deliverLabel(targetId: string): string {
    const target = deliverOptions.find((t) => t.id === targetId);
    if (!target) return targetId;
    if (target.id === 'local') return target.name;
    if (!target.homeTargetSet) return `${target.name} — set home channel first`;
    return target.name;
  }

  if (connection.state === 'init' || connection.state === 'login' || connection.state === 'offline') {
    return (
      <div className="hm-empty-state">
        <p>Connecting to Hermes…</p>
        <p className="hm-muted">{connection.error ?? 'Please wait.'}</p>
      </div>
    );
  }

  return (
    <div className="hm-cron">
      <div className="hm-cron__topbar">
        <select
          className="hm-select hm-cron__profile"
          value={selectedProfile}
          onChange={(e) => setProfile(e.target.value)}
          aria-label="Profile filter"
        >
          {profileOptions.map((p) => (
            <option key={p.name} value={p.name}>
              {p.displayName ?? p.name}
            </option>
          ))}
        </select>
        <button type="button" className="hm-primary hm-cron__create" onClick={openCreate} data-testid="cron-new">
          <Icon name="plus" size={14} /> New
        </button>
      </div>

      {error && <div className="hm-warning-banner hm-warning-banner--error">{error}</div>}
      {loading && jobs.length === 0 && <SkeletonRows rows={4} label="Loading cron jobs" />}

      <div className="hm-cron__list">
        {jobs.length === 0 && !loading && (
          <div className="hm-empty-state hm-empty-state--inline">
            <p className="hm-body-semibold">No cron jobs</p>
            <p className="hm-muted">Tap New to schedule one.</p>
          </div>
        )}

        {jobs.map((job) => {
          const title = getJobTitle(job);
          const paused = isPaused(job);
          const scheduleText = describeSchedule(
            job.schedule,
            job.scheduleDisplay ?? job.expression,
            ENGLISH_SCHEDULE_STRINGS,
          );
          return (
            <div key={`${job.profile}:${job.id}`} className="hm-cron-card">
              <button
                type="button"
                className="hm-cron-card__main"
                onClick={() => openDetail(job)}
                aria-label={`Open ${title}`}
              >
                <div className="hm-cron-card__header">
                  <Icon name="cron" size={18} />
                  <span className="hm-cron-card__title">{title}</span>
                  <span className={`hm-badge ${paused ? 'hm-badge--pending' : 'hm-badge--pass'}`}>
                    {paused ? 'paused' : job.state ?? 'scheduled'}
                  </span>
                  <span className="hm-badge">{job.profile}</span>
                </div>
                <div className="hm-cron-card__meta">
                  <span className="hm-mono hm-muted">{scheduleText}</span>
                  <span className="hm-muted">next {formatTime(job.nextRun)}</span>
                  <span className="hm-muted">last {formatTime(job.lastRun)}</span>
                </div>
                {job.lastError && <p className="hm-cron-card__error">{job.lastError}</p>}
              </button>

              <div className="hm-cron-card__actions">
                <button
                  type="button"
                  className={`hm-cron-card__action ${paused ? 'hm-cron-card__action--play' : 'hm-cron-card__action--pause'}`}
                  onClick={() => void handlePauseResume(job)}
                  disabled={actionLoading === `pause:${job.id}` || actionLoading === `resume:${job.id}`}
                  aria-label={paused ? 'Resume' : 'Pause'}
                  title={paused ? 'Resume' : 'Pause'}
                >
                  <Icon name={paused ? 'play' : 'pause'} size={14} />
                </button>
                <button
                  type="button"
                  className="hm-cron-card__action"
                  onClick={() => void handleTrigger(job)}
                  disabled={actionLoading === `trigger:${job.id}`}
                  aria-label="Run now"
                  title="Run now"
                >
                  <Icon name="bolt" size={14} />
                </button>
                <button
                  type="button"
                  className="hm-cron-card__action"
                  onClick={() => openEdit(job)}
                  aria-label="Edit"
                  title="Edit"
                >
                  <Icon name="edit" size={14} />
                </button>
                <button
                  type="button"
                  className="hm-cron-card__action hm-cron-card__action--danger"
                  onClick={() => void handleDelete(job)}
                  disabled={actionLoading === `delete:${job.id}`}
                  aria-label="Delete"
                  title="Delete"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {sheet?.mode === 'create' && (
        <BottomSheet
          title="New cron job"
          onClose={closeSheet}
          footer={
            <div className="hm-projects__inline-actions">
              <button
                type="button"
                className="hm-primary hm-projects__inline-save"
                disabled={!createForm.prompt.trim() || !scheduleString || actionLoading === 'create'}
                onClick={() => void handleCreate()}
              >
                Create
              </button>
              <button type="button" className="hm-ghost" onClick={closeSheet}>
                Cancel
              </button>
            </div>
          }
        >
          <div className="hm-projects__field">
            <label className="hm-projects__label">Profile</label>
            <select
              className="hm-select"
              value={createForm.profile}
              onChange={(e) => setCreateForm((f) => ({ ...f, profile: e.target.value }))}
            >
              {profiles.profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.displayName ?? p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Name (optional)</label>
            <input
              type="text"
              className="hm-input"
              placeholder="e.g. Nightly backup"
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Prompt</label>
            <textarea
              className="hm-textarea"
              rows={3}
              placeholder="What should the cron job do?"
              value={createForm.prompt}
              onChange={(e) => setCreateForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Schedule</label>
            <ScheduleBuilder
              value={createForm.schedule}
              onChange={(schedule) => setCreateForm((f) => ({ ...f, schedule }))}
            />
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Deliver to</label>
            <select
              className="hm-select"
              value={createForm.deliver}
              onChange={(e) => setCreateForm((f) => ({ ...f, deliver: e.target.value }))}
            >
              {deliverOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {deliverLabel(t.id)}
                </option>
              ))}
            </select>
            {deliverOptions.length <= 1 && (
              <p className="hm-note">No external delivery targets configured. Jobs will run locally only.</p>
            )}
          </div>
        </BottomSheet>
      )}

      {sheet?.mode === 'edit' && (
        <BottomSheet
          title="Edit cron job"
          onClose={closeSheet}
          footer={
            <div className="hm-projects__inline-actions">
              <button
                type="button"
                className="hm-primary hm-projects__inline-save"
                disabled={
                  !editForm.prompt.trim() ||
                  !editForm.schedule.trim() ||
                  actionLoading === `update:${sheet.job.id}`
                }
                onClick={() => void handleUpdate()}
              >
                Save
              </button>
              <button type="button" className="hm-ghost" onClick={closeSheet}>
                Cancel
              </button>
            </div>
          }
        >
          <div className="hm-projects__field">
            <label className="hm-projects__label">Name</label>
            <input
              type="text"
              className="hm-input"
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Prompt</label>
            <textarea
              className="hm-textarea"
              rows={3}
              placeholder="What should the cron job do?"
              value={editForm.prompt}
              onChange={(e) => setEditForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Schedule</label>
            <input
              type="text"
              className="hm-input hm-mono"
              placeholder="0 9 * * *"
              value={editForm.schedule}
              onChange={(e) => setEditForm((f) => ({ ...f, schedule: e.target.value }))}
            />
          </div>

          <div className="hm-projects__field">
            <label className="hm-projects__label">Deliver to</label>
            <select
              className="hm-select"
              value={editForm.deliver}
              onChange={(e) => setEditForm((f) => ({ ...f, deliver: e.target.value }))}
            >
              {deliverOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {deliverLabel(t.id)}
                </option>
              ))}
            </select>
          </div>
        </BottomSheet>
      )}

      {sheet?.mode === 'detail' && (
        <BottomSheet
          title={getJobTitle(sheet.job)}
          onClose={closeSheet}
          meta={
            <div className="hm-sheet__meta">
              <span className={`hm-badge ${isPaused(sheet.job) ? 'hm-badge--pending' : 'hm-badge--pass'}`}>
                {isPaused(sheet.job) ? 'paused' : sheet.job.state ?? 'scheduled'}
              </span>
              <span className="hm-badge">{sheet.job.profile}</span>
              {sheet.job.deliver && sheet.job.deliver !== 'local' && (
                <span className="hm-badge hm-badge--info">{sheet.job.deliver}</span>
              )}
            </div>
          }
          footer={
            <button className="hm-ghost hm-sheet__close" onClick={closeSheet}>
              Close
            </button>
          }
        >
          {sheet.job.prompt && (
            <div className="hm-projects__field">
              <label className="hm-projects__label">Prompt</label>
              <p className="hm-projects__body">{sheet.job.prompt}</p>
            </div>
          )}

          <div className="hm-projects__field">
            <label className="hm-projects__label">Schedule</label>
            <p className="hm-mono hm-muted">
              {describeSchedule(
                sheet.job.schedule,
                sheet.job.scheduleDisplay ?? sheet.job.expression,
                ENGLISH_SCHEDULE_STRINGS,
              )}
            </p>
            {sheet.job.expression && <code className="hm-mono hm-note">{sheet.job.expression}</code>}
          </div>

          <div className="hm-projects__form-row">
            <div className="hm-projects__field">
              <label className="hm-projects__label">Next run</label>
              <p className="hm-muted">{formatTime(sheet.job.nextRun)}</p>
            </div>
            <div className="hm-projects__field">
              <label className="hm-projects__label">Last run</label>
              <p className="hm-muted">{formatTime(sheet.job.lastRun)}</p>
            </div>
          </div>

          {sheet.job.lastError && (
            <div className="hm-projects__field">
              <label className="hm-projects__label">Last error</label>
              <p className="hm-cron-card__error">{sheet.job.lastError}</p>
            </div>
          )}

          <div className="hm-projects__field">
            <label className="hm-projects__label">Recent runs</label>
            {runsLoading ? (
              <p className="hm-muted">Loading…</p>
            ) : runs.length === 0 ? (
              <p className="hm-muted">No recent runs.</p>
            ) : (
              <div className="hm-cron__runs">
                {runs.map((run) => (
                  <div key={run.sessionId} className="hm-cron__run">
                    <span className="hm-cron__run-title">{run.title ?? run.sessionId}</span>
                    <span className="hm-muted">
                      {run.isActive ? 'active' : formatTime(run.startedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </BottomSheet>
      )}
    </div>
  );
}
