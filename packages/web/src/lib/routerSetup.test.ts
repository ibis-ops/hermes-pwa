import { describe, expect, it } from 'vitest';
import { pickFastModel } from './routerSetup';

describe('pickFastModel', () => {
  it('picks the newest fast model, the plain alias before a dated one', () => {
    const provider = { name: 'Anthropic', slug: 'anthropic', models: ['claude-sonnet-5', 'claude-3-5-haiku-20241022', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5'] };
    expect(pickFastModel(provider)).toBe('claude-haiku-4-5');
    expect(pickFastModel({ ...provider, models: [...provider.models, 'claude-haiku-5-5'] })).toBe('claude-haiku-5-5');
    expect(pickFastModel({ name: 'OpenAI', slug: 'openai', models: ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5-mini'] })).toBe('gpt-5.5-mini');
    expect(pickFastModel({ name: 'X', slug: 'x', models: ['big-model'] })).toBeUndefined();
    expect(pickFastModel(undefined)).toBeUndefined();
  });
});
