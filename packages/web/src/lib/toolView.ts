import type { ToolCall } from '@hermes-pwa/core';

export type ToolStatus = 'error' | 'running' | 'success';
export type ToolTone = 'agent' | 'browser' | 'default' | 'file' | 'image' | 'terminal' | 'web';

export interface ToolView {
  countLabel: string | undefined;
  detail: string;
  detailLabel: string;
  icon: string;
  rawResult: string;
  status: ToolStatus;
  subtitle: string;
  title: string;
  tone: ToolTone;
}

interface ToolMeta {
  done: string;
  icon: string;
  pending: string;
  tone: ToolTone;
}

const TOOL_META: Record<string, ToolMeta> = {
  browser_click: { done: 'Clicked page element', pending: 'Clicking page element', icon: 'globe', tone: 'browser' },
  browser_fill: { done: 'Filled form field', pending: 'Filling form field', icon: 'globe', tone: 'browser' },
  browser_navigate: { done: 'Opened page', pending: 'Opening page', icon: 'globe', tone: 'browser' },
  browser_snapshot: { done: 'Captured page snapshot', pending: 'Capturing page snapshot', icon: 'globe', tone: 'browser' },
  browser_take_screenshot: { done: 'Captured screenshot', pending: 'Capturing screenshot', icon: 'file', tone: 'browser' },
  browser_type: { done: 'Typed on page', pending: 'Typing on page', icon: 'globe', tone: 'browser' },
  clarify: { done: 'Asked a question', pending: 'Asking a question', icon: 'chat', tone: 'agent' },
  cronjob: { done: 'Cron job', pending: 'Scheduling cron job', icon: 'cron', tone: 'agent' },
  edit_file: { done: 'Edited file', pending: 'Editing file', icon: 'edit', tone: 'file' },
  execute_code: { done: 'Ran code', pending: 'Running code', icon: 'terminal', tone: 'terminal' },
  image_generate: { done: 'Generated image', pending: 'Generating image', icon: 'file', tone: 'image' },
  list_files: { done: 'Listed files', pending: 'Listing files', icon: 'file', tone: 'file' },
  patch: { done: 'Patched file', pending: 'Patching file', icon: 'edit', tone: 'file' },
  read_file: { done: 'Read file', pending: 'Reading file', icon: 'file', tone: 'file' },
  search_files: { done: 'Searched files', pending: 'Searching files', icon: 'search', tone: 'file' },
  session_search_recall: { done: 'Searched session history', pending: 'Searching session history', icon: 'search', tone: 'agent' },
  terminal: { done: 'Ran command', pending: 'Running command', icon: 'terminal', tone: 'terminal' },
  todo: { done: 'Updated todos', pending: 'Updating todos', icon: 'settings', tone: 'agent' },
  vision_analyze: { done: 'Analyzed image', pending: 'Analyzing image', icon: 'search', tone: 'image' },
  web_extract: { done: 'Read webpage', pending: 'Reading webpage', icon: 'globe', tone: 'web' },
  web_search: { done: 'Searched web', pending: 'Searching web', icon: 'search', tone: 'web' },
  write_file: { done: 'Edited file', pending: 'Editing file', icon: 'edit', tone: 'file' },
};

function titleForTool(name: string): string {
  const normalized = name.replace(/^browser_/, '').replace(/^web_/, '');
  return (
    normalized
      .split('_')
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
      .join(' ') || name
  );
}

const PREFIX_META: { icon: string; prefix: string; tone: ToolTone; verb: string }[] = [
  { prefix: 'browser_', verb: 'Browser', icon: 'globe', tone: 'browser' },
  { prefix: 'web_', verb: 'Web', icon: 'globe', tone: 'web' },
];

function toolMeta(name: string): ToolMeta {
  if (TOOL_META[name]) return TOOL_META[name];
  const action = titleForTool(name);
  const prefix = PREFIX_META.find((p) => name.startsWith(p.prefix));
  return prefix
    ? {
        done: `${prefix.verb} ${action}`,
        pending: `Running ${prefix.verb.toLowerCase()} ${action.toLowerCase()}`,
        icon: prefix.icon,
        tone: prefix.tone,
      }
    : { done: action, pending: `Running ${action.toLowerCase()}`, icon: 'settings', tone: 'default' };
}

export function parseMaybeObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

function compactPreview(value: unknown, max = 72): string {
  let raw: unknown = value;
  if (raw && typeof raw === 'object') {
    const parsed = parseMaybeObject(raw);
    raw = parsed.context ?? parsed.preview ?? raw;
  }
  if (typeof raw !== 'string') {
    if (raw == null) raw = '';
    else {
      try {
        raw = JSON.stringify(raw);
      } catch {
        raw = String(raw);
      }
    }
  }
  const line = (raw as string).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function firstStringField(record: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function contextValue(value: unknown): string {
  const row = parseMaybeObject(value);
  if (typeof row.context === 'string') return row.context;
  if (typeof row.preview === 'string') return row.preview;
  return typeof value === 'string' ? value : '';
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function findFirstUrl(args: Record<string, unknown>, result: Record<string, unknown>): string {
  const combined = { ...args, ...result };
  for (const value of Object.values(combined)) {
    if (typeof value === 'string') {
      try {
        const url = new URL(value);
        return url.href;
      } catch {
        // continue
      }
    }
  }
  return '';
}

function toolStatus(tool: ToolCall, resultRecord: Record<string, unknown>): ToolStatus {
  if (tool.output === undefined) return 'running';
  if (resultRecord.error || resultRecord.status === 'error') return 'error';
  return 'success';
}

function fallbackDetailText(args: Record<string, unknown>, result: Record<string, unknown>): string {
  const argsJson = Object.keys(args).length ? JSON.stringify(args) : '';
  const resultJson = Object.keys(result).length ? JSON.stringify(result) : '';
  return resultJson || argsJson;
}

const SALIENT_ARG_KEYS = ['command', 'query', 'search_term', 'goal', 'path', 'file', 'url', 'message', 'prompt', 'title', 'name', 'target', 'text'] as const;

function toolSubtitle(tool: ToolCall, argsRecord: Record<string, unknown>, resultRecord: Record<string, unknown>): string {
  const toolName = tool.name;

  if (toolName === 'browser_navigate') {
    const url =
      firstStringField(argsRecord, ['url', 'target']) || firstStringField(resultRecord, ['url']) || findFirstUrl(argsRecord, resultRecord);
    return url ? hostnameOf(url) : 'Navigated in browser';
  }

  if (toolName === 'browser_click') {
    const clicked = firstStringField(resultRecord, ['clicked']) || firstStringField(argsRecord, ['ref', 'target']);
    if (!clicked) return 'Clicked on page';
    return clicked.startsWith('@') ? `Clicked page element (internal ref ${clicked})` : `Clicked ${clicked}`;
  }

  if (toolName === 'browser_fill' || toolName === 'browser_type') {
    const field = firstStringField(argsRecord, ['label', 'field', 'ref', 'target']);
    const value = firstStringField(argsRecord, ['value', 'text']);
    return (
      [field && `Field: ${field}`, value && `Value: ${compactPreview(value, 42)}`].filter(Boolean).join(' · ') || 'Filled page input'
    );
  }

  if (toolName === 'web_search') {
    const query = firstStringField(argsRecord, ['search_term', 'query']) || contextValue(argsRecord);
    return query ? `Query: ${query}` : 'Queried web sources';
  }

  if (toolName === 'terminal' || toolName === 'execute_code') {
    const output = firstStringField(resultRecord, ['output', 'stdout', 'stderr']);
    const rawOutput = typeof tool.output === 'string' ? tool.output : '';
    const lines = Array.isArray(resultRecord.lines)
      ? (resultRecord.lines as unknown[]).filter((line): line is string => typeof line === 'string').join('\n')
      : '';
    const previewSource = (output || lines || rawOutput).trim();
    if (previewSource) {
      const firstMeaningfulLine = previewSource
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (firstMeaningfulLine) return compactPreview(firstMeaningfulLine, 160);
    }
    const command = firstStringField(argsRecord, ['command', 'code']) || contextValue(argsRecord);
    return command ? compactPreview(command, 120) : 'Executed command';
  }

  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
    const path = firstStringField(argsRecord, ['path', 'file', 'filepath']);
    return path || 'Changed file';
  }

  if (toolName === 'web_extract') {
    const url =
      firstStringField(argsRecord, ['url']) || firstStringField(resultRecord, ['url']) || findFirstUrl(argsRecord, resultRecord);
    return url ? hostnameOf(url) : 'Fetched webpage';
  }

  const resultPreview = compactPreview(resultRecord, 120);
  if (resultPreview && resultPreview !== '{}' && resultPreview !== '[]') return resultPreview;
  // The one argument that says what the tool was asked to do, rather than its arguments as JSON.
  const salient = firstStringField(argsRecord, SALIENT_ARG_KEYS);
  if (salient) return compactPreview(salient, 120);
  const argsPreview = compactPreview(argsRecord, 120);
  if (argsPreview && argsPreview !== '{}' && argsPreview !== '[]') return argsPreview;
  const fallback = fallbackDetailText(argsRecord, resultRecord);
  return fallback && fallback !== '{}' && fallback !== '[]' ? fallback : '';
}

function dynamicTitle(tool: ToolCall, args: Record<string, unknown>, result: Record<string, unknown>, fallback: string): string {
  const isPending = tool.output === undefined;
  const verb = (gerund: string, past: string) => (isPending ? gerund : past);

  if (tool.name === 'web_extract') {
    const url = findFirstUrl(args, result);
    return url ? `${verb('Reading', 'Read')} ${hostnameOf(url)}` : fallback;
  }

  if (tool.name === 'browser_navigate') {
    const url = findFirstUrl(args, result);
    return url ? `${verb('Opening', 'Opened')} ${hostnameOf(url)}` : fallback;
  }

  if (tool.name === 'web_search') {
    const query = firstStringField(args, ['search_term', 'query']) || contextValue(args);
    return query ? `${verb('Searching', 'Searched')} “${compactPreview(query, 48)}”` : fallback;
  }

  if (tool.name === 'terminal' || tool.name === 'execute_code') {
    const command = firstStringField(args, ['command', 'code']) || contextValue(args);
    if (command) {
      const verbText = tool.name === 'execute_code' ? verb('Running code', 'Ran code') : verb('Running', 'Ran');
      return `${verbText} · ${compactPreview(command, 160)}`;
    }
  }

  if (tool.name === 'read_file') {
    const path = firstStringField(args, ['path', 'file', 'filepath']);
    return path ? `${verb('Reading', 'Read')} ${compactPreview(path, 120)}` : fallback;
  }

  if (tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'patch') {
    const path = firstStringField(args, ['path', 'file', 'filepath']);
    return path ? `${verb('Editing', 'Edited')} ${compactPreview(path, 120)}` : fallback;
  }

  if (tool.name === 'list_files') {
    const path = firstStringField(args, ['path', 'directory', 'dir']) || contextValue(args);
    return path ? `${verb('Listing', 'Listed')} ${compactPreview(path, 120)}` : fallback;
  }

  if (tool.name === 'search_files') {
    const query = firstStringField(args, ['query', 'search_term', 'term']) || contextValue(args);
    return query ? `${verb('Searching', 'Searched')} “${compactPreview(query, 48)}”` : fallback;
  }

  return fallback;
}

function toolDetailText(tool: ToolCall, argsRecord: Record<string, unknown>, resultRecord: Record<string, unknown>): string {
  const output = tool.output;
  if (typeof output === 'string' && output.trim()) {
    return output.trim();
  }
  const text = firstStringField(resultRecord, ['text', 'output', 'stdout', 'result', 'content', 'message']);
  if (text) return text;
  return fallbackDetailText(argsRecord, resultRecord);
}

function toolDetailLabel(toolName: string): string {
  if (toolName === 'web_search') return 'Details';
  if (toolName === 'terminal' || toolName === 'execute_code') return 'Command output';
  return 'Output';
}

function formatCountLabel(count: number, noun: string): string {
  const word = count === 1 ? noun : `${noun}s`;
  return `${count} ${word}`;
}

function toolResultCount(tool: ToolCall, argsRecord: Record<string, unknown>, resultRecord: Record<string, unknown>): string | undefined {
  if (tool.name === 'web_search' || tool.name === 'search_files') {
    const results = resultRecord.results ?? resultRecord.items ?? resultRecord.matches ?? resultRecord.files;
    if (Array.isArray(results) && results.length > 0) {
      return formatCountLabel(results.length, 'result');
    }
  }
  if (tool.name === 'list_files') {
    const files = resultRecord.files ?? resultRecord.items;
    if (Array.isArray(files) && files.length > 0) {
      return formatCountLabel(files.length, 'file');
    }
  }
  if (tool.name === 'todo') {
    const todos = parseMaybeObject(tool.output).todos ?? parseMaybeObject(tool.output);
    if (Array.isArray(todos)) {
      const completed = todos.filter((t) => (t as Record<string, unknown>).status === 'completed').length;
      if (completed > 0) return `${completed}/${todos.length} done`;
      return formatCountLabel(todos.length, 'todo');
    }
  }
  return undefined;
}

export function buildToolView(tool: ToolCall): ToolView {
  const argsRecord = parseMaybeObject(tool.input);
  const resultRecord = parseMaybeObject(tool.output);
  const meta = toolMeta(tool.name);
  const status = toolStatus(tool, resultRecord);
  const baseTitle = tool.output === undefined ? meta.pending : meta.done;
  const title = dynamicTitle(tool, argsRecord, resultRecord, baseTitle);
  const titleEnriched = title !== baseTitle;
  const baseSubtitle = toolSubtitle(tool, argsRecord, resultRecord);
  const keepSubtitleWithTitle = tool.name === 'terminal' || tool.name === 'execute_code';
  const subtitle = titleEnriched && !keepSubtitleWithTitle ? '' : baseSubtitle;

  return {
    countLabel: toolResultCount(tool, argsRecord, resultRecord),
    detail: toolDetailText(tool, argsRecord, resultRecord),
    detailLabel: toolDetailLabel(tool.name),
    icon: meta.icon,
    rawResult: typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output),
    status,
    subtitle,
    title,
    tone: meta.tone,
  };
}
