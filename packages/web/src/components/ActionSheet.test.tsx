import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActionSheet } from './ActionSheet';

describe('ActionSheet', () => {
  it('runs a plain action and closes', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ActionSheet title="Chat" actions={[{ key: 'a', label: 'Archive', onSelect }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('asks once more before a destructive action, and Back returns to the list', async () => {
    const onSelect = vi.fn();
    render(
      <ActionSheet
        title="Chat"
        actions={[{ key: 'd', label: 'Delete', destructive: true, confirm: { message: 'Sure?', label: 'Delete chat' }, onSelect }]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  });

  it('keeps the sheet open with the error when the action fails', async () => {
    const onClose = vi.fn();
    render(
      <ActionSheet
        title="Chat"
        actions={[{ key: 'a', label: 'Archive', onSelect: () => Promise.reject(new Error('Gateway said no')) }]}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Gateway said no'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
