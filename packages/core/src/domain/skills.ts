/**
 * Skill registry domain types.
 */

export interface Skill {
  id: string;
  name: string;
  description?: string | undefined;
  version?: string | undefined;
  /** Folder the skill ships in (apple, productivity, ...); undefined for uncategorised skills. */
  category?: string | undefined;
  enabled: boolean;
}

export function toSkill(raw: Record<string, unknown>): Skill {
  const category = typeof raw.category === 'string' && raw.category.trim() && raw.category !== 'None' ? raw.category.trim() : undefined;
  return {
    id: String(raw.id ?? raw.name ?? ''),
    name: String(raw.name ?? raw.id ?? 'Skill'),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    category,
    enabled: raw.enabled !== false && raw.active !== false,
  };
}

/** `Foo Bar` -> `foo-bar`: the slash command a skill answers to (mirrors Hermes's slugify). */
export function skillCommandSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/[^a-z0-9-]/gu, '')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
}
