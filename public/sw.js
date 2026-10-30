/* Runa Messenger PWA service worker
   Стратегии:
   - навигация: network-first + офлайн-страница;
   - app shell (html/css/js/manifest): network-first с кэшем;
   - картинки/стикеры/вложения: cache-first;
   - API и Socket.IO: только сеть. */
const VERSION = 'runa-v9';
const SHELL_CACHE = `runa-shell-${VERSION}`;
const MEDIA_CACHE = `runa-media-${VERSION}`;
const OFFLINE_URL = '/offline.html';

const SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/style.css',
  '/app.js',
  '/social.js',
  '/nft-phrases.js',
  '/vendor/pako.min.js',
  '/vendor/lottie.min.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

const isMedia = (path) =>
  path.startsWith('/uploads/') ||
  path.startsWith('/stickers/') ||
  path.startsWith('/icons/');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== SHELL_CACHE && key !== MEDIA_CACHE)
        .map((key) => caches.delete(key))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

async function networkFirstNavigation(request) {
  if (self.navigator && self.navigator.onLine === false) {
    return (await caches.match(OFFLINE_URL)) ||
      (await caches.match(request)) ||
      (await caches.match('/index.html')) ||
      Response.error();
  }
  try {
    // no-store: иначе Chrome отдаёт index.html из HTTP-кэша даже без сети,
    // и офлайн-страница никогда не показывается.
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    // Офлайн-страница важнее устаревшего shell: приложение без сети
    // всё равно не сможет авторизоваться, а страница честно объяснит почему.
    return (await caches.match(OFFLINE_URL)) ||
      (await caches.match(request)) ||
      (await caches.match('/index.html')) ||
      (await caches.match('/')) ||
      Response.error();
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.ok && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    const hit = await caches.match(request);
    if (hit) return hit;
    if (request.mode === 'navigate') {
      return (await caches.match('/index.html')) || (await caches.match(OFFLINE_URL)) || Response.error();
    }
    return Response.error();
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response && response.ok && response.status === 200 &&
        !request.headers.has('range') && response.type === 'basic') {
      const cache = await caches.open(MEDIA_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    return hit || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isMedia(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request, SHELL_CACHE));
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CLEAR_MEDIA_CACHE') {
    caches.delete(MEDIA_CACHE).catch(() => {});
  }
});
