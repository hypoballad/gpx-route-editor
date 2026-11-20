const scope = new URL(self.registration.scope);
const cachePrefix = `gpx-editor:${scope.href}:`;
const cacheName = cachePrefix + version;
const appEntry = new URL('index.html', scope).href;
const urls = new Map(assets.map(({ path, integrity }) => [new URL(path, scope).href, integrity]));

async function scopeCaches() {
  return (await caches.keys()).filter((name) => name.startsWith(cachePrefix) && name !== cacheName);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      await cache.addAll([...urls].map(([url, integrity]) => new Request(url, { cache: 'reload', integrity })));
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Keep recent assets available to tabs that still have an older editor open.
    const previous = await scopeCaches();
    await Promise.all(previous.slice(0, -2).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});

async function cachedAsset(url, request, allowOlder) {
  const cache = await caches.open(cacheName);
  const current = await cache.match(url);
  if (current) return current;
  if (allowOlder) {
    for (const name of (await scopeCaches()).reverse()) {
      const previous = await (await caches.open(name)).match(url);
      if (previous) return previous;
    }
  }
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(appEntry).pathname)) {
    event.respondWith(cachedAsset(appEntry, request, false));
    return;
  }
  const path = url.pathname.slice(scope.pathname.length);
  const versioned = path.startsWith('assets/') || /^graph\/(?:manifest-[a-f0-9]{16}\.json|network-[a-f0-9]{16}\.bin\.gz)$/.test(path);
  if (urls.has(url.href) || versioned) event.respondWith(cachedAsset(url.href, request, versioned));
});
