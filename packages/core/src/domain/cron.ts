/**
 * Cron job domain types and schedule builder helpers.
 *
 * Aligned with the Hermes Agent donor cron API:
 *   GET /api/cron/jobs?profile=...
 *   GET /api/cron/jobs/{id}?profile=...
 *   GET /api/cron/jobs/{id}/runs?profile=...&limit=...
 *   POST /api/cron/jobs?profile=...
 *   PUT /api/cron/jobs/{id}?profile=...
 *   POST /api/cron/jobs/{id}/pause?profile=...
 *   POST /api/cron/jobs/{id}/resume?profile=...
 *   POST /api/cron/jobs/{id}/trigger?profile=...
 *   DELETE /api/cron/jobs/{id}?profile=...
 *   GET /api/cron/delivery-targets
 */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function timestamp(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 10_000_000_000 ? v : v * 1000;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export interface CronSchedule {
  kind?: string | undefined;
  expr?: string | undefined;
  display?: string | undefined;
  minutes?: number | undefined;
  runAt?: string | undefined;
}

export interface CronJob {
  id: string;
  profile: string;
  name: string;
  prompt?: string | undefined;
  script?: string | undefined;
  expression: string;
  schedule?: CronSchedule | undefined;
  scheduleDisplay?: string | undefined;
  enabled: boolean;
  state?: string | undefined;
  deliver?: string | undefined;
  nextRun?: number | undefined;
  lastRun?: number | undefined;
  lastStatus?: string | undefined;
  lastError?: string | undefined;
}

export interface CronDeliveryTarget {
  id: string;
  name: string;
  homeTargetSet: boolean;
  homeEnvVar: string | null;
}

export interface CronJobRun {
  sessionId: string;
  title?: string | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  lastActive?: number | undefined;
  isActive: boolean;
  archived: boolean;
  profile?: string | undefined;
}

export function toCronJob(raw: Record<string, unknown>): CronJob {
  const scheduleRaw =
    typeof raw.schedule === 'object' && raw.schedule !== null
      ? (raw.schedule as Record<string, unknown>)
      : undefined;

  const schedule: CronSchedule | undefined = scheduleRaw
    ? {
        kind: str(scheduleRaw.kind),
        expr: str(scheduleRaw.expr),
        display: str(scheduleRaw.display),
        minutes: num(scheduleRaw.minutes),
        runAt: str(scheduleRaw.run_at ?? scheduleRaw.runAt),
      }
    : undefined;

  const expression =
    str(raw.schedule_display) ??
    schedule?.expr ??
    schedule?.display ??
    str(raw.expression) ??
    str(raw.schedule) ??
    '';

  const lastStatus = str(raw.last_status ?? raw.lastStatus);

  return {
    id: String(raw.id ?? ''),
    profile: str(raw.profile ?? raw.profile_name) ?? 'default',
    name: String(raw.name ?? raw.id ?? 'Job'),
    prompt: str(raw.prompt),
    script: str(raw.script),
    expression,
    schedule,
    scheduleDisplay: str(raw.schedule_display),
    enabled: raw.enabled !== false && raw.paused !== true,
    state: str(raw.state),
    deliver: str(raw.deliver),
    nextRun: timestamp(raw.next_run_at ?? raw.nextRun),
    lastRun: timestamp(raw.last_run_at ?? raw.lastRun),
    lastStatus,
    lastError: str(raw.last_error ?? raw.lastError),
  };
}

export function toCronJobRun(raw: Record<string, unknown>): CronJobRun {
  return {
    sessionId: String(raw.session_id ?? raw.id ?? ''),
    title: str(raw.title),
    startedAt: timestamp(raw.started_at),
    endedAt: timestamp(raw.ended_at),
    lastActive: timestamp(raw.last_active),
    isActive: raw.is_active === true,
    archived: raw.archived === true,
    profile: str(raw.profile),
  };
}

export function toCronDeliveryTarget(raw: Record<string, unknown>): CronDeliveryTarget {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? raw.id ?? ''),
    homeTargetSet: raw.home_target_set === true,
    homeEnvVar: typeof raw.home_env_var === 'string' ? raw.home_env_var : null,
  };
}

/** Picker modes — each renders a different set of inputs in the UI but
 * all funnel through {@link buildScheduleString} to a backend-compatible
 * string. */
export type ScheduleMode = 'interval' | 'daily' | 'weekly' | 'monthly' | 'once' | 'custom';

/** Unit used by interval mode. Backend parses ``m``/``h``/``d`` suffixes. */
export type IntervalUnit = 'minutes' | 'hours' | 'days';

/** Cron weekday convention: Sunday = 0 .. Saturday = 6. */
export const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAY_INDEXES)[number];

export interface ScheduleBuilderState {
  mode: ScheduleMode;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  timeOfDay: string;
  weekdays: Weekday[];
  dayOfMonth: number;
  onceAt: string;
  custom: string;
}

export const DEFAULT_SCHEDULE_STATE: ScheduleBuilderState = {
  mode: 'interval',
  intervalValue: 30,
  intervalUnit: 'minutes',
  timeOfDay: '09:00',
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  onceAt: '',
  custom: '',
};

const UNIT_SUFFIX: Record<IntervalUnit, string> = {
  minutes: 'm',
  hours: 'h',
  days: 'd',
};

export function buildScheduleString(state: ScheduleBuilderState): string {
  switch (state.mode) {
    case 'interval': {
      const n = Math.floor(state.intervalValue);
      if (!Number.isFinite(n) || n < 1) return '';
      return `every ${n}${UNIT_SUFFIX[state.intervalUnit]}`;
    }
    case 'daily': {
      const parsed = parseTimeOfDay(state.timeOfDay);
      if (!parsed) return '';
      return `${parsed.minute} ${parsed.hour} * * *`;
    }
    case 'weekly': {
      const parsed = parseTimeOfDay(state.timeOfDay);
      if (!parsed) return '';
      const days =
        state.weekdays.length === 0
          ? '*'
          : [...state.weekdays].sort((a, b) => a - b).join(',');
      return `${parsed.minute} ${parsed.hour} * * ${days}`;
    }
    case 'monthly': {
      const parsed = parseTimeOfDay(state.timeOfDay);
      if (!parsed) return '';
      const dom = Math.floor(state.dayOfMonth);
      if (!Number.isFinite(dom) || dom < 1 || dom > 31) return '';
      return `${parsed.minute} ${parsed.hour} ${dom} * *`;
    }
    case 'once': {
      const v = state.onceAt.trim();
      if (!v) return '';
      return v.length === 16 ? `${v}:00` : v;
    }
    case 'custom':
      return state.custom.trim();
  }
}

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [hh, mm] = value.split(':');
  const hour = parseInt(hh!, 10);
  const minute = parseInt(mm!, 10);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

export interface ScheduleDescribeStrings {
  none: string;
  everyMinutes: string;
  everyHours: string;
  /** "Every hour" and "Every minute" read better than "Every 1 hours"; they fall back to the plural form. */
  everyHour?: string;
  everyMinute?: string;
  everyDays: string;
  dailyAt: string;
  weeklyAt: string;
  monthlyAt: string;
  onceAt: string;
  weekdaysShort: [string, string, string, string, string, string, string];
  ordinal: (day: number) => string;
}

export const ENGLISH_SCHEDULE_STRINGS: ScheduleDescribeStrings = {
  none: '—',
  everyMinutes: 'Every {n} minutes',
  everyHours: 'Every {n} hours',
  everyHour: 'Every hour',
  everyMinute: 'Every minute',
  everyDays: 'Every {n} days',
  dailyAt: 'Daily at {time}',
  weeklyAt: 'Weekly on {days} at {time}',
  monthlyAt: 'Monthly on the {day} at {time}',
  onceAt: 'Once at {time}',
  weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ordinal: englishOrdinal,
};

export function describeSchedule(
  schedule: CronSchedule | undefined,
  fallbackDisplay: string | undefined,
  strings: ScheduleDescribeStrings,
): string {
  if (!schedule) {
    // A job that only carries its cron expression still reads as words when it can.
    return (fallbackDisplay && describeCronExpression(fallbackDisplay, strings)) || fallbackDisplay || strings.none;
  }

  if (schedule.kind === 'interval' && typeof schedule.minutes === 'number') {
    return describeInterval(schedule.minutes, strings);
  }

  if (schedule.kind === 'once' && schedule.runAt) {
    return strings.onceAt.replace('{time}', formatIsoLocal(schedule.runAt, false));
  }

  if (schedule.kind === 'cron' && schedule.expr) {
    const cronDesc = describeCronExpression(schedule.expr, strings);
    if (cronDesc) return cronDesc;
  }

  if (fallbackDisplay) {
    const cronDesc = describeCronExpression(fallbackDisplay, strings);
    if (cronDesc) return cronDesc;
    return fallbackDisplay;
  }
  if (schedule.display) return schedule.display;
  if (schedule.expr) return schedule.expr;
  return strings.none;
}

function describeInterval(minutes: number, strings: ScheduleDescribeStrings): string {
  if (minutes <= 0) return strings.none;
  if (minutes % 1440 === 0) {
    return strings.everyDays.replace('{n}', String(minutes / 1440));
  }
  if (minutes % 60 === 0) {
    return strings.everyHours.replace('{n}', String(minutes / 60));
  }
  return strings.everyMinutes.replace('{n}', String(minutes));
}

function describeCronExpression(
  expr: string,
  strings: ScheduleDescribeStrings,
): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, domField, monField, dowField] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (monField !== '*') return null;

  // Repeating patterns: every N minutes ("*/15 * * * *"), every N hours ("0 */6 * * *"), hourly ("0 * * * *").
  const everyDay = domField === '*' && dowField === '*';
  const minuteStep = /^\*\/(\d+)$/.exec(minField);
  if (everyDay && hourField === '*' && (minuteStep || minField === '*')) {
    const n = minuteStep ? parseInt(minuteStep[1]!, 10) : 1;
    if (n === 1) return strings.everyMinute ?? strings.everyMinutes.replace('{n}', '1');
    if (n > 1 && n < 60) return strings.everyMinutes.replace('{n}', String(n));
  }
  const hourStep = /^\*\/(\d+)$/.exec(hourField);
  if (everyDay && /^\d+$/.test(minField) && (hourStep || hourField === '*')) {
    const n = hourStep ? parseInt(hourStep[1]!, 10) : 1;
    if (n === 1) return strings.everyHour ?? strings.everyHours.replace('{n}', '1');
    if (n > 1 && n < 24) return strings.everyHours.replace('{n}', String(n));
  }

  const isLiteralOrList = (f: string) => /^\d+(,\d+)*$/.test(f) || /^\*$/.test(f);
  if (!isLiteralOrList(minField) || !isLiteralOrList(hourField)) return null;
  if (!isLiteralOrList(domField) || !isLiteralOrList(dowField)) return null;
  if (minField === '*' || hourField === '*') return null;

  const minutes = minField.split(',').map((n) => parseInt(n, 10));
  const hours = hourField.split(',').map((n) => parseInt(n, 10));
  if (minutes.length !== 1 || hours.length !== 1) return null;
  const minuteVal = minutes[0]!;
  const hourVal = hours[0]!;
  if (
    !Number.isFinite(minuteVal) ||
    !Number.isFinite(hourVal) ||
    hourVal < 0 ||
    hourVal > 23 ||
    minuteVal < 0 ||
    minuteVal > 59
  ) {
    return null;
  }
  const time = `${pad2(hourVal)}:${pad2(minuteVal)}`;

  const domAll = domField === '*';
  const dowAll = dowField === '*';

  if (domAll && dowAll) {
    return strings.dailyAt.replace('{time}', time);
  }

  if (domAll && !dowAll) {
    const days = dowField
      .split(',')
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6) as Weekday[];
    if (days.length === 0) return null;
    const labels = days.map((d) => strings.weekdaysShort[d]).filter(Boolean).join(', ');
    return strings.weeklyAt.replace('{days}', labels).replace('{time}', time);
  }

  if (!domAll && dowAll) {
    const dom = parseInt(domField, 10);
    if (!Number.isFinite(dom) || dom < 1 || dom > 31) return null;
    return strings.monthlyAt
      .replace('{day}', strings.ordinal(dom))
      .replace('{time}', time);
  }

  return null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatIsoLocal(iso: string, includeSeconds: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  if (includeSeconds) {
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${pad2(d.getSeconds())}`;
  }
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function englishOrdinal(day: number): string {
  const d = Math.floor(day);
  if (!Number.isFinite(d) || d < 1) return String(day);
  const lastTwo = d % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${d}th`;
  switch (d % 10) {
    case 1:
      return `${d}st`;
    case 2:
      return `${d}nd`;
    case 3:
      return `${d}rd`;
    default:
      return `${d}th`;
  }
}
