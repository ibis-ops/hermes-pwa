import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/tokens.css';
import './pwa/install';
import { installVitePreloadErrorReload } from './pwa/preloadError';
import { registerServiceWorker } from './pwa/registerSW';
import { installPushForegroundHandling } from './pwa/push';
import { applyAppearance, readAppearance } from './lib/appearance';
import { installTextSize } from './lib/textSize';

// Before the first paint, so a forced light or dark theme never flashes the
// other, and text starts at the size the phone is set to.
applyAppearance(readAppearance());
installTextSize();

installVitePreloadErrorReload();
void registerServiceWorker();
installPushForegroundHandling();

// The chat is the first screen: fetch its chunk (markdown, highlighter)
// alongside the shell instead of after it. The other screens follow once the
// main thread is idle, so a tab tap never waits on the network.
void import('./screens/Chat');
const warmOtherScreens = () => {
  void Promise.allSettled([
    import('./screens/Activity'),
    import('./screens/Sessions'),
    import('./screens/Home'),
    import('./screens/Settings'),
    import('./screens/Profiles'),
    import('./screens/Obsidian'),
    import('./screens/Agents'),
    import('./screens/Cron'),
    import('./screens/Projects'),
    import('./screens/CommandCenter'),
    import('./screens/Messaging'),
    import('./screens/Artifacts'),
  ]);
};
// Safari has no requestIdleCallback; a short timer does the same job there.
if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(warmOtherScreens, { timeout: 4000 });
} else {
  window.setTimeout(warmOtherScreens, 1500);
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
