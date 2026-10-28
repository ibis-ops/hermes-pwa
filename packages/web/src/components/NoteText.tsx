import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { parseObsidianNote } from '@hermes-pwa/core';
import { MARKDOWN_COMPONENTS, REHYPE_PLUGINS, REMARK_PLUGINS } from './MessageBubble.helpers';
import { linkifyWikilinks } from '../lib/wikilinks';

interface NoteTextProps {
  /** The note's file text: optional frontmatter, then Markdown. */
  text: string;
  /** Markdown renderers; the note viewer passes ones that follow [[links]]. */
  components?: Components;
  /** Turn [[wikilinks]] into links the components can catch. */
  linkWikilinks?: boolean;
}

/**
 * An Obsidian note as the app shows it: its properties in a small table, then
 * the body as Markdown. Shared by the note viewer and My notes, so both read
 * the same.
 */
export function NoteText({
  text,
  components = MARKDOWN_COMPONENTS,
  linkWikilinks = false,
}: NoteTextProps) {
  const parsed = useMemo(() => parseObsidianNote(text), [text]);
  const body = useMemo(
    () => (linkWikilinks ? linkifyWikilinks(parsed.body) : parsed.body),
    [parsed, linkWikilinks],
  );
  return (
    <>
      {parsed.properties.length > 0 ? (
        <dl className="hm-note-view__props" data-testid="note-properties">
          {parsed.properties.map((property) => (
            <div key={property.key} className="hm-note-view__prop">
              <dt>{property.key}</dt>
              <dd>{property.value || '(empty)'}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="hm-message__text hm-note-view__body" data-testid="note-body">
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
        >
          {body}
        </ReactMarkdown>
      </div>
    </>
  );
}
