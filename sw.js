/* КОМИК: офлайн-кэш + быстрые повторные заходы.
   Сама страница — network-first: онлайн всегда свежий код, по таймауту (NAV_TIMEOUT) или без сети —
   копия из версионного кэша, прогретая при установке. Статика (шрифты, библиотека облака, данные,
   картинки) — stale-while-revalidate: мгновенно из кэша, а в фоне тихо перекачиваем свежую. */
const CACHE = 'comik-v287';
// Статика (шрифты, иконки, данные, фоны) живёт в ОТДЕЛЬНОМ кэше, который не сбрасывается при смене
// версии: раньше каждое обновление кода стирало и шрифты с картинками, и на телефоне первый запуск
// новой версии шёл без них, пока всё не перекачается заново. Обновляются они сами (stale-while-revalidate).
const STATIC = 'comik-static-v1';
// мелкие статические файлы прогреваем сразу при установке (~1,3 МБ вместо прежних 4 МБ)
// манифесты на каждую иконку приложения — чтобы установка PWA работала и из офлайн-кэша
// Тяжёлое в прогрев НЕ входит: страница сама запрашивает это по ходу дела, и оно ложится в этот же
// кэш при первом запросе через воркер (ветка stale-while-revalidate ниже): справочники data/core.json
// (8 МБ) и core-bestiary.json (11 МБ), архив и новости (data/archive.json, data/news.json),
// фотографии карточек архива и новостей img/content/*.jpg (они вынесены из этих JSON в файлы и
// грузятся лениво, когда карточка попала на экран), фоны приветствий img/hero-*.jpg (1 МБ на семь
// тем — пользователю нужен один). Раньше всё это
// качалось при установке воркера и на первом заходе отбирало канал у самой страницы.
// Шрифты — только файлы, которые страница реально запрашивает (проверено по сетевым запросам во всех
// темах и разделах): подмножества latin и cyrillic; latin-ext/cyrillic-ext, Chakra Petch 500 и
// Rajdhani 600 не грузятся вовсе. Без них офлайн-старт открывался системным шрифтом.
const PRECACHE = ['manifest.webmanifest', 'fonts.css', 'supabase.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'img/logo-komik.png', 'img/badge-96.png', 'img/chrono-gw.jpg', 'img/team-1.jpg', 'img/team-2.jpg', 'img/team-3.jpg', 'img/team-4.jpg', 'img/team-5.jpg',
  'data/hero.json', 'data/chrono.json',
  ...['classic','terra','legacy','neverland','assimilation','komik','komikw','komikn'].map(k => 'manifest-' + k + '.webmanifest'),
  ...['cinzel-decorative-700','cinzel-decorative-900','rajdhani-500','uncial-antiqua-400'].map(k => 'fonts/' + k + '-normal-latin.woff2'),
  // Exo 2 (заголовки) и Roboto Mono (подписи) — с кириллицей, как и Inter
  ...['inter-400','inter-500','inter-600','ruslan-display-400','exo-2-400','exo-2-500','exo-2-600','exo-2-700','roboto-mono-400','roboto-mono-500']
      .flatMap(k => ['cyrillic','latin'].map(s => 'fonts/' + k + '-normal-' + s + '.woff2'))];
// сколько ждём сеть для самой страницы, прежде чем отдать копию из кэша.
// В регионах, где канал до хостинга душат, ожидание сети — это и есть «сайт не открывается»:
// повторный заход обязан открыться мгновенно из кэша, а свежая версия догрузится фоном.
const NAV_TIMEOUT = 2500;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(Promise.all([
    // Статика — по одному файлу и только недостающие: addAll работает «всё или ничего», и один пропавший
    // файл (или обрыв на нём) раньше оставлял кэш пустым целиком; а то, что уже лежит в STATIC,
    // при смене версии перекачивать незачем — оно обновляется само при первом запросе.
    caches.open(STATIC).then(c => Promise.allSettled(PRECACHE.map(u => c.match(u).then(hit => hit || c.add(u))))).catch(() => {}),
    // Сама страница — в ВЕРСИОННЫЙ кэш уже при установке. Первый заход воркер не перехватывает
    // (он ещё не управляет страницей), и без этого офлайн-копия index.html появлялась лишь после
    // второго онлайн-захода — офлайн работал с третьего. Запрос условный (no-cache): если HTML
    // не менялся с момента загрузки страницы, придёт 304 и копия возьмётся из HTTP-кэша браузера
    // без повторной закачки 1,2 МБ; если сайт обновился — в кэш ляжет свежая версия.
    // Ошибку прогрева страницы НЕ глотаем: иначе установка «удавалась» без копии страницы, activate
    // стирал прежний кэш вместе с единственной офлайн-копией, и без сети приложение не открывалось.
    // Упавшая установка оставляет старый воркер с его кэшем, а браузер повторит обновление позже.
    caches.open(CACHE).then(c => c.add(new Request('./', { cache: 'no-cache' }))),
  ]));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== STATIC).map(k => caches.delete(k))))
      // прежний воркер складывал копии самой страницы в STATIC (см. isNav ниже) — по 1,2 МБ на каждый
      // вариант адреса; теперь страница живёт в версионном кэше, а эти копии только занимают место
      .then(() => caches.open(STATIC).then(st => st.keys().then(ks => {
        const root = new URL('./', self.location.href).pathname;
        return Promise.all(ks.filter(r => [root, root + 'index.html'].includes(new URL(r.url).pathname)).map(r => st.delete(r)));
      })).catch(() => {}))
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
    // значок строки состояния Android строится только по альфа-каналу: icon-192.png без прозрачности
    // давал сплошной белый квадрат, здесь — белый к20 на прозрачном фоне
    badge: 'img/badge-96.png',
    // у каждой игры свой tag: с общим «komik-game» новый анонс молча подменял в шторке
    // прежний — без звука и вибрации. renotify — повторный анонс той же игры тоже звенит
    tag: gid ? ('komik-game-' + gid) : (d.tag || 'komik-game'),
    renotify: true,
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
  // 'navigate' — именно так браузер помечает запрос самой страницы. Раньше здесь стояло 'navigation':
  // такого значения у Request.mode нет, ветка ниже не срабатывала никогда, и страница шла по ветке
  // статики (мгновенно из кэша, свежая — к следующему заходу); офлайн-старт при этом падал, если
  // копии страницы не оказалось в STATIC.
  const isNav = e.request.mode === 'navigate';
  e.respondWith(
    caches.open(CACHE).then(cache => {
      // Навигация (сама страница index.html) — NETWORK-FIRST: онлайн всегда отдаём свежий код,
      // кэш служит лишь офлайн-фолбэком. Иначе SW отдавал старый index.html из кэша и правки
      // «не доезжали» до пользователя до второй перезагрузки — казалось, что ничего не изменилось.
      if (isNav) {
        // Сама страница живёт в кэше под одним ключом './' — тем же, что при установке (относительно воркера,
        // а не корня домена). Раньше заход по ссылке из уведомления (?g=…) клал под свой адрес ещё одну
        // копию на 1,5 МБ на каждую игру, а сравнение «пришла новая сборка» для него не срабатывало
        const root = new URL('./', self.location.href);
        const key = (url.pathname === root.pathname || url.pathname === root.pathname + 'index.html') ? root.href : e.request;
        const fromCache = () => cache.match(key).then(c => c || cache.match(root.href)).then(c => c || cache.match('index.html'));
        // что отдали странице: 'net' — свежую с сети, 'cache' — копию по таймауту
        let served = null;
        // страницу спрашиваем у сервера С ПРОВЕРКОЙ: без no-cache запрос уходил в HTTP-кэш
        // браузера (GitHub Pages отдаёт index.html с max-age), и «обновить» первые минуты
        // возвращало ту же сборку. Условный запрос с ETag стоит один заголовок, а не мегабайт.
        const network = fetch(new Request(e.request.url, {cache:'no-cache', credentials:'same-origin', mode:'same-origin'})).then(async res => {
          if (res && res.ok) {
            const prev = await cache.match(key).catch(() => null);
            const changed = !!prev && (prev.headers.get('etag') || prev.headers.get('content-length') || '') !==
                                       (res.headers.get('etag') || res.headers.get('content-length') || '');
            await cache.put(key, res.clone()).catch(() => {});
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
      // Фоновая проверка — условная: с ETag/Last-Modified кэшированной копии. Если файл на
      // сервере не менялся, приходит 304 без тела — раньше каждый заход перекачивал в фоне
      // справочник и бестиарий целиком (~3,5 МБ сжатых), теперь только заголовки.
      return caches.open(STATIC).then(st => st.match(e.request).then(cached => {
        let req = e.request;
        if (cached) {
          const h = new Headers(e.request.headers);
          const et = cached.headers.get('etag'), lm = cached.headers.get('last-modified');
          if (et) h.set('If-None-Match', et);
          if (lm) h.set('If-Modified-Since', lm);
          if (et || lm) req = new Request(e.request, { headers: h });
        }
        const network = fetch(req)
          .then(res => {
            if (res && res.status === 304) return cached;   // не менялся — копия в кэше актуальна
            if (res && res.ok) st.put(e.request, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }));
    })
  );
});
