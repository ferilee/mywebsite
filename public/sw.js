const CACHE_NAME = 'ferilee-cache-v1';
const ASSETS = [
  '/',
  '/projects',
  '/blog',
  '/timeline',
  '/contact',
  '/static/ferilee.png',
  '/static/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
