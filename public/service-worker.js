const CACHE_NAME = 'taskflow-shell-v12';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/taskflow.svg',
  '/icons/taskflow-maskable.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const isAppShell = url.pathname === '/'
    || ['/index.html', '/manifest.webmanifest'].includes(url.pathname)
    || url.pathname.startsWith('/css/')
    || url.pathname.startsWith('/js/')
    || url.pathname.startsWith('/icons/');
  if (request.method !== 'GET' || url.origin !== self.location.origin || !isAppShell) return;

  const refresh = fetch(request).then(async response => {
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  });
  event.waitUntil(refresh.then(() => undefined).catch(() => undefined));
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(cached => cached || refresh.catch(() => {
      if (request.mode === 'navigate') return caches.match('/index.html');
      throw new Error('App shell asset is unavailable offline.');
    }))
  );
});
