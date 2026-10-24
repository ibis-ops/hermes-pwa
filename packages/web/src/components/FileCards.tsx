import { useEffect, useState } from 'react';
import { localFileUrl, type FileRef, type RestClient } from '@hermes-pwa/core';
import { Icon } from './Icon';

interface FileCardsProps {
  refs: FileRef[];
  /** Used to look up name, size and type; without it rows show the path only. */
  rest?: RestClient | undefined;
  /** 'assistant' cards sit under a grey bubble, 'user' cards under the blue one. */
  tone?: 'assistant' | 'user';
}

type InfoState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; size: number | undefined; mime: string | undefined }
  | { state: 'missing' }
  | { state: 'denied' };

function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function kindLabel(file: FileRef, mime: string | undefined): string {
  if (file.kind === 'image') return 'Image';
  if (mime?.startsWith('audio/')) return 'Audio';
  if (mime?.startsWith('video/')) return 'Video';
  if (file.ext === 'pdf') return 'PDF';
  return file.ext.toUpperCase();
}

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;
}

function canDescribe(rest: RestClient | undefined): rest is RestClient {
  return typeof rest?.localFileInfo === 'function';
}

function useFileInfo(file: FileRef, rest: RestClient | undefined): InfoState {
  const [info, setInfo] = useState<InfoState>({ state: canDescribe(rest) ? 'loading' : 'idle' });
  useEffect(() => {
    if (!canDescribe(rest)) {
      setInfo({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setInfo({ state: 'loading' });
    rest
      .localFileInfo(file.path)
      .then((body) => {
        if (!cancelled) setInfo({ state: 'ready', size: body.size, mime: body.mime });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = statusOf(err);
        setInfo({ state: status === 403 || status === 400 ? 'denied' : 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, rest]);
  return info;
}

function ImageCard({ file, rest }: { file: FileRef; rest: RestClient | undefined }) {
  const [failed, setFailed] = useState(false);
  const url = localFileUrl('', file.path);
  if (failed) return <FileRow file={file} rest={rest} />;
  return (
    <a
      className="hm-file-image"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open image ${file.name}`}
      data-testid="file-image"
    >
      <img src={url} alt={file.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      <span className="hm-file-image__name">{file.name}</span>
    </a>
  );
}

function FileRow({ file, rest }: { file: FileRef; rest: RestClient | undefined }) {
  const info = useFileInfo(file, rest);
  const url = localFileUrl('', file.path);
  const unavailable = info.state === 'missing' || info.state === 'denied';
  const detail =
    info.state === 'loading'
      ? ' '
      : info.state === 'missing'
        ? 'Not found on the Mac'
        : info.state === 'denied'
          ? 'Outside the shared folders'
          : info.state === 'ready'
            ? [kindLabel(file, info.mime), fmtBytes(info.size)].filter(Boolean).join(', ')
            : kindLabel(file, undefined);

  const body = (
    <>
      <span className="hm-file-row__icon" aria-hidden="true">
        <Icon name={unavailable ? 'alert' : 'file'} size={18} />
      </span>
      <span className="hm-file-row__body">
        <span className="hm-file-row__name">{file.name}</span>
        <span className="hm-file-row__meta">{detail}</span>
      </span>
      {!unavailable && (
        <span className="hm-file-row__action" aria-hidden="true">
          <Icon name="download" size={16} />
        </span>
      )}
    </>
  );

  if (unavailable) {
    return (
      <span className="hm-file-row hm-file-row--unavailable" title={file.path} data-testid="file-row">
        {body}
      </span>
    );
  }
  return (
    <a
      className="hm-file-row"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={file.path}
      aria-label={`Open ${file.name}`}
      data-testid="file-row"
    >
      {body}
    </a>
  );
}

/** Image previews and file rows for every path a message mentions. */
export function FileCards({ refs, rest, tone = 'assistant' }: FileCardsProps) {
  if (refs.length === 0) return null;
  const images = refs.filter((r) => r.kind === 'image');
  const files = refs.filter((r) => r.kind !== 'image');
  return (
    <div className={`hm-file-cards hm-file-cards--${tone}`} data-testid="file-cards">
      {images.length > 0 && (
        <div className={`hm-file-images ${images.length > 1 ? 'hm-file-images--grid' : ''}`}>
          {images.map((r) => (
            <ImageCard key={r.path} file={r} rest={rest} />
          ))}
        </div>
      )}
      {files.map((r) => (
        <FileRow key={r.path} file={r} rest={rest} />
      ))}
    </div>
  );
}
