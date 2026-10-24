import type { Approval } from '@hermes-pwa/core';

export interface ApprovalText {
  /** Full command when known, otherwise the list summary. */
  text: string | undefined;
  /** True when the text may not be the whole command (redacted or cut short). */
  incomplete: boolean;
}

/**
 * The approval card must show what will actually run. REST records carry a
 * redacted `summary` for lists plus the full `command`; live WS events carry
 * the command verbatim. Flag anything that looks shortened so nobody approves
 * a command they cannot read.
 */
export function approvalText(item: Pick<Approval, 'summary' | 'command' | 'commandComplete'>): ApprovalText {
  if (item.command) {
    return { text: item.command, incomplete: item.commandComplete === false };
  }
  const summary = item.summary;
  const incomplete = Boolean(summary && (/\[redacted\]/.test(summary) || /…$/.test(summary.trim())));
  return { text: summary, incomplete };
}
