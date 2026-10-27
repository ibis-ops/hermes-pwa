import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders an overlay (a sheet, the image viewer) at the end of the page body,
 * outside every screen. A sheet opened from inside a scrolling screen could
 * otherwise be cut off at that screen's edge on iPhone: the System screen's
 * "Restart gateway" button ended up hidden behind the tab bar.
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(children, document.body);
}
