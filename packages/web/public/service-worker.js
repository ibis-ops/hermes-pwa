const CACHE_PREFIX = 'hermes-mobile-';
const CACHE_VERSION = 'hermes-mobile-v82';
const SHELL_CACHE = `${CACHE_VERSION}:shell`;
const RUNTIME_ASSET_CACHE = 'hermes-mobile-runtime-assets';
const RUNTIME_ASSET_CACHE_MAX_ENTRIES = 60;
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// The hashed bundle files index.html references. Caching them at install
// means a cold launch (and the first launch after an update) never waits on
// the network for the shell, and an offline launch still works.
async function entryAssetsFromIndex() {
  try {
    const response = await fetch('./index.html', { cache: 'no-store' });
    if (!response.ok) return [];
    const html = await response.text();
    const found = new Set();
    const pattern = /(?:src|href)="(\.\/assets\/[^"]+\.(?:js|css))"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) found.add(match[1]);
    return [...found];
  } catch {
    return [];
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        const assets = await entryAssetsFromIndex();
        return Promise.allSettled([...APP_SHELL, ...assets].map((asset) => cache.add(asset)));
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_ASSET_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => removeEntryShellAssetsFromRuntimeCache())
      .then(() => self.clients.claim()),
  );
});

function isHermesDataApi(url) {
  return url.pathname.startsWith('/api/') && !url.pathname.includes('/api/plugins/hermes-pwa/app/');
}

function isRuntimeAsset(url) {
  return url.pathname.includes('/api/plugins/hermes-pwa/app/assets/') || url.pathname.includes('/assets/');
}

function isEntryShellAsset(url) {
  return isRuntimeAsset(url) && /\/assets\/index-[^/]+\.(?:js|css)$/u.test(url.pathname);
}

function appScope() {
  return (self.registration && self.registration.scope) || (self.location ? self.location.href : '');
}

function isOwnOrigin(url) {
  const scope = appScope();
  if (!scope) return true;
  return url.origin === new URL(scope).origin;
}

function isWithinAppScope(url) {
  const scope = appScope();
  return Boolean(scope) && url.href.startsWith(scope);
}

function isStaticShellAsset(url) {
  // Only this app's own files are cached: same origin, inside the app scope
  // (or its hashed asset directory). Cross-origin images and anything under
  // /api/ never enter CacheStorage, so a logout leaves nothing private behind.
  if (!isOwnOrigin(url)) return false;
  if (!isWithinAppScope(url) && !isRuntimeAsset(url)) return false;
  return isRuntimeAsset(url) ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.webmanifest');
}

function isCacheableAssetResponse(response) {
  if (!response || !response.ok) return false;
  if (response.type === 'opaque' || response.type === 'error') return false;
  const type = (response.headers && response.headers.get('content-type')) || '';
  return !/text\/html/i.test(type);
}

function staticAssetCacheName(url) {
  if (isEntryShellAsset(url)) return SHELL_CACHE;
  return isRuntimeAsset(url) ? RUNTIME_ASSET_CACHE : SHELL_CACHE;
}

async function removeEntryShellAssetsFromRuntimeCache() {
  const cache = await caches.open(RUNTIME_ASSET_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.filter((request) => isEntryShellAsset(new URL(request.url))).map((request) => cache.delete(request)));
}

async function trimRuntimeAssetCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - RUNTIME_ASSET_CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((request) => cache.delete(request)));
}

function safeNotificationPayload(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }
  const title = typeof data.title === 'string' && data.title.trim() ? data.title : 'Hermes Mobile';
  const body = typeof data.body === 'string' && data.body.trim() ? data.body : 'Hermes has an update.';
  const tag = typeof data.tag === 'string' && data.tag.trim() ? data.tag : 'hermes-mobile';
  const url = typeof data.url === 'string' && data.url.startsWith('./') ? data.url : './index.html';
  return {
    title: title.slice(0, 80),
    kind: typeof data.type === 'string' ? data.type : 'notice',
    options: {
      body: body.slice(0, 180),
      tag,
      data: { url },
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      requireInteraction: data.type === 'approval.request',
    },
  };
}

// Safari expects a notification for every push, so one is always shown. The
// open app is told about it and closes an "answer ready" banner when the
// person is already looking at the chat.
async function tellOpenClients(payload) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage({ type: 'hermes-push', kind: payload.kind, tag: payload.options.tag });
  }
}

self.addEventListener('push', (event) => {
  const payload = safeNotificationPayload(event);
  event.waitUntil(
    self.registration
      .showNotification(payload.title, payload.options)
      .then(() => tellOpenClients(payload))
      .catch(() => undefined),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const scope = self.registration.scope;
      for (const client of clientList) {
        if (client.url && client.url.startsWith(scope)) {
          if ('focus' in client) {
            client.focus();
          }
          // The running app switches screens itself: no reload, the chat and
          // its scroll position stay as they were.
          if ('postMessage' in client) {
            client.postMessage({ type: 'hermes-open', url: target });
            return undefined;
          }
          if ('navigate' in client) {
            return client.navigate(target);
          }
          return undefined;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
      return undefined;
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isHermesDataApi(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => response)
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./offline.html'))),
    );
    return;
  }

  if (isStaticShellAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Only a real asset goes in the cache. An error page, or the HTML
          // shell served in place of a missing chunk, must not be kept and
          // served as that file forever.
          if (!isCacheableAssetResponse(response)) return response;
          const copy = response.clone();
          const cacheName = staticAssetCacheName(url);
          caches.open(cacheName).then((cache) => cache
            .put(request, copy)
            .then(() => {
              if (cacheName === RUNTIME_ASSET_CACHE) return trimRuntimeAssetCache(cache);
              return undefined;
            }));
          return response;
        });
      }),
    );
  }
});
