import { useId, useState } from 'react';
import { Icon } from './Icon';

interface ThinkingDisclosureProps {
  text: string;
  /** True while this reply is still being produced. */
  streaming?: boolean | undefined;
}

/**
 * The model's reasoning, folded under a one-line header.
 *
 * While the reply streams, the newest lines show in a short window that keeps
 * itself pinned to the end (no scrolling needed, nothing to fight with the chat
 * list). When the turn ends the card folds up. A tap opens it in full, inline,
 * so the chat itself scrolls instead of a second scroll area inside it; a tap
 * made by the person always wins over the automatic state.
 */
export function ThinkingDisclosure({ text, streaming }: ThinkingDisclosureProps) {
  const [choice, setChoice] = useState<boolean | undefined>(undefined);
  const bodyId = useId();
  const live = Boolean(streaming);
  const open = choice ?? live;
  const mode = open ? (choice === undefined && live ? 'live' : 'full') : 'closed';
  // The live window fades its top edge only once there is more text than fits.
  const long = text.length > 320 || text.split('\n').length > 5;

  return (
    <div className="hm-thinking" data-mode={mode} data-live={live ? 'true' : 'false'} data-long={long ? 'true' : 'false'}>
      <button
        type="button"
        className="hm-thinking__header"
        onClick={() => setChoice((current) => !(current ?? live))}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="hm-thinking__icon" aria-hidden="true">
          <Icon name="bolt" size={14} />
        </span>
        <span className="hm-thinking__title">{live ? 'Thinking' : 'Thought process'}</span>
        {live ? <span className="hm-thinking__spinner" aria-label="thinking" /> : null}
        <span className="hm-thinking__chevron" aria-hidden="true">
          <Icon name="chevD" size={14} />
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="hm-thinking__body" data-mode={mode}>
          <pre className="hm-thinking__text">
            <code>{text}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
