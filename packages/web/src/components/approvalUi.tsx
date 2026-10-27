import { COMMAND_PREVIEW_CHARS, COMMAND_PREVIEW_LINES, isLongCommand } from '../lib/approvalRisk';

function foldLabel(text: string): string {
  const lines = text.split('\n').length;
  return lines > 1 ? `Show full command (${lines} lines)` : `Show full command (${text.length} characters)`;
}

/**
 * The command exactly as it will run, folded past a few lines. The card that
 * shows it keeps Approve from running a folded command (see the cards): what
 * is approved is always what was on screen.
 */
export function CommandBlock({
  text,
  className,
  expanded,
  onExpandedChange,
}: {
  text: string;
  className: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const long = isLongCommand(text);
  const shown = long && !expanded ? text.split('\n').slice(0, COMMAND_PREVIEW_LINES).join('\n').slice(0, COMMAND_PREVIEW_CHARS) : text;
  return (
    <div className="hm-approval-command">
      <pre className={className} data-collapsed={long && !expanded ? 'true' : 'false'}>{shown}</pre>
      {long ? (
        <button type="button" className="hm-approval-command__more" onClick={() => onExpandedChange(!expanded)} aria-expanded={expanded}>
          {expanded ? 'Show less' : foldLabel(text)}
        </button>
      ) : null}
    </div>
  );
}
