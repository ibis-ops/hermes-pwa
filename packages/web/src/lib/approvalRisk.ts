import { useEffect, useRef, useState } from 'react';
import type { Approval } from '@hermes-pwa/core';

/** A second tap must land within this long, or the first is forgotten. */
export const CONFIRM_WINDOW_MS = 4000;

/**
 * The risk pill. The gateway does not rate commands (every terminal approval
 * arrives as high impact), so the pill says only what is known: a command the
 * safety check refused is flagged; the rest are simply "Command".
 */
export function riskLabel(item: Pick<Approval, 'smartDenied'>): { label: string; tone: 'danger' | 'neutral' } {
  if (item.smartDenied) return { label: 'Flagged risky', tone: 'danger' };
  return { label: 'Command', tone: 'neutral' };
}

/** Whether approving needs a second, confirming tap. */
export function needsConfirmation(item: Pick<Approval, 'smartDenied'>): boolean {
  return Boolean(item.smartDenied);
}

/**
 * Two-tap arming: the first tap arms the action and relabels the button; a
 * second tap within the window runs it; otherwise it disarms on its own.
 */
export function useArmedAction(run: () => void, enabled: boolean): { armed: boolean; trigger: () => void; disarm: () => void } {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const disarm = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    setArmed(false);
  };
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const trigger = () => {
    if (!enabled) {
      run();
      return;
    }
    if (armed) {
      disarm();
      run();
      return;
    }
    setArmed(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setArmed(false);
    }, CONFIRM_WINDOW_MS);
  };
  return { armed, trigger, disarm };
}

