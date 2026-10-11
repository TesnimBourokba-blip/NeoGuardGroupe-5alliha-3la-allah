/**
 * NeoGuard — service worker, cache local uniquement.
 * ---------------------------------------------------------------------------
 * Compatibilité à connaître (sans promesse excessive) :
 * - Un site web ne peut pas forcer un son fort quand le téléphone est verrouillé.
 *   Pour une alerte fiable en production, prévoir une application native
 *   Android/iOS ou du Web Push avec priorité haute.
 * - Sur iOS, les notifications web exigent que le site soit ajouté à l'écran
 *   d'accueil (iOS/iPadOS 16.4 ou ultérieur, selon le navigateur).
 * - La vibration n'est pas disponible dans iOS Safari.
 * - Le son fort de l'overlay exige que l'app soit ouverte et le son déverrouillé
 *   par un geste utilisateur via #btn-enable-audio.
 *
 * Aucun Push serveur n'est utilisé ici : les notifications sont locales et
 * déclenchées par la page via postMessage. Pour ajouter Web Push ultérieurement,
 * ajouter un serveur HTTPS qui conserve les abonnements et envoie des messages
 * chiffrés avec des clés VAPID, puis gérer l'événement `push` dans ce worker.
 */

const CACHE_NAME = 'neoguard-v3';
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './main.js',
  './state.js',
  './sensors.js',
  './ai.js',
  './alerts.js',
  './charts.js',
  './ui.js',
  './demo.js',
  './db.js',
  './assets/icons/logo-neoguard.svg',
  './assets/icons/logo-icon-192.png',
  './assets/icons/logo-neoguard-512.png',
];

const OPTIONAL_ASSETS = new Set(['./ui.js']);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // On ajoute chaque ressource séparément : l'échec d'un PNG généré plus tard
    // ne doit pas empêcher la PWA de s'installer hors ligne.
    for (const path of PRECACHE_URLS) {
      try {
        const response = await fetch(new URL(path, self.registration.scope), { cache: 'reload' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await cache.put(new URL(path, self.registration.scope), response);
      } catch (error) {
        if (!OPTIONAL_ASSETS.has(path)) {
          console.warn(`[NeoGuard/sw] Ressource non précachée : ${path}`, error);
        }
      }
    }
    // Pas de skipWaiting automatique : la page peut demander l'activation
    // contrôlée en postant { type: 'SKIP_WAITING' } au worker en attente.
  })());
});

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (message.type === 'notify') {
    event.waitUntil((async () => {
      const level = ['normal', 'vigilance', 'pathologie-legere', 'urgence'].includes(message.level)
        ? message.level
        : 'vigilance';
      const title = typeof message.title === 'string' && message.title.trim()
        ? message.title.trim()
        : 'NeoGuard';
      const body = typeof message.body === 'string' ? message.body : '';
      try {
        await self.registration.showNotification(title, {
          body,
          tag: `neoguard-${level}`,
          renotify: level === 'urgence',
          requireInteraction: level === 'urgence',
          silent: level !== 'urgence',
          data: { url: new URL('./index.html', self.registration.scope).href, level },
        });
      } catch (error) {
        console.error('[NeoGuard/sw] Affichage de notification impossible :', error);
      }
    })());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('neoguard-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok && (request.destination === 'style' || request.destination === 'script' || request.destination === 'image' || request.destination === 'manifest' || request.mode === 'navigate')) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const shell = await cache.match(new URL('./index.html', self.registration.scope));
        if (shell) return shell;
      }
      return new Response('Ressource indisponible hors ligne.', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || new URL('./index.html', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client && new URL(client.url).href !== target) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
