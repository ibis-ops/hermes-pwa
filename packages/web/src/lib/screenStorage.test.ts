import { beforeEach, describe, expect, it } from 'vitest';
import { getInitialScreen, persistScreen, screenFromLocationHash } from './screenStorage';

describe('screenStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('opens Chat on the first launch when no screen was persisted', () => {
    expect(getInitialScreen()).toBe('chat');
  });

  it('opens Chat even without an active session cache', () => {
    localStorage.setItem('hermes-mobile-screen', 'chat');
    expect(getInitialScreen()).toBe('chat');
  });

  it('restores the last non-chat screen', () => {
    localStorage.setItem('hermes-mobile-screen', 'kanban');
    expect(getInitialScreen()).toBe('kanban');
  });

  it('parses notification hash routes', () => {
    expect(screenFromLocationHash('#/approvals')).toBe('approvals');
    expect(screenFromLocationHash('#/chat?x=1')).toBe('chat');
    expect(screenFromLocationHash('#/nope')).toBeUndefined();
    expect(screenFromLocationHash('')).toBeUndefined();
  });

  it('ignores an unknown persisted screen', () => {
    localStorage.setItem('hermes-mobile-screen', 'skills');
    expect(getInitialScreen()).toBe('chat');
  });

  it('persists the provided screen', () => {
    persistScreen('settings');
    expect(localStorage.getItem('hermes-mobile-screen')).toBe('settings');
  });
});
