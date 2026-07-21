/* КОМИК: офлайн-кэш. Сеть в приоритете (свежая версия сайта), кэш — запасной путь без связи. */
const CACHE = 'comik-v4';
const CORE_FILES = ['./', 'manifest.webmanifest', 'fonts.css', 'supabase.js', 'core-data.json', 'core-bestiary.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE_FILES)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// тяжёлые статические SRD-файлы: отдаём из кэша мгновенно, обновляем в фоне (stale-while-revalidate)
const BIG_STATIC = /\/(core-data|core-bestiary)\.json$/;

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // облако (Supabase) и прочие внешние запросы не кэшируем
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (BIG_STATIC.test(url.pathname)) {
    // из кэша сразу; параллельно тянем свежую версию на будущее
    e.respondWith(
      caches.open(CACHE).then(c =>
        c.match(e.request).then(cached => {
          const net = fetch(e.request)
            .then(res => { if (res && res.ok) c.put(e.request, res.clone()); return res; })
            .catch(() => cached);
          return cached || net;
        })
      )
    );
    return;
  }

  // остальное (в т.ч. index.html) — сеть в приоритете (свежая версия), кэш запасной
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(r => r || caches.match('./'))
      )
  );
});
