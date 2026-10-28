import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Icon, type IconName } from './Icon';

const NAMES: IconName[] = [
  'menu',
  'home',
  'chat',
  'check',
  'sessions',
  'profiles',
  'kanban',
  'cron',
  'agents',
  'robot',
  'system',
  'settings',
  'skills',
  'messaging',
  'search',
  'globe',
  'file',
  'plus',
  'mic',
  'wave',
  'arrowUp',
  'bolt',
  'chevR',
  'chevD',
  'close',
  'branch',
  'play',
  'pause',
  'edit',
  'trash',
  'refresh',
  'shield',
  'terminal',
  'alert',
  'sparkle',
  'archive',
  'logout',
  'speaker',
  'stopSquare',
  'compose',
];

describe('Icon', () => {
  it.each(NAMES)('renders %s as an svg with viewBox', (name) => {
    render(<Icon name={name} data-testid={`icon-${name}`} />);
    const svg = screen.getByTestId(`icon-${name}`);
    expect(svg.tagName).toBe('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg.querySelector('path, circle, rect')).toBeInTheDocument();
  });

  it('applies custom size', () => {
    render(<Icon name="home" size={32} data-testid="icon-sized" />);
    const svg = screen.getByTestId('icon-sized');
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
  });
});
