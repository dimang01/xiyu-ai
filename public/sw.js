/**
 * Xiyu AI Service Worker
 *
 * Strategy:
 *   - HTML / root path: network-first with cache fallback — pages must reflect
 *     the latest deploy; cache only used when offline. Without this, an updated
 *     deploy can be hidden behind a stale HTML in the SW cache forever (the bug
 *     v1.2.10 fixed: memories.html "请先绑定…" toast persisted after hotfix).
 *   - Hashed/asset files (.css/.js/.mjs/.png/.webp/fonts/manifest): cache-first
 *     with network fallback — fast repeat loads, safe because file URL changes
 *     when content changes (or we accept slightly stale icons/CSS until next
 *     SW activation).
 *   - /api/* routes: network-only — never cache API responses or user data.
 *
 * CACHE_NAME carries a version suffix. Bumping it on each release triggers the
 * activate handler to delete all old caches, so users coming from old SW
 * versions get a clean slate on next activation.
 *
 * User data, tokens, prompt-debug output, and memory API responses are NEVER
 * stored in the service worker cache.
 */

const CACHE_NAME = 'xiyu-static-v20-avatar2';

const ASSET_EXTENSIONS = ['.css', '.js', '.mjs', '.png', '.webp', '.jpg', '.jpeg',
  '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.webmanifest'];

function isApiRoute(url) {
  return new URL(url).pathname.startsWith('/api/');
}

function isHtmlNav(request) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/')) return false;
  if (pathname.endsWith('.html') || pathname === '/' || pathname.endsWith('/')) return true;
  // SPA-style navigations without a file extension (e.g. /app/dashboard)
  if (request.mode === 'navigate') return true;
  return false;
}

function isHashedAsset(url) {
  const { pathname } = new URL(url);
  if (pathname.startsWith('/api/')) return false;
  return ASSET_EXTENSIONS.some(ext => pathname.endsWith(ext));
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

  // API routes: always go to network, never cache.
  if (isApiRoute(request.url)) {
    event.respondWith(fetch(request));
    return;
  }

  // HTML / navigations: network-first, fall back to cache only if offline.
  // This ensures a fresh deploy is always picked up on next page load.
  if (isHtmlNav(request)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (_) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw _;
      }
    })());
    return;
  }

  // Hashed assets: cache-first with network fallback.
  if (isHashedAsset(request.url)) {
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

  // Default: network-first, no caching.
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
