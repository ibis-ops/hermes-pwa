import { describe, expect, it } from 'vitest';
import { describeSkillInvocation, skillInvocationText } from './skill-invocation';

describe('skill invocation projection', () => {
  it('reads a single-skill scaffold back as the typed command', () => {
    const scaffold = [
      '[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
      '',
      '# Work',
      'Body text that even quotes: The user has provided the following instruction alongside the skill invocation: nope',
      '',
      'The user has provided the following instruction alongside the skill invocation: fix   the\nleak',
      '',
      '[Runtime note: cwd is /tmp]',
    ].join('\n');
    const invocation = describeSkillInvocation(scaffold);
    expect(invocation).toEqual({ label: '/work', instruction: 'fix the leak' });
    expect(skillInvocationText(invocation!)).toBe('/work fix the leak');
  });

  it('handles bare invocations, bundles and auto-loaded skills', () => {
    expect(describeSkillInvocation('[IMPORTANT: The user has invoked the "pdf" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\nbody')).toEqual({ label: '/pdf', instruction: undefined });
    const bundle = '[IMPORTANT: The user has invoked the "/clean /work" skill bundle, loading 2 skills together. Treat every skill below as active guidance for this turn.]\n\nSkills loaded: clean, work\n\nUser instruction: tidy up\n\n[Loaded as part of the bundle]\n...';
    expect(describeSkillInvocation(bundle)).toEqual({ label: '/clean /work', instruction: 'tidy up' });
    const auto = '[IMPORTANT: The "memory" skill is auto-loaded. Follow its instructions for this session.]\n\nbody then run them with the terminal tool using the absolute path.\n\nwhat did we decide?';
    expect(describeSkillInvocation(auto)).toEqual({ label: '/memory', instruction: 'what did we decide?' });
    expect(describeSkillInvocation('plain text')).toBeUndefined();
  });
});
