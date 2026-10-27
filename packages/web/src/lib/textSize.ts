/**
 * iOS Text Size (Dynamic Type) for the web app: Safari resolves the system
 * font keyword `-apple-system-body` to the Body size the person picked in
 * Settings, 17px at the default. The root font size takes that value, so
 * every rem-based size in the app follows the setting. It is held between
 * 14px and 23px: past that the fixed-height controls would clip, and the
 * accessibility sizes are served better by the system zoom.
 */
const DEFAULT_PX = 17;
const MIN_PX = 14;
const MAX_PX = 23;

function systemBodySize(): number | undefined {
  if (typeof document === 'undefined' || !document.body) return undefined;
  const probe = document.createElement('span');
  probe.style.font = '-apple-system-body';
  // Only WebKit knows the keyword; elsewhere the style is dropped.
  if (!probe.style.font) return undefined;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const size = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

export function applyTextSize(): void {
  const size = systemBodySize();
  const root = document.documentElement;
  if (size === undefined || size === DEFAULT_PX) {
    root.style.removeProperty('font-size');
    return;
  }
  root.style.fontSize = `${Math.min(MAX_PX, Math.max(MIN_PX, size))}px`;
}

/** Apply now and again whenever the app comes back, since the setting can change meanwhile. */
export function installTextSize(): void {
  if (typeof document === 'undefined') return;
  applyTextSize();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyTextSize();
  });
}
