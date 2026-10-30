/* Мобильные новости: приветствие при прокрутке уходит в пилюлю сеттинга, «Ближайшая игра» становится
   плавающей пилюлей и возвращается в карточку. Телефон 390 (и 360/430), без анимаций, десктоп 1440 — без изменений.
   node tests/newsfx.js [папка-для-кадров]   (стенд: строки kv подменяются — нужна ближайшая игра) */
const { launch, openPage, mock, check, done } = require('./lib');
const SHOTS = process.argv[2] || '';

const pad = n => String(n).padStart(2, '0');
const day = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const GAME = {
  id: 'g_newsfx', game: 'classic', title: 'Гробница Короля-Лича', date: day(new Date(Date.now() + 6 * 864e5)),
  time: '19:00', loc: 'Клуб', seats: 5, players: [{ tag: 'player_two', name: 'Два', at: Date.now() - 1000 }],
  createdAt: Date.now() - 5000, updatedAt: Date.now() - 5000,
};
// без подсказки новичку, плашки cookie и карточки «С чего начать» — они перекрывают то, что проверяем
const QUIET = { 'comik:hint:setting': '1', 'comik:cookies:ok': '1', 'comik:onboard:done': '1' };

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
async function scrollTo(page, y) { await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), y); await frames(page); }
const state = page => page.evaluate(() => {
  const mh = document.querySelector('#view-news .masthead'), f = document.getElementById('ngFloat'), ng = document.getElementById('nextGame');
  const cs = getComputedStyle(mh);
  return {
    y: scrollY, tf: mh.style.transform, op: mh.style.opacity, vis: mh.style.visibility, cop: +cs.opacity, cvis: cs.visibility,
    suck: document.getElementById('projSwipe').style.getPropertyValue('--suck'),
    fl: !!f, on: !!(f && f.classList.contains('on')), away: ng.classList.contains('ngf-away'), ftf: f ? f.style.transform + f.style.opacity : '',
    anims: document.getAnimations().filter(a => a.effect && a.effect.target && (a.effect.target === mh || a.effect.target === f || (f && f.contains(a.effect.target)))).length,
    mhR: (r => [r.left, r.top, r.width, r.height])(mh.getBoundingClientRect()),
  };
});
// где приветствие касается пилюли и где карточка уходит под шапку — из раскладки, без эффекта
const geo = page => page.evaluate(() => {
  const mh = document.querySelector('#view-news .masthead'), ng = document.getElementById('nextGame'), lock = document.getElementById('projSwipe');
  const top = el => { let y = 0; for (let n = el; n; n = n.offsetParent) y += n.offsetTop; return y; };
  const pb = lock.getBoundingClientRect().bottom;
  return { pb, mhTop: top(mh), mhH: mh.offsetHeight, ngBottom: top(ng) + ng.offsetHeight, max: document.documentElement.scrollHeight - innerHeight,
    gbcrOk: Math.abs(top(mh) - scrollY - mh.getBoundingClientRect().top) < 1.5 };
});

async function phone(b, width, shots) {
  console.log(`· телефон ${width}`);
  const { ctx, page, errs } = await openPage(b, { viewport: { width, height: 844 }, project: 'classic', storage: QUIET });
  await page.waitForFunction(() => { const n = document.getElementById('nextGame'); return n && !n.hidden && /Короля-Лича/.test(n.textContent); }, null, { timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15000 });   // заставка ушла
  await page.waitForTimeout(500);
  const g = await geo(page);
  check(g.gbcrOk, `${width}: место приветствия по offsetTop совпадает с экраном`);
  check(g.max > g.ngBottom, `${width}: ленты хватает, чтобы карточка ушла под шапку`);
  let s = await state(page);
  check(!s.tf && !s.op && !s.on, `${width}: в начале страницы приветствие как есть, пилюли нет`);

  // ступенями вниз: прогресс растёт, приветствие гаснет, к концу — скрыто
  const touch = g.mhTop - g.pb, full = touch + g.mhH * .75;
  let prevOp = 1, mono = true, seenMid = false, prevW = 1e9, shrink = true, n = 0;
  for (let y = 0; y <= Math.min(g.max, Math.ceil(full) + 40); y += 16) {
    await scrollTo(page, y);
    s = await state(page);
    const op = s.op === '' ? 1 : +s.op;
    if (y < touch - 1 && (s.tf || s.op)) { mono = false; console.log('    до касания уже есть стиль, y=' + y); }
    if (op > prevOp + 1e-6) mono = false;
    if (s.mhR[2] > prevW + .5) shrink = false;
    if (s.tf && op > 0 && op < 1) seenMid = true;
    prevOp = op; prevW = s.mhR[2];
    if (shots && y > touch - 20 && y < full + 20 && n < 9 && (y - Math.round(touch)) % 32 < 16) await page.screenshot({ path: `${shots}/newsfx-${width}-a${n++}.png` });
  }
  check(mono, `${width}: прозрачность приветствия только убывает по мере прокрутки`);
  check(shrink, `${width}: приветствие только сжимается`);
  check(seenMid, `${width}: есть промежуточные кадры (впитывается, а не исчезает разом)`);
  await scrollTo(page, Math.ceil(full) + 30);
  s = await state(page);
  check(+s.op === 0 && s.vis === 'hidden' && s.cvis === 'hidden', `${width}: при p≥1 приветствие скрыто (opacity ${s.op}, visibility ${s.cvis})`);

  // карточка ещё видна — пилюли нет; ушла под шапку — пилюля появляется
  const before = Math.floor(g.ngBottom - g.pb - 40);
  await scrollTo(page, before);
  s = await state(page);
  check(!s.on && !s.away, `${width}: пока карточка на экране, плавающей пилюли нет`);
  await scrollTo(page, Math.ceil(g.ngBottom - g.pb + 30));
  s = await state(page);
  check(s.on && s.away, `${width}: карточка ушла под шапку — пилюля появилась, карточка спрятана (место держит)`);
  if (shots) for (let i = 0; i < 4; i++) { await page.waitForTimeout(i ? 140 : 40); await page.screenshot({ path: `${shots}/newsfx-${width}-f${i}.png` }); }
  await page.waitForTimeout(900);
  const fl = await page.evaluate(() => { const f = document.getElementById('ngFloat'), r = f.getBoundingClientRect(), c = document.getElementById('calFab').getBoundingClientRect();
    return { txt: f.textContent, aria: f.getAttribute('aria-hidden'), tab: f.tabIndex, op: +getComputedStyle(f).opacity, r: [r.left, r.top, r.width, r.height], c: [c.left, c.top, c.width, c.height], par: f.parentNode === document.body }; });
  const fa = await page.evaluate(() => document.getElementById('ngFloat').getAttribute('aria-label'));
  check(/(Сегодня|Завтра|Через \d+ д)/.test(fl.txt) && /Короля-Лича/.test(fl.txt) && /свободно 4 из 5/.test(fa), `${width}: в пилюле отсчёт, название и кольцо мест (${fl.txt.replace(/\s+/g, ' ').trim()} | ${fa})`);
  check(fl.aria === 'false' && fl.tab === 0 && fl.op > .99, `${width}: пилюля доступна (aria-hidden=false, tabindex 0, видна)`);
  check(fl.par && Math.abs((fl.r[1] + fl.r[3]) - (fl.c[1] + fl.c[3])) < 1.5 && Math.abs(fl.r[0] + fl.r[2] - fl.c[0]) < 1.5, `${width}: пилюля в body, одной полосой с календарём (стык к стыку)`);
  // глубже по ленте пилюля остаётся
  await scrollTo(page, g.max);
  s = await state(page);
  check(s.on, `${width}: пилюля едет за пользователем до конца ленты`);
  if (shots) await page.screenshot({ path: `${shots}/newsfx-${width}-g.png` });
  // перерисовка новостей (такт облака) не трогает пилюлю
  const same = await page.evaluate(() => { const f = document.getElementById('ngFloat'), k = f.querySelector('.ngf-k'); renderNews(); renderNews(); return f.querySelector('.ngf-k') === k && f.classList.contains('on'); });
  check(same, `${width}: renderNews не пересобирает пилюлю`);
  // играет музыка: пилюля встаёт над плашкой, тост — над пилюлей
  if (width === 390) {
    const mus = await page.evaluate(() => new Promise(res => {
      const mb = document.getElementById('musicBar'); mb.hidden = false; toast('Проверка');
      setTimeout(() => {   // тост выезжает снизу — меряем, когда встал
        const f = document.getElementById('ngFloat').getBoundingClientRect(), t = document.getElementById('toast').getBoundingClientRect();
        mb.hidden = true; const f2 = document.getElementById('ngFloat').getBoundingClientRect();
        res({ up: f.bottom < f2.bottom - 60, toastAbove: t.bottom <= f.top });
      }, 500);
    }));
    check(mus.up && mus.toastAbove, `${width}: с плашкой музыки пилюля выше неё, тост выше пилюли (${JSON.stringify(mus)})`);
  }
  // тап — анонсы
  await page.click('#ngFloat');
  await page.waitForTimeout(250);
  check(await page.evaluate(() => document.getElementById('scrim').classList.contains('open')), `${width}: тап по пилюле открывает запись на игру`);
  check(await page.evaluate(() => +getComputedStyle(document.getElementById('ngFloat')).opacity < .05 || getComputedStyle(document.getElementById('ngFloat')).pointerEvents === 'none'), `${width}: под модалкой пилюля прячется`);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(300);

  // обратно вверх — всё возвращается
  await scrollTo(page, Math.max(0, Math.floor(g.ngBottom - g.pb - 60)));
  if (shots) for (let i = 0; i < 3; i++) { await page.waitForTimeout(i ? 150 : 50); await page.screenshot({ path: `${shots}/newsfx-${width}-r${i}.png` }); }
  await page.waitForTimeout(800);
  s = await state(page);
  check(!s.on && !s.away && !s.ftf, `${width}: карточка снова видна — пилюля вернулась в неё, inline-стилей перехода нет`);
  await scrollTo(page, Math.round(touch + g.mhH * .4));
  s = await state(page);
  check(s.tf && +s.op > 0 && s.vis !== 'hidden', `${width}: на обратном ходе приветствие выходит из пилюли`);
  await scrollTo(page, 0);
  await page.waitForTimeout(900);                   // пружина возвращает блок и успокаивается
  s = await state(page);
  check(!s.tf && !s.op && !s.vis && !s.suck, `${width}: в начале страницы inline-стили сняты (${s.tf}|${s.op}|${s.vis}|${s.suck})`);
  if (shots) await page.screenshot({ path: `${shots}/newsfx-${width}-z.png` });

  // игру сняли, пока пилюля на экране — пилюля уходит, карточка не остаётся спрятанной
  await scrollTo(page, Math.ceil(g.ngBottom - g.pb + 30));
  await page.waitForTimeout(700);
  const gone = await page.evaluate(() => { const keep = GAMES; GAMES = []; renderNews();
    const f = document.getElementById('ngFloat'), r = { on: f.classList.contains('on'), away: document.getElementById('nextGame').classList.contains('ngf-away') };
    GAMES = keep; renderNews(); return r; });
  check(!gone.on && !gone.away, `${width}: игра пропала — пилюля ушла сразу`);
  await page.waitForTimeout(300);

  // уход в другой раздел — эффект снят, пилюли нет
  await scrollTo(page, Math.ceil(g.ngBottom - g.pb + 30));
  await page.evaluate(() => go('world'));
  await page.waitForTimeout(400);
  const away = await page.evaluate(() => ({ fl: !!document.getElementById('ngFloat'), tf: document.querySelector('#view-news .masthead').style.transform }));
  check(!away.fl && !away.tf, `${width}: в другом разделе пилюли и стилей нет`);
  await page.evaluate(() => go('news'));
  await page.waitForTimeout(1200);
  check(errs.length === 0, `${width}: ошибок в консоли нет` + (errs.length ? '\n    ' + [...new Set(errs)].slice(0, 6).join('\n    ') : ''));
  await ctx.close();
}

(async () => {
  await mock('/__mock/rows', 'POST', [{ key: 'comik:games:v1', value: [GAME] }]);
  const b = await launch();
  await phone(b, 390, SHOTS);
  await phone(b, 360, '');
  await phone(b, 430, '');

  console.log('· телефон 390, prefers-reduced-motion');
  {
    const { ctx, page, errs } = await openPage(b, { viewport: { width: 390, height: 844 }, project: 'classic', storage: QUIET });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => { const n = document.getElementById('nextGame'); return n && !n.hidden; }, null, { timeout: 15000 });
    const g = await geo(page);
    let tf = false, suck = false, anims = 0;
    for (let y = 0; y <= g.ngBottom; y += 24) { await scrollTo(page, y); const s = await state(page); tf = tf || !!s.tf || !!s.op; suck = suck || !!s.suck; anims += s.anims; }
    await scrollTo(page, Math.ceil(g.ngBottom - g.pb + 30));
    let s = await state(page);
    anims += s.anims;
    check(!tf && !suck, 'без анимаций: приветствие прокручивается как обычно (ни transform, ни opacity)');
    check(s.on && s.anims === 0 && anims === 0, `без анимаций: пилюля появляется сразу, без переходов (анимаций ${anims})`);
    await scrollTo(page, 0);
    s = await state(page);
    check(!s.on && !s.away && s.anims === 0, 'без анимаций: наверху пилюля сразу уходит');
    check(errs.length === 0, 'без анимаций: ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 4).join('\n    ') : ''));
    await ctx.close();
  }

  console.log('· десктоп 1440');
  {
    const { ctx, page, errs } = await openPage(b, { viewport: { width: 1440, height: 900 }, project: 'classic', storage: QUIET });
    await page.waitForFunction(() => { const n = document.getElementById('nextGame'); return n && !n.hidden; }, null, { timeout: 15000 });
    let bad = false;
    for (let y = 0; y <= 1600; y += 100) {
      await scrollTo(page, y);
      const s = await state(page);
      if (s.fl || s.tf || s.op || s.vis || s.suck || s.away) bad = true;
    }
    const ps = await page.evaluate(() => { const a = getComputedStyle(document.getElementById('projSwipe'), '::after'); return a.content; });
    check(!bad, 'десктоп: нет #ngFloat и inline-стилей у приветствия при прокрутке');
    check(ps === 'none' || ps === 'normal', 'десктоп: кольца вокруг пилюли нет');
    check(errs.length === 0, 'десктоп: ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 4).join('\n    ') : ''));
    // окно сузили до телефона — эффект включается, расширили обратно — снят
    await page.setViewportSize({ width: 600, height: 900 });
    await page.waitForTimeout(400);
    const g = await geo(page);
    await scrollTo(page, 0);
    await scrollTo(page, Math.round(g.mhTop - g.pb + g.mhH * .5));
    let s = await state(page);
    check(!!s.tf, 'окно сузили до телефона — приветствие впитывается');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    s = await state(page);
    check(!s.tf && !s.op && !s.fl, 'расширили обратно — стили и пилюля сняты');
    await ctx.close();
  }
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
