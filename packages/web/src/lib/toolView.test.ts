import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@hermes-pwa/core';
import { buildToolView } from './toolView';

describe('buildToolView', () => {
  it('shows the argument that says what an unknown tool was asked, not its arguments as JSON', () => {
    const view = buildToolView({ id: 't', name: 'shell.exec', input: { command: 'pytest -k reconnect' }, output: '2 passed' } as ToolCall);
    expect(view.subtitle).toBe('pytest -k reconnect');
    const other = buildToolView({ id: 'u', name: 'custom_tool', input: { limit: 3, verbose: true } } as ToolCall);
    expect(other.subtitle).toContain('"limit":3');
  });
});
