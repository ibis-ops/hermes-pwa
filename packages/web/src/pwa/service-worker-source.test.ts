import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const serviceWorkerSource = readFileSync(
  join(process.cwd(), 'packages/web/public/service-worker.js'),
  'utf8',
);
const vitestConfigSource = readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf8');

describe('service worker source', () => {
  it('keeps Hermes data APIs out of the shell cache', () => {
    expect(serviceWorkerSource).toContain("startsWith('/api/')");
    expect(serviceWorkerSource).toContain("/api/plugins/hermes-pwa/app/");
  });

  it('pre-caches app shell assets independently instead of all-or-nothing addAll', () => {
    expect(serviceWorkerSource).toContain('Promise.allSettled');
    expect(serviceWorkerSource).not.toContain('.addAll(APP_SHELL)');
  });

  it('keeps lazy chunks in an unversioned runtime cache across shell cache upgrades', () => {
    expect(serviceWorkerSource).toContain("const CACHE_PREFIX = 'hermes-mobile-'");
    expect(serviceWorkerSource).toContain("const RUNTIME_ASSET_CACHE = 'hermes-mobile-runtime-assets'");
    expect(serviceWorkerSource).toContain("key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_ASSET_CACHE");
    expect(serviceWorkerSource).toContain('function isRuntimeAsset(url)');
    expect(serviceWorkerSource).toContain('staticAssetCacheName(url)');
    expect(serviceWorkerSource).toContain('caches.open(cacheName)');
  });

  it('bounds the unversioned runtime asset cache without trimming the active entry chunk', () => {
    expect(serviceWorkerSource).toContain('const RUNTIME_ASSET_CACHE_MAX_ENTRIES = 60');
    expect(serviceWorkerSource).toContain('function isEntryShellAsset(url)');
    expect(serviceWorkerSource).toContain("/\\/assets\\/index-[^/]+\\.(?:js|css)$/u.test(url.pathname)");
    expect(serviceWorkerSource).toContain('if (isEntryShellAsset(url)) return SHELL_CACHE');
    expect(serviceWorkerSource).toContain('async function removeEntryShellAssetsFromRuntimeCache()');
    expect(serviceWorkerSource).toContain('removeEntryShellAssetsFromRuntimeCache()');
    expect(serviceWorkerSource).toContain('async function trimRuntimeAssetCache(cache)');
    expect(serviceWorkerSource).toContain('keys.length - RUNTIME_ASSET_CACHE_MAX_ENTRIES');
    expect(serviceWorkerSource).toContain('keys.slice(0, excess).map((request) => cache.delete(request))');
    expect(serviceWorkerSource).toContain('if (cacheName === RUNTIME_ASSET_CACHE) return trimRuntimeAssetCache(cache)');
  });

  it('falls back to the cached app shell before the static offline page for navigations', () => {
    expect(serviceWorkerSource).toContain("caches.match('./index.html').then((cached) => cached || caches.match('./offline.html'))");
  });

  it('still shows push notifications by default', () => {
    expect(serviceWorkerSource).toContain("self.addEventListener('push'");
    expect(serviceWorkerSource).toContain('safeNotificationPayload(event)');
    expect(serviceWorkerSource).toContain('showNotification(payload.title, payload.options)');
  });

  it('sanitizes push payloads and falls back safely for malformed data', () => {
    expect(serviceWorkerSource).toContain('event.data ? event.data.json() : {}');
    expect(serviceWorkerSource).toContain("data = { body: event.data ? event.data.text() : '' }");
    expect(serviceWorkerSource).toContain("'Hermes Mobile'");
    expect(serviceWorkerSource).toContain("'Hermes has an update.'");
    expect(serviceWorkerSource).toContain("data.url.startsWith('./')");
    expect(serviceWorkerSource).toContain("'./index.html'");
    expect(serviceWorkerSource).toContain("requireInteraction: data.type === 'approval.request'");
  });

  it('routes notification clicks to existing PWA clients or opens a safe app window', () => {
    expect(serviceWorkerSource).toContain("self.addEventListener('notificationclick'");
    expect(serviceWorkerSource).toContain('event.notification.close()');
    expect(serviceWorkerSource).toContain("self.clients.matchAll({ type: 'window', includeUncontrolled: true })");
    expect(serviceWorkerSource).toContain('client.url.startsWith(scope)');
    expect(serviceWorkerSource).toContain('client.focus()');
    expect(serviceWorkerSource).toContain("client.postMessage({ type: 'hermes-open', url: target })");
    expect(serviceWorkerSource).toContain('client.navigate(target)');
    expect(serviceWorkerSource).toContain('self.clients.openWindow(target)');
  });

  it('keeps public service worker code visible to coverage configuration', () => {
    expect(vitestConfigSource).not.toContain("'**/public/**'");
    expect(vitestConfigSource).not.toContain('"**/public/**"');
  });
});
