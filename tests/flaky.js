/* Плохая сеть: стенд рвёт каждое ~четвёртое соединение и отвечает с задержкой.
   Данные доезжают, правки не теряются, чужое не затирается.   node tests/flaky.js */
const { launch, openPage, login, mock, rows, check, done, PHONE, DESK } = require('./lib');

(async () => {
  const seed = await mock('/__mock/rows');
  const cloud = Object.fromEntries(seed.map(r => [r.key, r.value]));
  const want = Object.fromEntries(Object.entries(cloud['comik:archive:v1'] || {}).map(([g, l]) => [g, (l || []).length]));
  const b = await launch();
  await mock('/__mock/fail', 'POST', { rate: 0.25, slow: 250 });
  try {
    console.log('· гость на плохой сети: архив и новости доезжают');
    {
      const { ctx, page, errs } = await openPage(b, { viewport: PHONE });
      let got = null;
      for (let i = 0; i < 40; i++) {
        got = await page.evaluate(() => Object.fromEntries(Object.entries(ARCHIVE_ALL).map(([g, l]) => [g, (l || []).length])));
        if (Object.keys(want).every(g => got[g] === want[g])) break;
        await page.waitForTimeout(1000);
      }
      check(Object.keys(want).every(g => got[g] === want[g]), 'архив целиком: ' + JSON.stringify(got));
      const news = await page.evaluate(() => NEWS.filter(n => n && !n.deleted).length);
      check(news === (cloud['comik:news:v1'] || []).filter(n => n && !n.deleted).length, 'новости целиком: ' + news);
      check(errs.filter(e => !/Failed to fetch|ERR_EMPTY_RESPONSE|NetworkError|net::/.test(e)).length === 0, 'ошибок кода в консоли нет' + (errs.length ? '\n    ' + [...new Set(errs)].slice(0, 5).join('\n    ') : ''));
      await ctx.close();
    }
    console.log('· игрок на плохой сети: лист доходит до облака');
    {
      const { ctx, page } = await openPage(b, { viewport: PHONE });
      for (let i = 0; i < 5; i++) { try { await login(page, 'testplayer'); break; } catch (e) { await page.evaluate(() => closeModal()).catch(() => {}); } }
      await page.evaluate(() => { const ch = { id: 'flk' + Date.now().toString(36), owner: currentTag(), name: 'Шаткий', level: '3', updatedAt: Date.now(), createdAt: Date.now() };
        CHARS_ALL[CUR_PROJECT] = (CHARS_ALL[CUR_PROJECT] || []).concat([ch]); bindGameData(); window.__flk = ch.id; persistChars(); });
      const id = await page.evaluate(() => window.__flk);
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) { await page.waitForTimeout(1000); const r = await rows(); ok = JSON.stringify(r['comik:chars:testplayer'] || {}).includes(id); }
      check(ok, 'лист игрока в облаке (досылка после обрывов)');
      await ctx.close();
    }
    console.log('· ГМ на плохой сети: новая карточка доходит, чужие карточки целы');
    {
      const { ctx, page } = await openPage(b, { viewport: DESK });
      for (let i = 0; i < 5; i++) { try { await login(page, 'herr_teo'); break; } catch (e) { await page.evaluate(() => closeModal()).catch(() => {}); } }
      // пока ГМ работает, другой ГМ добавил карточку прямо в облако
      const r0 = await rows();
      const other = { id: 'cother' + Date.now().toString(36), cat: 'world', title: 'Чужая карточка', updatedAt: Date.now(), status: 'official' };
      r0['comik:archive:v1'].terra = (r0['comik:archive:v1'].terra || []).concat([other]);
      await mock('/__mock/fail', 'POST', { rate: 0 });
      await mock('/__mock/rows', 'POST', Object.entries(r0).map(([key, value]) => ({ key, value })));
      await mock('/__mock/fail', 'POST', { rate: 0.25, slow: 250 });
      await page.evaluate(() => { const c = { id: 'cmine' + Date.now().toString(36), cat: 'world', title: 'Моя карточка', updatedAt: Date.now(), status: 'official' };
        ARCHIVE_ALL.terra = (ARCHIVE_ALL.terra || []).concat([c]); window.__mine = c.id; persistArchive(); });
      const mine = await page.evaluate(() => window.__mine);
      let r = null, ok = false;
      for (let i = 0; i < 90 && !ok; i++) { await page.waitForTimeout(1000); r = await rows(); const t = JSON.stringify(r['comik:archive:v1'].terra || []); ok = t.includes(mine) && t.includes(other.id); }
      check(ok, 'в облаке и своя новая карточка, и чужая');
      const live = o => Object.values(o).flat().filter(c => c && !(c.deleted && Date.now() - (c.updatedAt || 0) > 90 * 864e5)).length;   // старые надгробия чистит любая запись
      const cnt = live(r['comik:archive:v1']), cnt0 = live(r0['comik:archive:v1']);
      check(cnt >= cnt0, `карточек не стало меньше: ${cnt0} → ${cnt}`);
      await ctx.close();
    }
    console.log('· ГМ закрыл вкладку посреди сохранения (облако тормозит): правка не теряется');
    {
      await mock('/__mock/fail', 'POST', { rate: 0, slow: 0 });
      const b2ctx = await b.newContext({ viewport: DESK, serviceWorkers: 'block' });
      await b2ctx.addInitScript(cloud => { try { if (!localStorage.getItem('comik:cloud')) localStorage.setItem('comik:cloud', cloud); } catch (e) {} }, JSON.stringify({ url: require('./lib').BASE, key: 'anon' }));
      let page = await b2ctx.newPage();
      await page.goto(require('./lib').BASE + '/'); await page.waitForFunction(() => typeof SESSION_READY !== 'undefined' && SESSION_READY === true, null, { timeout: 30000 });
      await login(page, 'arlissss');
      await mock('/__mock/fail', 'POST', { rate: 0, slow: 6000 });
      const id = await page.evaluate(() => { const c = { id: 'cclose' + Date.now().toString(36), cat: 'world', title: 'Закрыл вкладку', updatedAt: Date.now(), status: 'official' };
        ARCHIVE_ALL.legacy = (ARCHIVE_ALL.legacy || []).concat([c]); persistArchive(); return c.id; });
      await page.waitForTimeout(800);
      await page.close();                                   // вкладку закрыли, пока облако читалось
      await mock('/__mock/fail', 'POST', { rate: 0, slow: 0 });
      page = await b2ctx.newPage();
      await page.goto(require('./lib').BASE + '/'); await page.waitForFunction(() => typeof SESSION_READY !== 'undefined' && SESSION_READY === true, null, { timeout: 30000 });
      check(await page.evaluate(id => (ARCHIVE_ALL.legacy || []).some(c => c.id === id), id), 'после повторного открытия карточка на месте');
      let ok = false;
      for (let i = 0; i < 90 && !ok; i++) { await page.waitForTimeout(1000); ok = JSON.stringify((await rows())['comik:archive:v1'].legacy || []).includes(id); }
      check(ok, 'и сама дошла до облака');
      await b2ctx.close();
    }
  } finally {
    await mock('/__mock/fail', 'POST', { rate: 0 });
    await mock('/__mock/rows', 'POST', seed);
  }
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
