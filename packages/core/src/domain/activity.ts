/**
 * Activity / approvals / clarify domain types.
 */

export type ActionKind = 'approval' | 'clarify' | 'run' | 'system';

export type ActionStatus = 'needs_you' | 'running' | 'completed';

export interface ActionItem {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  title: string;
  summary?: string;
  sessionId?: string;
  sourceSessionId?: string;
  createdAt: number;
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

export interface Approval extends ActionItem {
  kind: 'approval';
  highImpact: boolean;
  visibility?: 'private' | 'public';
  session?: string;
  /** The command exactly as it would run. `summary` may be redacted or shortened for lists. */
  command?: string;
  /** False when the stored command text was cut short; the card then warns before approval. */
  commandComplete?: boolean;
  /** The gateway's approval-queue id (`approval.respond` keys on it when known). */
  requestId?: string;
  /** Id of the open server→client request; answering it is the direct path back to the waiting tool. */
  serverRequestId?: string;
  /** Choices the gateway offers; a smart-denied command gets `once` and `deny` only. */
  choices?: ApprovalChoice[];
  /** The guardian model refused this command; the person is being asked to override. */
  smartDenied?: boolean;
}

export interface ClarifyQuestion {
  qid: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
}

export interface Clarify extends ActionItem {
  kind: 'clarify';
  question: string;
  /** Batch questions from a `clarify` server request; a legacy event carries one `question` only. */
  questions?: ClarifyQuestion[];
  serverRequestId?: string;
}

const APPROVAL_CHOICES: ApprovalChoice[] = ['once', 'session', 'always', 'deny'];

function toChoices(raw: unknown): ApprovalChoice[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const choices = raw.filter((value): value is ApprovalChoice => typeof value === 'string' && (APPROVAL_CHOICES as string[]).includes(value));
  return choices.length ? choices : undefined;
}

/** The approval a gateway `approval` server request describes. */
export function approvalFromServerRequest(requestId: string, params: Record<string, unknown>, sessionId: string | undefined): Approval {
  const command = typeof params.command === 'string' ? params.command : '';
  const description = typeof params.description === 'string' ? params.description : '';
  const queueId = typeof params.request_id === 'string' && params.request_id ? params.request_id : undefined;
  const item: Approval = {
    id: queueId ?? requestId,
    kind: 'approval',
    status: 'needs_you',
    title: params.smart_denied === true ? 'Approval required (flagged as risky)' : 'Approval required',
    highImpact: true,
    visibility: 'private',
    createdAt: Date.now(),
    serverRequestId: requestId,
    smartDenied: params.smart_denied === true,
  };
  if (queueId) item.requestId = queueId;
  if (sessionId) {
    item.sessionId = sessionId;
    item.sourceSessionId = sessionId;
    item.session = `Session ${sessionId.slice(0, 8)}`;
  }
  const summary = [command, description].filter(Boolean).join('\n');
  if (summary) item.summary = summary;
  if (command) {
    item.command = command;
    item.commandComplete = true;
  }
  const choices = toChoices(params.choices);
  if (choices) item.choices = choices;
  else if (item.smartDenied) item.choices = ['once', 'deny'];
  return item;
}

/** The clarify card a gateway `clarify` server request describes. */
export function clarifyFromServerRequest(requestId: string, params: Record<string, unknown>, sessionId: string | undefined): Clarify {
  const raw = Array.isArray(params.questions) ? params.questions : [];
  const questions: ClarifyQuestion[] = raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry, index) => ({
      qid: typeof entry.qid === 'string' && entry.qid ? entry.qid : `q${index + 1}`,
      question: typeof entry.question === 'string' ? entry.question : '',
      choices: Array.isArray(entry.choices) ? entry.choices.filter((c): c is string => typeof c === 'string') : [],
      multiSelect: entry.multi_select === true,
    }))
    .filter((question) => question.question);
  const item: Clarify = {
    id: requestId,
    kind: 'clarify',
    status: 'needs_you',
    title: questions.length > 1 ? `${questions.length} questions` : 'Clarification needed',
    question: questions[0]?.question ?? '',
    questions,
    serverRequestId: requestId,
    createdAt: Date.now(),
  };
  if (sessionId) {
    item.sessionId = sessionId;
    item.sourceSessionId = sessionId;
  }
  return item;
}

export function toActionItem(raw: Record<string, unknown>): ActionItem {
  const kind = (raw.kind as ActionKind) ?? 'system';
  const base: ActionItem = {
    id: String(raw.id ?? ''),
    kind,
    status: (raw.status as ActionStatus) ?? 'needs_you',
    title: typeof raw.title === 'string' ? raw.title : 'Untitled',
    createdAt: typeof raw.created_at === 'number' ? raw.created_at : Date.now(),
  };
  if (typeof raw.session_id === 'string') {
    base.sessionId = raw.session_id;
  } else if (typeof raw.sessionId === 'string') {
    base.sessionId = raw.sessionId;
  }
  if (typeof raw.source_session_id === 'string') {
    base.sourceSessionId = raw.source_session_id;
  } else if (typeof raw.sourceSessionId === 'string') {
    base.sourceSessionId = raw.sourceSessionId;
  }

  if (kind === 'approval') {
    const out: Approval = {
      ...base,
      kind: 'approval',
      highImpact: Boolean(raw.high_impact ?? raw.highImpact),
    };
    if (typeof raw.summary === 'string') out.summary = raw.summary;
    if (typeof raw.command === 'string' && raw.command.trim()) out.command = raw.command;
    if (typeof raw.command_complete === 'boolean') out.commandComplete = raw.command_complete;
    // The gateway's approval-queue id, when the recovery record carries it:
    // the answer is keyed on it rather than on the session alone.
    const requestId = raw.request_id ?? raw.requestId;
    if (typeof requestId === 'string' && requestId.trim()) out.requestId = requestId;
    if (typeof raw.session === 'string') out.session = raw.session;
    if (typeof raw.visibility === 'string' && (raw.visibility === 'private' || raw.visibility === 'public')) {
      out.visibility = raw.visibility;
    }
    return out;
  }

  if (kind === 'clarify') {
    const out: Clarify = {
      ...base,
      kind: 'clarify',
      question: typeof raw.question === 'string' ? raw.question : '',
    };
    if (typeof raw.summary === 'string') out.summary = raw.summary;
    return out;
  }

  const out: ActionItem = { ...base };
  if (typeof raw.summary === 'string') out.summary = raw.summary;
  return out;
}
