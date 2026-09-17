/* КОМИК: офлайн-кэш + быстрые повторные заходы.
   Стратегия stale-while-revalidate: отдаём страницу из кэша мгновенно,
   а в фоне тихо перекачиваем свежую — она подхватится на следующем заходе.
   Так первый экран открывается сразу, без ожидания сети, и остаётся актуальным. */
const CACHE = 'comik-v256';
// мелкие статические файлы прогреваем сразу при установке
// core-bestiary.json вынесен из index.html (это была почти половина его веса)
// и обязан лежать в кэше: без него архив останется без монстров в офлайне.
// манифесты на каждую иконку приложения — чтобы установка PWA работала и из офлайн-кэша
// данные сайта (data/*.json) и фоны приветствий (img/hero-*.jpg) вынесены из index.html:
// мелкие прогреваем сразу, справочник data/core.json (8 МБ) ляжет в кэш при первом запросе страницы
const PRECACHE = ['manifest.webmanifest', 'fonts.css', 'supabase.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'core-bestiary.json',
  'data/archive.json', 'data/news.json', 'data/hero.json', 'data/chrono.json',
  ...['legacy','neverland','assimilation','terra','classic','skazki'].map(k => 'img/hero-' + k + '.jpg'),
  ...['classic','terra','legacy','neverland','assimilation','komik','komikw','komikn'].map(k => 'manifest-' + k + '.webmanifest')];
// сколько ждём сеть для самой страницы, прежде чем отдать копию из кэша.
// В регионах, где канал до хостинга душат, ожидание сети — это и есть «сайт не открывается»:
// повторный заход обязан открыться мгновенно из кэша, а свежая версия догрузится фоном.
const NAV_TIMEOUT = 3500;

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
  const isNav = e.request.mode === 'navigation';
  e.respondWith(
    caches.open(CACHE).then(cache => {
      // Навигация (сама страница index.html) — NETWORK-FIRST: онлайн всегда отдаём свежий код,
      // кэш служит лишь офлайн-фолбэком. Иначе SW отдавал старый index.html из кэша и правки
      // «не доезжали» до пользователя до второй перезагрузки — казалось, что ничего не изменилось.
      if (isNav) {
        const fromCache = () => cache.match(e.request).then(c => c || cache.match('/') || cache.match('index.html'));
        // что отдали странице: 'net' — свежую с сети, 'cache' — копию по таймауту
        let served = null;
        const network = fetch(e.request).then(async res => {
          if (res && res.ok) {
            const prev = await cache.match(e.request).catch(() => null);
            const changed = !!prev && (prev.headers.get('etag') || prev.headers.get('content-length') || '') !==
                                       (res.headers.get('etag') || res.headers.get('content-length') || '');
            await cache.put(e.request, res.clone()).catch(() => {});
            // Страница уже открыта из старого кэша, а с сети пришла новая версия: раньше она
            // ждала следующего запуска (на телефоне — второго-третьего), теперь страница
            // узнаёт об этом сразу и перезапускается сама, как только это безопасно.
            if (changed && served === 'cache') {
              self.clients.matchAll({ type: 'window' }).then(list => list.forEach(c => c.postMessage({ type: 'komik-updated' })));
            }
          }
          return res;
        });
        // Гонка: кто быстрее — сеть или таймаут. По таймауту отдаём кэш, а закачка продолжается
        // в фоне и обновит кэш к следующему заходу. Если кэша ещё нет — честно ждём сеть.
        return Promise.race([
          network.then(r => { if (!served) served = 'net'; return r; })
                 .catch(() => fromCache().then(c => c || Promise.reject(new Error('offline')))),
          new Promise(res => setTimeout(() => res(fromCache().then(c => { if (c) { if (!served) served = 'cache'; return c; } return network; })), NAV_TIMEOUT)),
        ]).catch(() => fromCache());
      }
      // Прочие статические ресурсы — stale-while-revalidate: мгновенно из кэша, свежее в фоне.
      return cache.match(e.request).then(cached => {
        const network = fetch(e.request)
          .then(res => { if (res && res.ok) cache.put(e.request, res.clone()).catch(() => {}); return res; })
          .catch(() => cached);
        return cached || network;
      });
    })
  );
});
