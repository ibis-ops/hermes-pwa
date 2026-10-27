import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const serviceWorkerSource = readFileSync(
  join(process.cwd(), 'packages/web/public/service-worker.js'),
  'utf8',
);

class FakeCache {
  private entries = new Map<string, Response>();

  async add(asset: string): Promise<void> {
    const url = new URL(asset, 'https://example.test/api/plugins/hermes-pwa/app/').href;
    this.entries.set(url, new Response(`cached:${asset}`));
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }

  async match(request: Request | string): Promise<Response | undefined> {
    const url = typeof request === 'string'
      ? new URL(request, 'https://example.test/api/plugins/hermes-pwa/app/').href
      : request.url;
    return this.entries.get(url)?.clone();
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

function makeHarness() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const cacheStores = new Map<string, FakeCache>();
  const fetchMock = vi.fn(async (request: Request) => new Response(`network:${request.url}`));
  const self = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    registration: { scope: 'https://example.test/api/plugins/hermes-pwa/app/' },
  };
  const caches = {
    async open(name: string): Promise<FakeCache> {
      const existing = cacheStores.get(name);
      if (existing) return existing;
      const next = new FakeCache();
      cacheStores.set(name, next);
      return next;
    },
    async keys(): Promise<string[]> {
      return [...cacheStores.keys()];
    },
    async delete(name: string): Promise<boolean> {
      return cacheStores.delete(name);
    },
    async match(request: Request | string): Promise<Response | undefined> {
      for (const cache of cacheStores.values()) {
        const match = await cache.match(request);
        if (match) return match;
      }
      return undefined;
    },
  };

  vm.runInNewContext(serviceWorkerSource, {
    URL,
    Request,
    Response,
    caches,
    console,
    fetch: fetchMock,
    self,
  });

  async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    const waits: Array<Promise<unknown>> = [];
    const fullEvent = {
      ...event,
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise);
      },
    };
    for (const handler of listeners.get(type) ?? []) handler(fullEvent);
    await Promise.all(waits);
  }

  async function fetchThroughServiceWorker(url: string, options: { rejectNetwork?: boolean } = {}): Promise<Response> {
    const request = new Request(url);
    const responses: Array<Promise<Response>> = [];
    if (options.rejectNetwork) {
      fetchMock.mockRejectedValueOnce(new Error('offline'));
    }
    const event = {
      request,
      respondWith(promise: Promise<Response>) {
        responses.push(promise);
      },
    };
    for (const handler of listeners.get('fetch') ?? []) handler(event);
    if (responses.length === 0) throw new Error(`no fetch response for ${url}`);
    const responsePromise = responses[0];
    if (!responsePromise) throw new Error(`missing fetch response for ${url}`);
    const response = await responsePromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return response as Response;
  }

  async function navigateOffline(): Promise<Response> {
    const responses: Array<Promise<Response>> = [];
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const event = {
      request: { method: 'GET', mode: 'navigate', url: 'https://example.test/api/plugins/hermes-pwa/app/' },
      respondWith(promise: Promise<Response>) {
        responses.push(promise);
      },
    };
    for (const handler of listeners.get('fetch') ?? []) handler(event);
    if (responses.length === 0) throw new Error('no navigation response');
    const responsePromise = responses[0];
    if (!responsePromise) throw new Error('missing navigation response');
    return responsePromise as Promise<Response>;
  }

  return { cacheStores, dispatch, fetchThroughServiceWorker, navigateOffline, fetchMock };
}

describe('service worker runtime cache behavior', () => {
  it('keeps entry assets out of runtime trimming and serves the shell offline after repeated deploy churn', async () => {
    const harness = makeHarness();

    await harness.dispatch('install', {});
    await harness.dispatch('activate', {});

    for (let deploy = 1; deploy <= 6; deploy += 1) {
      await harness.fetchThroughServiceWorker(`https://example.test/api/plugins/hermes-pwa/app/assets/index-deploy${deploy}.js`);
      await harness.fetchThroughServiceWorker(`https://example.test/api/plugins/hermes-pwa/app/assets/index-deploy${deploy}.css`);
      for (let chunk = 0; chunk < 12; chunk += 1) {
        await harness.fetchThroughServiceWorker(`https://example.test/api/plugins/hermes-pwa/app/assets/Chunk${deploy}-${chunk}.js`);
      }
    }

    const shellCache = harness.cacheStores.get('hermes-mobile-v80:shell');
    const runtimeCache = harness.cacheStores.get('hermes-mobile-runtime-assets');
    if (!shellCache || !runtimeCache) throw new Error('missing expected caches');

    const runtimeKeys = (await runtimeCache.keys()).map((request) => request.url);
    const shellKeys = (await shellCache.keys()).map((request) => request.url);

    expect(runtimeKeys.length).toBeLessThanOrEqual(60);
    expect(runtimeKeys.some((url) => /\/assets\/index-deploy\d+\.(?:js|css)$/u.test(url))).toBe(false);
    expect(shellKeys).toContain('https://example.test/api/plugins/hermes-pwa/app/assets/index-deploy6.js');
    expect(shellKeys).toContain('https://example.test/api/plugins/hermes-pwa/app/assets/index-deploy6.css');

    const offlineShell = await harness.navigateOffline();
    await expect(offlineShell.text()).resolves.toBe('cached:./index.html');
  });

  it('refuses to cache an error page or an HTML fallback served for an asset', async () => {
    const harness = makeHarness();
    await harness.dispatch('install', {});
    await harness.dispatch('activate', {});

    harness.fetchMock.mockResolvedValueOnce(new Response('not here', { status: 404 }));
    await harness.fetchThroughServiceWorker('https://example.test/api/plugins/hermes-pwa/app/assets/Missing-1.js');
    harness.fetchMock.mockResolvedValueOnce(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    await harness.fetchThroughServiceWorker('https://example.test/api/plugins/hermes-pwa/app/assets/Fallback-1.js');
    harness.fetchMock.mockResolvedValueOnce(new Response('console.log(1)', { status: 200, headers: { 'content-type': 'application/javascript' } }));
    await harness.fetchThroughServiceWorker('https://example.test/api/plugins/hermes-pwa/app/assets/Good-1.js');

    const runtimeCache = harness.cacheStores.get('hermes-mobile-runtime-assets');
    const keys = runtimeCache ? (await runtimeCache.keys()).map((request) => request.url) : [];
    expect(keys).not.toContain('https://example.test/api/plugins/hermes-pwa/app/assets/Missing-1.js');
    expect(keys).not.toContain('https://example.test/api/plugins/hermes-pwa/app/assets/Fallback-1.js');
    expect(keys).toContain('https://example.test/api/plugins/hermes-pwa/app/assets/Good-1.js');
  });

  it('pre-caches the hashed entry files named by index.html at install', async () => {
    const harness = makeHarness();
    harness.fetchMock.mockImplementationOnce(async () => new Response(
      '<html><head><script type="module" src="./assets/index-abc.js"></script><link rel="stylesheet" href="./assets/index-abc.css"></head></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));
    await harness.dispatch('install', {});
    const shellCache = harness.cacheStores.get('hermes-mobile-v80:shell');
    const keys = shellCache ? (await shellCache.keys()).map((request) => request.url) : [];
    expect(keys).toContain('https://example.test/api/plugins/hermes-pwa/app/assets/index-abc.js');
    expect(keys).toContain('https://example.test/api/plugins/hermes-pwa/app/assets/index-abc.css');
  });

  it('removes legacy entry chunks from the preserved runtime cache on activate', async () => {
    const harness = makeHarness();
    const runtimeCache = harness.cacheStores.get('hermes-mobile-runtime-assets') ?? new FakeCache();
    harness.cacheStores.set('hermes-mobile-runtime-assets', runtimeCache);
    await runtimeCache.put(new Request('https://example.test/api/plugins/hermes-pwa/app/assets/index-old.js'), new Response('old entry'));
    await runtimeCache.put(new Request('https://example.test/api/plugins/hermes-pwa/app/assets/Chat-old.js'), new Response('old chunk'));

    await harness.dispatch('activate', {});

    const runtimeKeys = (await runtimeCache.keys()).map((request) => request.url);
    expect(runtimeKeys).not.toContain('https://example.test/api/plugins/hermes-pwa/app/assets/index-old.js');
    expect(runtimeKeys).toContain('https://example.test/api/plugins/hermes-pwa/app/assets/Chat-old.js');
  });
});
