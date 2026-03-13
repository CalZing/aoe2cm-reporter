// Service Worker – basic caching for PWA installability
const CACHE_NAME = 'aoe2cm-reporter-v2';
const SHELL_FILES = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL_FILES)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Network first; Socket.IO and API calls must never be cached
    if (event.request.url.includes('/socket.io/') || event.request.method !== 'GET') return;
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
