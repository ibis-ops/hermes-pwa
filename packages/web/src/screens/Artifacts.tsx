import { useEffect, useState } from 'react';
import { localFileUrl, useChatStore, type RestClient, type Artifact as DomainArtifact } from '@hermes-pwa/core';

interface ArtifactsProps {
  rest: RestClient;
}

type ArtifactKind = 'image' | 'file' | 'link' | 'other';
type Filter = 'all' | 'images' | 'files' | 'links';

interface Artifact {
  id: string;
  kind: ArtifactKind;
  name: string;
  url: string | undefined;
  mimeType: string | undefined;
  size: number | undefined;
  createdAt: number;
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'images', label: 'Images' },
  { key: 'files', label: 'Files' },
  { key: 'links', label: 'Links' },
];

function detectKind(type: string): ArtifactKind {
  const t = type.toLowerCase();
  if (t === 'image' || t.startsWith('image/')) return 'image';
  if (t === 'link' || t === 'text/uri-list') return 'link';
  if (t === 'file' || t) return 'file';
  return 'other';
}

function parseArtifact(raw: DomainArtifact): Artifact {
  return {
    id: raw.id,
    kind: detectKind(raw.type),
    name: raw.name,
    url: raw.path,
    mimeType: raw.type,
    size: undefined,
    createdAt: raw.createdAt,
  };
}

function fmtSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Only plain web links are opened as-is. A filesystem path goes through the
 * plugin's file route; anything else (javascript:, data:, custom schemes) is
 * not a link the app will follow.
 */
function safeArtifactHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('~/')) return localFileUrl('', trimmed);
  return undefined;
}

function ArtifactItem({ artifact }: { artifact: Artifact }) {
  const icon = artifact.kind === 'image' ? '🖼' : artifact.kind === 'link' ? '🔗' : '📎';
  const href = safeArtifactHref(artifact.url);
  return (
    <div className="hm-artifact-row" data-testid="artifact-row">
      <span className="hm-artifact-row__icon" aria-hidden="true">{icon}</span>
      <span className="hm-artifact-row__body">
        <span className="hm-artifact-row__name">{artifact.name}</span>
        {(artifact.mimeType || artifact.size) && (
          <span className="hm-artifact-row__meta hm-muted">
            {[artifact.mimeType, fmtSize(artifact.size)].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
      {href && (
        <a
          href={href}
          className="hm-ghost hm-artifact-row__action"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${artifact.name}`}
        >
          ↗
        </a>
      )}
    </div>
  );
}

export function Artifacts({ rest }: ArtifactsProps) {
  const sessionId = useChatStore((s) => s.sessionId);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    void rest
      .sessionArtifacts(sessionId)
      .then((raw) => setArtifacts(raw.map(parseArtifact)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [rest, sessionId]);

  const filtered = artifacts.filter((a) => {
    if (filter === 'images') return a.kind === 'image';
    if (filter === 'files') return a.kind === 'file';
    if (filter === 'links') return a.kind === 'link';
    return true;
  });

  return (
    <div className="hm-artifacts">
      {!sessionId ? (
        <div className="hm-empty-state">
          <span style={{ fontSize: 36 }} aria-hidden="true">📎</span>
          <p>No active session</p>
          <p className="hm-muted">Start a chat to see artifacts.</p>
        </div>
      ) : (
        <>
          <div className="hm-artifacts__filters" role="tablist" aria-label="Artifact type filters">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`hm-filter-chip${filter === f.key ? ' hm-filter-chip--active' : ''}`}
                onClick={() => setFilter(f.key)}
                role="tab"
                aria-selected={filter === f.key}
              >
                {f.label}
              </button>
            ))}
          </div>

          {error && <div className="hm-warning-banner hm-warning-banner--error">{error}</div>}
          {loading && <p className="hm-muted hm-loading">Loading artifacts…</p>}

          {filtered.length === 0 && !loading ? (
            <div className="hm-empty-state">
              <p>No artifacts</p>
              <p className="hm-muted">Files and images from this session will appear here.</p>
            </div>
          ) : (
            <div className="hm-artifacts__list">
              {filtered.map((a) => (
                <ArtifactItem key={a.id} artifact={a} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
