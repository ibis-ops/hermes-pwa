import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Portal } from './Portal';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Past this share of the sheet's height, or this speed, a drag dismisses it. */
const DISMISS_FRACTION = 0.25;
const DISMISS_VELOCITY_PX_PER_MS = 0.6;

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute('disabled')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (element.hidden) return false;
    return true;
  });
}

interface SheetHistoryState {
  sheet?: string;
}

/**
 * A sheet that closes takes its history entry back on the next tick, not at
 * once: a sheet that unmounts and mounts again straight away (React's
 * development double mount, a key change) finds its entry still there and
 * keeps it, instead of racing a pending Back that would close it again.
 */
const pendingSheetBacks = new Map<string, ReturnType<typeof setTimeout>>();

function historyState(): SheetHistoryState | null {
  if (typeof window === 'undefined') return null;
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? (state as SheetHistoryState) : null;
}

interface BottomSheetProps {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  meta?: ReactNode;
  footer?: ReactNode;
  closeDisabled?: boolean;
  className?: string;
  contentClassName?: string;
  /** Label of the close control in the header; "Done" reads right for most sheets. */
  closeLabel?: string;
}

/**
 * A modal sheet from the bottom edge. It closes from the Done control, the
 * scrim, Escape, a downward drag on its top, and the system Back gesture: the
 * sheet puts one entry on the history stack while it is open, so Back closes
 * the sheet instead of leaving the app.
 */
export function BottomSheet({
  title,
  children,
  onClose,
  meta,
  footer,
  closeDisabled = false,
  className,
  contentClassName,
  closeLabel = 'Done',
}: BottomSheetProps) {
  const titleId = useId();
  const sheetId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startAt: number; lastY: number; lastAt: number } | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const focusInitialElement = () => {
      if (!dialog.contains(document.activeElement)) {
        (getFocusableElements(dialog)[0] ?? dialog).focus();
      }
    };

    const frame = window.requestAnimationFrame(focusInitialElement);
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, []);

  // One history entry per open sheet, so Back closes it.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.history.pushState !== 'function') return undefined;
    const pending = pendingSheetBacks.get(sheetId);
    if (pending !== undefined) {
      // Mounted again before the Back went out: the entry is still ours.
      clearTimeout(pending);
      pendingSheetBacks.delete(sheetId);
    }
    if (historyState()?.sheet !== sheetId) {
      const base = historyState() ?? {};
      try {
        window.history.pushState({ ...base, sheet: sheetId }, '');
      } catch {
        return undefined;
      }
    }
    const onPopState = () => {
      if (historyState()?.sheet === sheetId) return;
      if (closeDisabledRef.current) {
        // Keep the entry while the sheet is busy (saving): put it back.
        try {
          window.history.pushState({ ...(historyState() ?? {}), sheet: sheetId }, '');
        } catch {
          // ignore
        }
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      // Closed by the app (Done, scrim, a parent): drop the sheet's entry,
      // unless something was pushed on top of it meanwhile.
      if (historyState()?.sheet !== sheetId) return;
      pendingSheetBacks.set(
        sheetId,
        setTimeout(() => {
          pendingSheetBacks.delete(sheetId);
          if (historyState()?.sheet === sheetId) window.history.back();
        }, 0),
      );
    };
  }, [sheetId]);

  const requestClose = () => {
    if (closeDisabled) return;
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (!closeDisabled) {
        event.preventDefault();
        requestClose();
      }
      return;
    }

    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Drag on the grabber or the title row to pull the sheet down.
  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (closeDisabled || event.pointerType === 'mouse' && event.button !== 0) return;
    // A press on Done or Cancel is a tap on that button, not the start of a
    // drag: capturing the pointer here would take its click away.
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select')) return;
    const now = performance.now();
    dragRef.current = { startY: event.clientY, startAt: now, lastY: event.clientY, lastAt: now };
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const offset = Math.max(0, event.clientY - drag.startY);
    drag.lastY = event.clientY;
    drag.lastAt = performance.now();
    setDragOffset(offset);
  };

  const onDragEnd = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag) return;
    const height = contentRef.current?.getBoundingClientRect().height ?? 0;
    const travelled = Math.max(0, drag.lastY - drag.startY);
    const elapsed = Math.max(1, drag.lastAt - drag.startAt);
    const velocity = travelled / elapsed;
    const farEnough = height > 0 && travelled > height * DISMISS_FRACTION;
    if (farEnough || (velocity > DISMISS_VELOCITY_PX_PER_MS && travelled > 24)) {
      setDragOffset(0);
      requestClose();
      return;
    }
    setDragOffset(0);
  };

  return (
    <Portal>
      <div
        ref={dialogRef}
        className={className ? `hm-sheet ${className}` : 'hm-sheet'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="hm-sheet__overlay" onClick={closeDisabled ? undefined : requestClose} aria-hidden="true" />
        <div
          ref={contentRef}
          className={contentClassName ? `hm-sheet__content ${contentClassName}` : 'hm-sheet__content'}
          data-dragging={dragging ? 'true' : 'false'}
          style={dragOffset > 0 || dragging ? { transform: `translateY(${dragOffset}px)` } : undefined}
        >
          <div
            className="hm-sheet__handle"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          >
            <span className="hm-sheet__grabber" aria-hidden="true" />
            <div className="hm-sheet__bar">
              <span className="hm-sheet__bar-spacer" aria-hidden="true" />
              <h3 id={titleId} className="hm-sheet__title">
                {title}
              </h3>
              <button
                type="button"
                className="hm-sheet__done"
                onClick={requestClose}
                disabled={closeDisabled}
                aria-label={closeLabel === 'Done' ? 'Done, close this sheet' : closeLabel}
              >
                {closeLabel}
              </button>
            </div>
          </div>
          {meta}
          <div className="hm-sheet__body">{children}</div>
          {footer}
        </div>
      </div>
    </Portal>
  );
}
