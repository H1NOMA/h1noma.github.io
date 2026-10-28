/* Обход всех разделов на телефоне и десктопе: ошибок в консоли нет, разделы рисуются.
   node tests/smoke.js [папка-для-скриншотов] */
const { launch, openPage, login, check, done, PHONE, DESK } = require('./lib');
const SHOTS = process.argv[2] || '';

(async () => {
  const b = await launch();
  for (const [name, vp] of [['phone', PHONE], ['desk', DESK]]) {
    for (const who of ['', 'testplayer', 'hinoma']) {
      console.log(`· ${name} · ${who || 'гость'}`);
      const { ctx, page, errs } = await openPage(b, { viewport: vp });
      if (who) await login(page, who);
      const views = ['news', 'world', 'players', 'combat', 'settings'].concat(who === 'hinoma' ? ['chrono', 'music', 'worlds'] : []);
      for (const proj of ['classic', 'terra', 'legacy']) {
        await page.evaluate(p => setProject(p), proj);
        for (const v of views) {
          if (v === 'chrono' && proj === 'classic') continue;   // в «Классике» хронологии нет (go уводит в архив)
          await page.evaluate(v => go(v), v);
          await page.waitForTimeout(250);
          const ok = await page.evaluate(v => { const el = document.getElementById('view-' + v); return !!(el && el.classList.contains('active') && el.innerHTML.length > 50); }, v);
          if (!ok) check(false, `${proj}/${v} не открылся`);
          if (SHOTS && proj === 'legacy') await page.screenshot({ path: `${SHOTS}/${name}-${who || 'guest'}-${v}.png` });
        }
      }
      // карточка архива и новость открываются
      await page.evaluate(() => { setProject('legacy'); go('world'); });
      await page.waitForTimeout(300);
      const opened = await page.evaluate(() => { const c = (ARCHIVE || []).find(x => x && !x.deleted); if (!c) return 'нет карточек'; openModal(c.id); const rd = document.getElementById('readerBody'); return (document.getElementById('scrim').classList.contains('open') || (rd && rd.innerHTML.length > 50)) ? '' : 'карточка не открылась'; });
      check(!opened, `${name}/${who || 'гость'}: карточка архива открывается ${opened}`);
      await page.evaluate(() => closeModal());
      check(errs.length === 0, `${name}/${who || 'гость'}: ошибок в консоли нет` + (errs.length ? '\n    ' + [...new Set(errs)].slice(0, 8).join('\n    ') : ''));
      await ctx.close();
    }
  }
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
