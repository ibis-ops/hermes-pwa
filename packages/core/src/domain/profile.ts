export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface Profile {
  name: string;
  displayName?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  showReasoning?: boolean;
  description?: string;
  isActive: boolean;
}

export interface ProfileActive {
  active: string | undefined;
  current: string | undefined;
}

export interface ProfileCreateBody {
  name: string;
  clone_from_default?: boolean;
  clone_all?: boolean;
  no_skills?: boolean;
  description?: string;
  provider?: string;
  model?: string;
}

export interface ProfileCreateResult {
  ok: boolean;
  name: string;
  path?: string;
  model_set?: boolean;
}

export function toProfile(raw: Record<string, unknown>, activeName: string): Profile {
  const name = String(raw.name ?? '');
  const profile: Profile = {
    name,
    isActive: name === activeName,
  };
  // Hermes sends display_name: "" for profiles without one; an empty label is
  // not a name, so leave displayName unset and let callers fall back to name.
  if (typeof raw.display_name === 'string' && raw.display_name.trim()) profile.displayName = raw.display_name.trim();
  if (typeof raw.model === 'string') profile.model = raw.model;
  if (typeof raw.provider === 'string') profile.provider = raw.provider;
  if (isReasoningEffort(raw.reasoning_effort)) profile.reasoningEffort = raw.reasoning_effort;
  if (typeof raw.show_reasoning === 'boolean') profile.showReasoning = raw.show_reasoning;
  if (typeof raw.description === 'string') profile.description = raw.description;
  return profile;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

export function toProfileActive(raw: Record<string, unknown>): ProfileActive {
  return {
    active: typeof raw.active === 'string' ? raw.active : undefined,
    current: typeof raw.current === 'string' ? raw.current : undefined,
  };
}

export function toProfileCreateResult(raw: Record<string, unknown>): ProfileCreateResult {
  return {
    ok: raw.ok === true,
    name: typeof raw.name === 'string' ? raw.name : '',
    ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
    ...(raw.model_set === true ? { model_set: true } : {}),
  };
}
