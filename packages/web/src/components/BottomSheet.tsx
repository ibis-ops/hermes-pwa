import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute('disabled')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (element.hidden) return false;
    return true;
  });
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
}

export function BottomSheet({
  title,
  children,
  onClose,
  meta,
  footer,
  closeDisabled = false,
  className,
  contentClassName,
}: BottomSheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (!closeDisabled) {
        event.preventDefault();
        onClose();
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

  return (
    <div
      ref={dialogRef}
      className={className ? `hm-sheet ${className}` : 'hm-sheet'}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="hm-sheet__overlay" onClick={closeDisabled ? undefined : onClose} aria-hidden="true" />
      <div className={contentClassName ? `hm-sheet__content ${contentClassName}` : 'hm-sheet__content'}>
        <span className="hm-sheet__grabber" aria-hidden="true" />
        <h3 id={titleId} className="hm-sheet__title">
          {title}
        </h3>
        {meta}
        <div className="hm-sheet__body">{children}</div>
        {footer}
      </div>
    </div>
  );
}
