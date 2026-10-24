/**
 * Hand a file from the Mac to the phone the way iOS expects.
 *
 * An installed PWA has no browser chrome: a link that opens a new tab leaves
 * the app for Safari, which has its own cookie jar and answers 401. The Web
 * Share API is the native path instead: it fetches the bytes with the app's
 * session and opens the system share sheet (Save to Photos, Save to Files,
 * AirDrop, Mail, another app). Where sharing files is not supported (desktop
 * browsers), the file is opened in a new tab as before.
 */

export type ShareOutcome = 'shared' | 'opened' | 'cancelled' | 'failed';

function canShareFiles(): boolean {
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    const probe = new File(['x'], 'probe.txt', { type: 'text/plain' });
    return nav.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

function openInNewTab(url: string): void {
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.assign(url);
}

export async function shareOrOpenFile(url: string, name: string, mime?: string): Promise<ShareOutcome> {
  if (!canShareFiles()) {
    openInNewTab(url);
    return 'opened';
  }
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const type = mime || blob.type || 'application/octet-stream';
    const file = new File([blob], name, { type });
    const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
    if (!nav.canShare?.({ files: [file] })) {
      openInNewTab(url);
      return 'opened';
    }
    await navigator.share({ files: [file], title: name });
    return 'shared';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    return 'failed';
  }
}
