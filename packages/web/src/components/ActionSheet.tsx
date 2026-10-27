import { useState, type ReactNode } from 'react';
import { BottomSheet } from './BottomSheet';
import { Icon, type IconName } from './Icon';

export interface SheetAction {
  key: string;
  label: string;
  icon?: IconName | undefined;
  /** Destructive actions read red. */
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
  /**
   * Ask once more inside the same sheet before running. A second sheet opened
   * from this one would race its history entry, so the question replaces the
   * list instead.
   */
  confirm?: { message: ReactNode; label: string } | undefined;
  onSelect: () => void | Promise<void>;
}

interface ActionSheetProps {
  title: ReactNode;
  /** One line under the title: what the actions apply to. */
  message?: ReactNode;
  actions: SheetAction[];
  onClose: () => void;
}

/**
 * The iOS action sheet: a short list of things to do with one item, with
 * destructive ones in red and, where they cannot be undone, a second
 * question in place. Cancel, the scrim, Escape, a drag and Back close it.
 */
export function ActionSheet({ title, message, actions, onClose }: ActionSheetProps) {
  const [confirming, setConfirming] = useState<SheetAction | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = async (action: SheetAction) => {
    if (running) return;
    setRunning(true);
    setError(undefined);
    try {
      await action.onSelect();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That did not work. Try again.');
      setRunning(false);
    }
  };

  const pick = (action: SheetAction) => {
    if (action.disabled || running) return;
    if (action.confirm && confirming?.key !== action.key) {
      setConfirming(action);
      return;
    }
    void run(action);
  };

  return (
    <BottomSheet
      title={title}
      onClose={onClose}
      closeDisabled={running}
      closeLabel="Cancel"
      contentClassName="hm-action-sheet"
    >
      {confirming?.confirm ? (
        <div className="hm-action-sheet__confirm" data-testid="action-sheet-confirm">
          <p className="hm-action-sheet__message">{confirming.confirm.message}</p>
          <div className="hm-action-sheet__group">
            <button
              type="button"
              className={`hm-action-sheet__item${confirming.destructive ? ' hm-action-sheet__item--destructive' : ''}`}
              onClick={() => pick(confirming)}
              disabled={running}
            >
              {running ? 'Working…' : confirming.confirm.label}
            </button>
            <button type="button" className="hm-action-sheet__item" onClick={() => setConfirming(undefined)} disabled={running}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <>
          {message ? <p className="hm-action-sheet__message">{message}</p> : null}
          <div className="hm-action-sheet__group" role="menu">
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className={`hm-action-sheet__item${action.destructive ? ' hm-action-sheet__item--destructive' : ''}`}
                onClick={() => pick(action)}
                disabled={action.disabled || running}
              >
                {action.icon ? (
                  <span className="hm-action-sheet__icon" aria-hidden="true">
                    <Icon name={action.icon} size={18} />
                  </span>
                ) : null}
                <span className="hm-action-sheet__label">{action.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {error ? (
        <p className="hm-action-sheet__error" role="alert">
          {error}
        </p>
      ) : null}
    </BottomSheet>
  );
}

interface ConfirmSheetProps {
  title: ReactNode;
  message: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

/** One question with one answer: the sheet in place of window.confirm. */
export function ConfirmSheet({ title, message, confirmLabel, destructive = false, onConfirm, onClose }: ConfirmSheetProps) {
  return (
    <ActionSheet
      title={title}
      message={message}
      actions={[{ key: 'confirm', label: confirmLabel, destructive, onSelect: onConfirm }]}
      onClose={onClose}
    />
  );
}
