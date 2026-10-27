/**
 * Audio for the page's <audio> element as blob: URLs. The app's content
 * security policy allows media from 'self' and blob: only, so a data: URL
 * handed to an audio element is refused and plays nothing.
 */

// A 2-sample silent WAV: played inside a tap so iOS lets later audio start.
const SILENT_WAV_BASE64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

let silentUrl: string | undefined;

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function base64ToObjectUrl(base64: string, mimeType: string): string {
  return URL.createObjectURL(base64ToBlob(base64, mimeType));
}

/** A data: URL (as Hermes's own speech route returns) as a playable blob: URL. */
export function dataUrlToObjectUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
  if (!header.startsWith('data:') || !header.includes(';base64')) {
    throw new Error('Speech audio was not base64.');
  }
  const mimeType = header.slice(5, header.indexOf(';')) || 'audio/mpeg';
  return base64ToObjectUrl(dataUrl.slice(comma + 1), mimeType);
}

/** One shared blob: URL of a silent WAV, made on first use and never revoked. */
export function silentAudioUrl(): string {
  silentUrl ??= base64ToObjectUrl(SILENT_WAV_BASE64, 'audio/wav');
  return silentUrl;
}
