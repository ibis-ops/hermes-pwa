import { describe, expect, it } from 'vitest';
import { toProfile } from './profile';

describe('toProfile', () => {
  it('maps the Hermes profile fields', () => {
    const profile = toProfile(
      {
        name: 'work',
        display_name: 'Work',
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        reasoning_effort: 'high',
        show_reasoning: true,
        description: 'Daily driver',
      },
      'work',
    );
    expect(profile).toEqual({
      name: 'work',
      isActive: true,
      displayName: 'Work',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      reasoningEffort: 'high',
      showReasoning: true,
      description: 'Daily driver',
    });
  });

  it('treats a blank display_name as no display name', () => {
    expect(toProfile({ name: 'default', display_name: '' }, 'other').displayName).toBeUndefined();
    expect(toProfile({ name: 'default', display_name: '   ' }, 'other').displayName).toBeUndefined();
    expect(toProfile({ name: 'default', display_name: ' Main ' }, 'other').displayName).toBe('Main');
  });
});
