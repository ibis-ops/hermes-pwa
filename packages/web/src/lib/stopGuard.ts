/**
 * Stop takes the send arrow's place the moment a message goes out. These keep
 * it from ending a run by accident.
 */

/** Stop ignores taps this long after a send. */
export const STOP_GUARD_MS = 1500;

/** A first tap on Stop asks; a second within this window stops the reply. */
export const STOP_CONFIRM_MS = 4000;
