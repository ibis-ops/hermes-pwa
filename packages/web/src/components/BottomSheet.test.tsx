import { StrictMode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';

describe('BottomSheet', () => {
  it('renders as a modal dialog labelled by its title', () => {
    render(
      <BottomSheet title="Model" onClose={vi.fn()}>
        <button type="button">Save</button>
      </BottomSheet>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Model' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes on Escape when closing is enabled', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet title="New task" onClose={onClose}>
        <button type="button">Create</button>
      </BottomSheet>,
    );

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'New task' }), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps keyboard focus inside the sheet', () => {
    render(
      <BottomSheet title="Focus trap" onClose={vi.fn()}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </BottomSheet>,
    );

    // The Done control in the header is the first focusable element.
    const done = screen.getByRole('button', { name: /Done/ });
    const last = screen.getByRole('button', { name: 'Last' });
    done.focus();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Focus trap' }), { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Focus trap' }), { key: 'Tab' });
    expect(done).toHaveFocus();
  });

  it('closes from the Done control and from the system Back gesture', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet title="Pick a vault" onClose={onClose}>
        <p>Body</p>
      </BottomSheet>,
    );
    expect(window.history.state?.sheet).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Back: the browser pops the sheet's entry and the sheet closes itself.
    window.history.replaceState({}, '');
    fireEvent(window, new PopStateEvent('popstate', { state: {} }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('stays open through a quick unmount and mount (StrictMode in development)', async () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <BottomSheet title="Strict" onClose={onClose}>
          <p>Body</p>
        </BottomSheet>
      </StrictMode>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onClose).not.toHaveBeenCalled();
    expect(window.history.state?.sheet).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Strict' })).toBeInTheDocument();
  });

  it('closes after a long downward drag on the handle', () => {
    const onClose = vi.fn();
    // The sheet renders at the end of the body, outside the render container.
    const { baseElement } = render(
      <BottomSheet title="Drag me" onClose={onClose}>
        <p>Body</p>
      </BottomSheet>,
    );
    const handle = baseElement.querySelector('.hm-sheet__handle')!;
    const content = baseElement.querySelector('.hm-sheet__content') as HTMLElement;
    content.getBoundingClientRect = () => ({ height: 400, width: 390, top: 0, left: 0, right: 390, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerMove(handle, { clientY: 260, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 260, pointerId: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders at the end of the page body, outside the screen that opened it', () => {
    const { container } = render(
      <div className="hm-command hm-scroll">
        <BottomSheet title="Restart the gateway?" onClose={() => undefined}>
          <button type="button">Restart gateway</button>
        </BottomSheet>
      </div>,
    );
    const sheet = screen.getByRole('dialog', { name: 'Restart the gateway?' });
    expect(container.contains(sheet)).toBe(false);
    expect(sheet.parentElement).toBe(document.body);
    expect(screen.getByRole('button', { name: 'Restart gateway' })).toBeInTheDocument();
  });
});
