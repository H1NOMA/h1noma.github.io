/* Доска ходов, расписание ГМа и поиск по архиву.
   Доска: верхняя панель ГМа ничего не перекрывает на 375–1920 (длинное имя, эфир выключен и включён), до 1000 px
   инструменты — вторым этажом; подсказка пустой доски на телефоне помещается в ленту.
   Расписание ГМа — с датой и по дате. Поиск не различает «е» и «ё»: общий, в разделе, мини-архив, подсказки доски.
   node tests/site.js [папка-для-скриншотов] */
const { launch, openPage, login, check, done, PHONE } = require('./lib');
const SHOTS = process.argv[2] || '';
const LONG = 'Арагорн сын Араторна из рода Исилдура', MID = 'Взрослый зелёный дракон';

(async () => {
  const b = await launch();

  // ── поиск — гостем ──
  {
    console.log('· поиск: гость');
    const { page, ctx, errs } = await openPage(b, { viewport: PHONE, storage: { 'comik:cookies:ok': '1' } });
    await page.evaluate(() => setProject('legacy'));
    await page.evaluate(() => parseBestiary());   // бестиарий разбирается после заставки — здесь сразу
    const sf = q => page.evaluate(q => { runSearch(q); return SF_RES.filter(r => !r.ch).map(r => r.t).join('|'); }, q);
    const e = await sf('зеленый дракон'), yo = await sf('зелёный дракон');
    check(e && e === yo, `общий поиск: «зеленый дракон» = «зелёный дракон» (${e.split('|').length})`);
    const m = await sf('мертвых');
    check(m && m === await sf('мёртвых'), `общий поиск: «мертвых» = «мёртвых» (${m.split('|').length})`);

    await page.evaluate(() => go('world')); await page.waitForTimeout(300);
    const sec = async q => { await page.fill('#secQ', q); await page.waitForTimeout(200); return page.evaluate(() => [...document.querySelectorAll('#cards article.card h3')].map(h => h.textContent).join('|')); };
    const se = await sec('зеленый дракон'), syo = await sec('зелёный дракон');
    check(se && se === syo, `поиск в архиве: «зеленый дракон» = «зелёный дракон» (${se.split('|').length})`);
    // поле перерисовывается со значением запроса — «ё» в нём остаётся как набрали
    await page.evaluate(() => renderCards()); await page.waitForTimeout(100);
    check(await page.inputValue('#secQ') === 'зелёный дракон', 'после перерисовки в поле так и стоит «зелёный дракон»');

    const ma = q => page.evaluate(q => { openMiniArch(); maQInput(q); return [...document.querySelectorAll('#maCards .ma-card h4')].map(h => h.textContent).join('|'); }, q);
    const me = await ma('зеленый дракон'), myo = await ma('зелёный дракон');
    check(me && me === myo, `мини-архив: «зеленый дракон» = «зелёный дракон» (${me.split('|').length})`);
    await page.evaluate(() => { maQInput(''); closeMiniArch(); });
    check(errs.length === 0, 'поиск: ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  // ── ГМ: расписание, подсказки доски, верхняя панель, пустая доска ──
  const { page, ctx, errs } = await openPage(b, { viewport: { width: 1000, height: 860 }, storage: { 'comik:cookies:ok': '1' } });
  await login(page, 'hinoma');
  await page.evaluate(() => { setProject('legacy'); return parseBestiary(); });

  console.log('· расписание ГМа');
  {
    // две игры в одно время и в одном месте; поздняя создана раньше — раньше она и стояла первой
    const sched = await page.evaluate(() => {
      const day = n => { const d = new Date(Date.now() + n * 864e5); return d.getFullYear() + '-' + calPad(d.getMonth() + 1) + '-' + calPad(d.getDate()); };
      const mk = (id, title, n, at) => ({ id, game: 'legacy', title, date: day(n), time: '19:00', loc: 'Клуб', seats: 4, players: [], owner: currentTag(), createdAt: at });
      const keep = GAMES;
      GAMES = keep.filter(s => s && s.game !== 'legacy').concat([mk('t-late', 'Поздняя', 14, 1), mk('t-soon', 'Ранняя', 7, 2)]);
      try { openSchedule('legacy'); } finally { GAMES = keep; }
      return { titles: [...document.querySelectorAll('#modal .gs-card .gs-title')].map(x => x.textContent),
               dates: [...document.querySelectorAll('#modal .gs-card .gs-meta')].map(x => (x.textContent.match(/📅\s*([^\n]+)/) || [])[1] || '').map(s => s.trim()),
               want: [fmtGameDate(day(7)), fmtGameDate(day(14))] };
    });
    check(sched.titles.join('|') === 'Ранняя|Поздняя', `сначала ближайшая (${sched.titles.join(', ')})`);
    check(sched.dates.join('|') === sched.want.join('|'), `у каждой игры дата (${sched.dates.join(', ')})`);
    await page.evaluate(() => closeModal());
  }

  console.log('· доска ходов: ГМ');
  await page.evaluate(() => go('combat'));
  await page.waitForFunction(() => !!document.querySelector('.bv2-hud'), null, { timeout: 15000 });
  // эфир выключаем: выключение и очищает доску
  const live = on => page.evaluate(on => { if (!!(TRK_SHARED[gmBoardKey()] && TRK_SHARED[gmBoardKey()].active) !== on) trkToggleActive(); }, on);
  await live(false); await page.waitForTimeout(500);
  await page.evaluate(() => trkClear());

  await page.fill('#trk-add', 'зеленый дра'); await page.waitForTimeout(150);
  const sugE = await page.evaluate(() => [...document.querySelectorAll('#trk-sug button')].map(x => x.textContent).join('|'));
  await page.fill('#trk-add', 'зелёный дра'); await page.waitForTimeout(150);
  const sugYo = await page.evaluate(() => [...document.querySelectorAll('#trk-sug button')].map(x => x.textContent).join('|'));
  check(sugE && sugE === sugYo, `подсказки «Найти существо»: «зеленый» = «зелёный» (${sugE})`);
  await page.fill('#trk-add', '');

  // пустая доска на телефоне: подсказка в ленте целиком, не под маской краёв
  for (const w of [360, 375, 430]) {
    await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(250);
    const r = await page.evaluate(() => { const e = document.querySelector('.bv2-empty'), s = document.getElementById('bv2Strip');
      if (!e || !s) return null; const a = e.getBoundingClientRect(), q = s.getBoundingClientRect();
      return { l: Math.round(a.left - q.left), r: Math.round(q.right - a.right) }; });
    check(r && r.l >= 34 && r.r >= 34, `пустая доска ${w}: подсказка от краёв ленты ${r && r.l} и ${r && r.r} px (маска — 34)`);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/board-empty-430.png`, clip: { x: 0, y: 0, width: 430, height: 800 } });

  for (const n of ['Огр', MID, LONG]) { await page.fill('#trk-add', n); await page.evaluate(() => trkAddManual()); await page.waitForTimeout(150); }
  const pick = name => page.evaluate(n => { const x = TRK.list.find(y => y.name === n); TRK.activeKey = trkCardKey(x); renderTracker(); }, name);
  const probe = () => page.evaluate(() => {
    const R = el => el.getBoundingClientRect();
    const hit = el => { const q = R(el); const t = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return el.contains(t); };
    const hud = document.querySelector('.bv2-hud'), hl = hud.querySelector('.bv2-hl'), hc = hud.querySelector('.bv2-hc'), hr = hud.querySelector('.bv2-hr');
    const btns = [...hc.querySelectorAll('button')], hod = btns[btns.length - 1], who = hc.querySelector('.who');
    const over = (a, b) => { const p = R(a), q = R(b); return Math.max(0, Math.min(p.right, q.right) - Math.max(p.left, q.left)) > 1 && Math.max(0, Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top)) > 1; };
    return { click: [hud.querySelector('.tb-round'), ...btns, ...hr.querySelectorAll('button')].every(hit),
             overlap: over(hl, hc) || over(hc, hr) || over(hl, hr),
             whoIn: R(who).right <= R(hod).left + 1 && R(who).right <= R(hc).right,
             cut: who.scrollWidth > who.clientWidth + 1, hcW: Math.round(R(hc).width),
             two: R(hr).top >= R(hc).bottom - 1 };
  });
  for (const on of [false, true]) {
    if (on) { await live(true); await page.waitForTimeout(800); }
    for (const w of [375, 760, 880, 999, 1000, 1100, 1180, 1280, 1440, 1920]) {
      await page.setViewportSize({ width: w, height: 860 }); await page.evaluate(() => scrollTo(0, 0));
      for (const n of [MID, LONG]) {
        await pick(n); await page.waitForTimeout(120);
        const p = await probe();
        check(p.click && !p.overlap && p.whoIn, `${on ? 'эфир' : 'без эфира'} ${w} «${n.slice(0, 12)}…»: кнопки нажимаются, плашки не наезжают, имя не под «Ход ▸»`
          + (p.click && !p.overlap && p.whoIn ? '' : ' ' + JSON.stringify(p)));
        if (w >= 760 && w < 1000) check(p.two, `${on ? 'эфир' : 'без эфира'} ${w}: инструменты ГМа — вторым этажом`);
        if (w >= 760 && w < 1000 && n === MID) check(!p.cut, `${on ? 'эфир' : 'без эфира'} ${w}: «${n}» целиком`);
        if (SHOTS && n === LONG && [880, 1000, 1180].includes(w)) await page.screenshot({ path: `${SHOTS}/hud-${on ? 'live' : 'off'}-${w}.png`, clip: { x: 0, y: 0, width: w, height: 220 } });
      }
    }
  }
  // широкий экран: плашка по содержимому, как и была, — не растянута между краями
  await page.setViewportSize({ width: 1440, height: 860 }); await pick('Огр'); await page.waitForTimeout(150);
  const wide = await probe();
  check(!wide.two && wide.hcW < 300, `1440 «Огр»: одна строка, средняя плашка по содержимому (${wide.hcW} px)`);

  await live(false); await page.waitForTimeout(300);   // эфир гасим — выключение заодно очищает доску
  check(errs.length === 0, 'ГМ: ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
  await ctx.close();
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
