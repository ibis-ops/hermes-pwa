import { useState } from 'react';

/** Lines of a command shown before "Show full command". */
const COMMAND_PREVIEW_LINES = 8;
/** The command exactly as it will run, folded past a few lines. */
export function CommandBlock({ text, className }: { text: string; className: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > COMMAND_PREVIEW_LINES || text.length > 600;
  const shown = long && !expanded ? lines.slice(0, COMMAND_PREVIEW_LINES).join('\n').slice(0, 600) : text;
  return (
    <div className="hm-approval-command">
      <pre className={className} data-collapsed={long && !expanded ? 'true' : 'false'}>{shown}</pre>
      {long ? (
        <button type="button" className="hm-approval-command__more" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? 'Show less' : `Show full command (${lines.length} lines)`}
        </button>
      ) : null}
    </div>
  );
}
