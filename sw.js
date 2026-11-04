/* Electronics Mentor service worker — network-first with cache fallback.
   Network-first (not cache-first) so a redeployed shell is never stale:
   the cache only ever answers when the network is unreachable. The API is
   never cached. */

const VERSION = 'em-shell-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './public/icon-192.png',
  './public/icon-512.png',
  './vendor/marked.esm.js',
  './vendor/purify.es.mjs',
];

self.addEventListener('install', (event) => {
  // Put entries individually: one 404 must not abort the whole install.
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never intercept cross-origin
  if (url.pathname.startsWith('/api/')) return;      // never cache chat responses

  // Only cache things that make the shell usable offline.
  const cacheable = ['document', 'script', 'style', 'image', 'font', 'manifest'].includes(request.destination);
  if (!cacheable) return;

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());  // refresh cache opportunistically
    return fresh;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    return Response.error();
  }
}
