/* КОМИК: офлайн-кэш + быстрые повторные заходы.
   Стратегия stale-while-revalidate: отдаём страницу из кэша мгновенно,
   а в фоне тихо перекачиваем свежую — она подхватится на следующем заходе.
   Так первый экран открывается сразу, без ожидания сети, и остаётся актуальным. */
const CACHE = 'comik-v58';
// мелкие статические файлы прогреваем сразу при установке
const PRECACHE = ['manifest.webmanifest', 'fonts.css', 'supabase.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// входящий push от сервера → показываем уведомление
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  const title = d.title || 'КОМИК';
  const gid = d.gid || '';
  // ссылка «фоном»: в тексте её нет, но по тапу откроется именно эта игра
  const url = gid ? ('./?g=' + encodeURIComponent(gid)) : './';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || 'Новая игра',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || 'komik-game',
    data: { url, gid }
  }));
});
// тап по уведомлению → открываем меню именно этой игры
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || './';
  const gid = data.gid || '';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { try { c.postMessage({ type: 'komik-open-game', gid }); } catch (_) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // кэшируем только свои GET; облако (Supabase) и внешние запросы — мимо
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        // сеть: обновляет кэш в фоне; при отсутствии связи откатываемся на кэш
        const network = fetch(e.request)
          .then(res => {
            if (res && res.ok) cache.put(e.request, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => cached || (e.request.mode === 'navigation' ? cache.match('/') : undefined));
        // есть в кэше — отдаём мгновенно, сеть догоняет в фоне; иначе ждём сеть
        return cached || network;
      })
    )
  );
});
