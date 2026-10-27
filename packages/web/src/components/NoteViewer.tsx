import { createElement, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { obsidianOpenUrl, parseObsidianNote, type ObsidianNote, type ObsidianNoteContent, type RestClient } from '@hermes-pwa/core';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { MARKDOWN_COMPONENTS, REHYPE_PLUGINS, REMARK_PLUGINS } from './MessageBubble.helpers';
import { formatClockTime, formatDayLabel } from '../lib/chatTime';
import { SkeletonRows } from './Skeleton';
import { linkifyWikilinks, wikilinkCandidates, wikilinkTarget } from '../lib/wikilinks';

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
function noteAt(from: ObsidianNote, path: string): ObsidianNote {
  const slash = path.lastIndexOf('/');
  return {
    ...from,
    path,
    name: (slash >= 0 ? path.slice(slash + 1) : path).replace(/\.(md|canvas|base)$/i, ''),
    folder: slash >= 0 ? path.slice(0, slash) : '',
  };
}

export function NoteViewer({ rest, note: initialNote, linkVault, onClose }: NoteViewerProps) {
  // Following a [[link]] opens the target here; Back in the header returns.
  const [trail, setTrail] = useState<ObsidianNote[]>([initialNote]);
  const note = trail[trail.length - 1] ?? initialNote;
  const [content, setContent] = useState<ObsidianNoteContent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [missingLink, setMissingLink] = useState<string | undefined>(undefined);
  const [following, setFollowing] = useState(false);

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
  const body = useMemo(() => (parsed ? linkifyWikilinks(parsed.body) : ''), [parsed]);
  const modified = content?.modifiedAt;

  const followLink = async (target: string) => {
    if (following) return;
    setFollowing(true);
    setMissingLink(undefined);
    try {
      for (const path of wikilinkCandidates(target, note.folder)) {
        try {
          const next = await rest.obsidianNote(note.vault, path);
          if (next) {
            setTrail((current) => [...current, noteAt(note, path)]);
            return;
          }
        } catch {
          // Not at this path; try the next.
        }
      }
      setMissingLink(target);
    } finally {
      setFollowing(false);
    }
  };

  const components = useMemo(
    () => ({
      ...MARKDOWN_COMPONENTS,
      a: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
        const target = wikilinkTarget(href);
        if (!target) return MARKDOWN_COMPONENTS.a({ href, children, ...rest });
        const { node: _hast, ...props } = rest;
        void _hast;
        return createElement(
          'a',
          {
            ...props,
            href,
            className: 'hm-note-view__wikilink',
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              void followLink(target);
            },
          },
          children,
        );
      },
    }),
    // followLink reads the note in view; rebuilt when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.path, note.vault, following],
  );

  return (
    <BottomSheet
      title={note.name}
      onClose={onClose}
      className="hm-sheet--note"
      contentClassName="hm-note-view"
      meta={
        <div className="hm-note-view__meta-row">
          {trail.length > 1 ? (
            <button
              type="button"
              className="hm-note-view__back"
              onClick={() => {
                setMissingLink(undefined);
                setTrail((current) => current.slice(0, -1));
              }}
            >
              <Icon name="chevR" size={14} />
              <span>{trail[trail.length - 2]?.name ?? 'Back'}</span>
            </button>
          ) : null}
          <p className="hm-note-view__meta hm-muted">
            {note.folder ? `${note.folder} · ` : ''}
            {note.vault}
            {modified ? ` · edited ${formatDayLabel(modified)} ${formatClockTime(modified)}` : ''}
          </p>
        </div>
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
      {missingLink ? (
        <div className="hm-warning-banner" role="status" data-testid="wikilink-missing">
          “{missingLink}” is not next to this note on the Mac.{' '}
          <a href={obsidianOpenUrl(linkVault, missingLink)}>Look for it in Obsidian</a>
        </div>
      ) : null}
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
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
            {body}
          </ReactMarkdown>
        </div>
      ) : null}
    </BottomSheet>
  );
}
