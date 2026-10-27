import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { obsidianOpenUrl, parseObsidianNote, type ObsidianNote, type ObsidianNoteContent, type RestClient } from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { MARKDOWN_COMPONENTS, REHYPE_PLUGINS, REMARK_PLUGINS } from './MessageBubble.helpers';
import { formatClockTime, formatDayLabel } from '../lib/chatTime';
import { SkeletonRows } from './Skeleton';

interface NoteViewerProps {
  rest: RestClient;
  note: ObsidianNote;
  /** Vault name the Obsidian link should open. */
  linkVault: string | undefined;
  onClose: () => void;
}

/**
 * A note read straight from the vault on the Mac, so it is readable the
 * moment the agent writes it, whether or not the phone's Obsidian has synced
 * it yet. "Open in Obsidian" hands the same note to the app.
 */
export function NoteViewer({ rest, note, linkVault, onClose }: NoteViewerProps) {
  const [content, setContent] = useState<ObsidianNoteContent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setContent(undefined);
    setError(undefined);
    rest
      .obsidianNote(note.vault, note.path)
      .then((next) => {
        if (!cancelled) setContent(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : 'Could not read the note.');
      });
    return () => {
      cancelled = true;
    };
  }, [rest, note.vault, note.path]);

  const parsed = useMemo(() => (content ? parseObsidianNote(content.text) : undefined), [content]);
  const modified = content?.modifiedAt;

  return (
    <BottomSheet
      title={note.name}
      onClose={onClose}
      className="hm-sheet--note"
      contentClassName="hm-note-view"
      meta={
        <p className="hm-note-view__meta hm-muted">
          {note.folder ? `${note.folder} · ` : ''}
          {note.vault}
          {modified ? ` · edited ${formatDayLabel(modified)} ${formatClockTime(modified)}` : ''}
        </p>
      }
      footer={
        <div className="hm-note-view__footer">
          <a className="hm-note-view__open" href={obsidianOpenUrl(linkVault, note.path)} data-testid="note-open-link">
            <Icon name="note" size={16} />
            Open in Obsidian
          </a>
          <p className="hm-note-view__hint hm-muted">
            Needs the note on this phone already. If Obsidian says it is not found, the vault has not synced it yet.
          </p>
        </div>
      }
    >
      {error ? <div className="hm-warning-banner hm-warning-banner--error">{error}</div> : null}
      {!content && !error ? <SkeletonRows rows={5} kind="chat" label="Loading note" /> : null}
      {parsed && parsed.properties.length > 0 ? (
        <dl className="hm-note-view__props" data-testid="note-properties">
          {parsed.properties.map((property) => (
            <div key={property.key} className="hm-note-view__prop">
              <dt>{property.key}</dt>
              <dd>{property.value || '(empty)'}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {parsed ? (
        <div className="hm-message__text hm-note-view__body" data-testid="note-body">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {parsed.body}
          </ReactMarkdown>
        </div>
      ) : null}
    </BottomSheet>
  );
}
