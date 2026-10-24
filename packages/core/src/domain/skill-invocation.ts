/**
 * Slash-skill turns. `/work fix the leak` reaches the model as a long scaffold
 * (activation note, the whole skill body, then the instruction). Hermes's own
 * clients render the invocation as typed, never the body; the REST transcript
 * carries the body, so the projection is reconstructed here. Marker strings
 * mirror agent/skill_commands.py and must stay byte-identical to them.
 */

const INVOCATION_PREFIX = '[IMPORTANT: The user has invoked the ';
const SINGLE_MARKER = 'The full skill content is loaded below.]';
const SINGLE_INSTRUCTION = 'The user has provided the following instruction alongside the skill invocation: ';
const RUNTIME_NOTE = '\n\n[Runtime note:';
const BUNDLE_MARKER = ' skill bundle,';
const BUNDLE_USER_INSTRUCTION = '\nUser instruction: ';
const BUNDLE_FIRST_SKILL_BLOCK = '\n\n[Loaded as part of the ';
const AUTO_LOAD_PREFIX = '[IMPORTANT: The "';
const AUTO_LOAD_SUFFIX = /" skill is auto-loaded\. Follow its instructions for this session\.\]/u;
const SKILL_DIR_NOTE_END = 'then run them with the terminal tool using the absolute path.';
const NAME_PATTERN = /^\[IMPORTANT: The user has invoked the "([^"]*)"/u;

export interface SkillInvocation {
  /** `/work`, or `/clean /work` for a stacked invocation. */
  label: string;
  /** What the person typed after the skill, if anything. */
  instruction: string | undefined;
}

function squash(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(' ');
}

function cutAfter(content: string, marker: string, end: string, last: boolean): string | undefined {
  const at = last ? content.lastIndexOf(marker) : content.indexOf(marker);
  if (at === -1) return undefined;
  const start = at + marker.length;
  const stop = content.indexOf(end, start);
  return content.slice(start, stop === -1 ? undefined : stop);
}

/** True for any model-facing skill scaffold a user row may carry. */
export function isSkillScaffold(content: string): boolean {
  return content.startsWith(INVOCATION_PREFIX) || (content.startsWith(AUTO_LOAD_PREFIX) && AUTO_LOAD_SUFFIX.test(content));
}

/** The invocation a scaffolded user turn came from, or undefined when `content` is ordinary text. */
export function describeSkillInvocation(content: string): SkillInvocation | undefined {
  if (content.startsWith(AUTO_LOAD_PREFIX)) {
    const suffix = AUTO_LOAD_SUFFIX.exec(content);
    if (!suffix) return undefined;
    const name = content.slice(AUTO_LOAD_PREFIX.length, suffix.index);
    const footer = content.lastIndexOf(SKILL_DIR_NOTE_END);
    const typed = footer === -1 ? '' : squash(content.slice(footer + SKILL_DIR_NOTE_END.length));
    return { label: `/${name}`, instruction: typed || undefined };
  }
  if (!content.startsWith(INVOCATION_PREFIX)) return undefined;
  const name = NAME_PATTERN.exec(content)?.[1]?.trim() ?? '';
  const label = name.startsWith('/') ? name : `/${name}`;
  let instruction: string | undefined;
  if (content.includes(BUNDLE_MARKER)) {
    instruction = cutAfter(content, BUNDLE_USER_INSTRUCTION, BUNDLE_FIRST_SKILL_BLOCK, false);
  } else if (content.includes(SINGLE_MARKER)) {
    instruction = cutAfter(content, SINGLE_INSTRUCTION, RUNTIME_NOTE, true);
  }
  const typed = instruction ? squash(instruction) : '';
  return { label: name ? label : '/skill', instruction: typed || undefined };
}

/** `/work fix the leak`: the one-line text shown for a skill turn. */
export function skillInvocationText(invocation: SkillInvocation): string {
  return invocation.instruction ? `${invocation.label} ${invocation.instruction}` : invocation.label;
}
