import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from '@hermes-pwa/core';
import { SkillPicker } from './SkillPicker';

const skills = [
  { id: 'obsidian', name: 'obsidian', description: 'Notes in the vault', category: 'note-taking', enabled: true },
  { id: 'pdf', name: 'pdf', description: 'PDF files', category: 'productivity', enabled: true },
  { id: 'off', name: 'off', description: 'Disabled one', category: 'productivity', enabled: false },
];

describe('SkillPicker', () => {
  it('groups enabled skills by category, searches, and hands back the pick', async () => {
    const rest = { skillsList: vi.fn().mockResolvedValue(skills) } as unknown as RestClient;
    const onPick = vi.fn();
    render(<SkillPicker rest={rest} onPick={onPick} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByTestId('skill-row')).toHaveLength(2));
    expect(screen.getByText('Note Taking')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'vault' } });
    expect(screen.getAllByTestId('skill-row')).toHaveLength(1);
    fireEvent.click(screen.getByText('/obsidian'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'obsidian' }));
  });

  it('offers None for a default and marks the current choice', async () => {
    const rest = { skillsList: vi.fn().mockResolvedValue(skills) } as unknown as RestClient;
    const onPick = vi.fn();
    render(<SkillPicker rest={rest} selected="pdf" allowNone onPick={onPick} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getAllByTestId('skill-row')).toHaveLength(2));
    expect(screen.getByText('/pdf').closest('button')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByText('None'));
    expect(onPick).toHaveBeenCalledWith(undefined);
  });
});
