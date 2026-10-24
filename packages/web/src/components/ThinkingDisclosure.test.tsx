import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThinkingDisclosure } from './ThinkingDisclosure';

describe('ThinkingDisclosure', () => {
  it('shows a live window while streaming and folds when the turn ends', () => {
    const { rerender, container } = render(<ThinkingDisclosure text="Looking at the files" streaming />);
    expect(screen.getByRole('button', { name: /Thinking/ })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.hm-thinking')).toHaveAttribute('data-mode', 'live');

    rerender(<ThinkingDisclosure text="Looking at the files" streaming={false} />);
    expect(screen.getByRole('button', { name: /Thought process/ })).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.hm-thinking__body')).toBeNull();
  });

  it('stays as the person left it when streaming flickers', () => {
    const { rerender, container } = render(<ThinkingDisclosure text="step one" streaming />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.hm-thinking__body')).toBeNull();

    rerender(<ThinkingDisclosure text="step one, step two" streaming={false} />);
    rerender(<ThinkingDisclosure text="step one, step two" streaming />);
    expect(container.querySelector('.hm-thinking__body')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.hm-thinking__body')).toHaveAttribute('data-mode', 'full');
    rerender(<ThinkingDisclosure text="step one, step two" streaming={false} />);
    expect(container.querySelector('.hm-thinking__body')).toHaveAttribute('data-mode', 'full');
  });

  it('opens the full text inline after the turn', () => {
    const { container } = render(<ThinkingDisclosure text={'a\n'.repeat(80)} />);
    fireEvent.click(screen.getByRole('button', { name: /Thought process/ }));
    const body = container.querySelector('.hm-thinking__body');
    expect(body).toHaveAttribute('data-mode', 'full');
    expect(body?.textContent?.length).toBeGreaterThan(100);
  });
});
