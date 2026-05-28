/**
 * Xiyu AI Service Worker
 *
 * Strategy:
 *   - Static assets (HTML, JS, CSS, images, fonts, manifest): cache-first with network fallback.
 *   - /api/* routes: network-only — never cache API responses or user data.
 *   - Everything else: network-first.
 *
 * User data, tokens, prompt-debug output, and memory API responses
 * are NEVER stored in the service worker cache.
 */

const CACHE_NAME = 'xiyu-static-v1';

const STATIC_EXTENSIONS = ['.html', '.css', '.js', '.mjs', '.png', '.webp', '.jpg', '.jpeg',
  '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.webmanifest'];

function isStaticAsset(url) {
  const { pathname } = new URL(url);
  // Never cache API routes
  if (pathname.startsWith('/api/')) return false;
  return STATIC_EXTENSIONS.some(ext => pathname.endsWith(ext)) || pathname === '/';
}

function isApiRoute(url) {
  return new URL(url).pathname.startsWith('/api/');
}

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // API routes: always go to network, never cache
  if (isApiRoute(request.url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (isStaticAsset(request.url)) {
    // Cache-first for static assets
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Default: network-first, no caching
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
