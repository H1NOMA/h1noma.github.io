/* Офлайн-старт: второй заход без сети открывает сайт из кэша воркера, архив — из копии на устройстве
   (теперь она помещается: без фото архив ~200 КБ), фото — из IndexedDB.   node tests/offline.js */
const { launch, BASE, PHONE, check, done } = require('./lib');

(async () => {
  const b = await launch();
  const ctx = await b.newContext({ viewport: PHONE, serviceWorkers: 'allow' });
  await ctx.addInitScript(cloud => { try { if (!localStorage.getItem('comik:cloud')) localStorage.setItem('comik:cloud', cloud); } catch (e) {} }, JSON.stringify({ url: BASE, key: 'anon' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof SESSION_READY !== 'undefined' && SESSION_READY === true, null, { timeout: 30000 });
  // сайт регистрирует воркер только на https; стенд — http://127.0.0.1 (для браузера тоже «безопасный»), регистрируем сами
  await page.evaluate(() => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(() => navigator.serviceWorker.ready));
  // онлайн: открыть карточку с фото — картинка ляжет в IndexedDB
  await page.evaluate(() => { setProject('legacy'); go('world'); });
  const id = await page.evaluate(() => { const c = ARCHIVE.find(x => x && x.img && !x.deleted); openModal(c.id); return c.id; });
  await page.waitForFunction(() => { const i = document.querySelector('#modal .dos-img img'); return i && /^data:|^img\//.test(i.getAttribute('src') || ''); }, null, { timeout: 15000 });
  await page.evaluate(() => closeModal());
  const mirror = await page.evaluate(() => (localStorage.getItem('comik:archive:v1') || '').length);
  check(mirror > 1000, `архив облака лёг копией на устройство (${Math.round(mirror / 1024)} КБ)`);
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'load' });   // второй заход — уже под воркером
  await page.waitForFunction(() => SESSION_READY === true, null, { timeout: 30000 });
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'страницей управляет воркер');
  await page.waitForTimeout(3000);   // воркер докладывает статику в кэш
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(() => {});
  await page.waitForFunction(() => typeof SESSION_READY !== 'undefined' && SESSION_READY === true, null, { timeout: 40000 }).catch(() => {});
  const st = await page.evaluate(() => ({ ready: typeof SESSION_READY !== 'undefined' && SESSION_READY, legacy: (ARCHIVE_ALL.legacy || []).length })).catch(e => ({ err: e.message }));
  check(st.ready && st.legacy >= 40, 'без сети сайт открылся, архив LEGACY на месте: ' + JSON.stringify(st));
  await page.evaluate(id => { setProject('legacy'); go('world'); openModal(id); }, id);
  await page.waitForFunction(() => { const i = document.querySelector('#modal .dos-img img'); return i && /^data:|^img\//.test(i.getAttribute('src') || ''); }, null, { timeout: 10000 }).catch(() => {});
  const shown = await page.evaluate(() => { const i = document.querySelector('#modal .dos-img img'); return i ? (i.getAttribute('src') || 'нет src').slice(0, 14) : 'нет img'; });
  check(/^data:image|^img\//.test(shown), 'без сети фото карточки показано: ' + shown);
  check(errs.length === 0, 'ошибок нет' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
