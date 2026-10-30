/* Листы игроков без пробелов: плитки разной высоты (с фото и без, длинные имена) подтягиваются к верхним,
   порядок — слева направо, сверху вниз, разделитель «Листы игроков · ГМ» — на всю ширину под всеми листами выше.
   Мастер (hinoma) видит свои листы и чужие; ширины 375, 820, 1280, 1920; наведение, открытый лист, уход
   с раздела, смена ширины и шрифта, пустой сеттинг раскладку не ломают и не дёргают; ошибок в консоли нет.
   Листы кладёт в стенд сам, после себя возвращает строки как были.
   node tests/masonry.js [папка-для-скриншотов [метка]] */
const { launch, openPage, login, mock, check, done } = require('./lib');
const SHOTS = process.argv[2] || '', LABEL = process.argv[3] || '';

const PICS = ['aki-edae119c', 'centoriya-89817f5c', 'cherv-255563e7', 'chuma-709762a4', 'kastaliya-4a059794', 'kicune-9a66d290',
  'lilit-065fb517', 'palanis-01946e50'].map(f => `img/content/${f}.jpg`);
// [владелец, имя, фото?] — вперемешку: фото и буква, короткие и длинные имена
const SHEETS = [
  ['hinoma', 'Ара', 1], ['hinoma', 'Бенедикт Аврелиан Константинопольский', 0], ['hinoma', 'Вега', 0], ['hinoma', 'Гримм', 1],
  ['hinoma', 'Дорофея', 0], ['hinoma', 'Ёж', 1], ['hinoma', 'Жозефина Лунная Тень Северных Холмов', 0],
  ['testplayer', 'Ирма', 1], ['testplayer', 'Каэль', 0], ['testplayer', 'Лиса из Восточного квартала', 1], ['testplayer', 'Мор', 0],
  ['player_two', 'Нокс', 0], ['player_two', 'Оберон Безымянный Страж Последних Ворот', 1], ['player_two', 'Пим', 0],
  ['herr_teo', 'Рэн', 1], ['herr_teo', 'Сол', 0], ['herr_teo', 'Тиса', 1],
];

(async () => {
  const b = await launch();
  const seed = await mock('/__mock/rows'), now = Date.now(), byOwner = {};
  let pic = 0;
  SHEETS.forEach(([owner, name, ava], i) => {
    (byOwner[owner] = byOwner[owner] || []).push({ id: 'mas' + i, owner, name, level: 1 + (i % 7), role: i % 3 ? 'Воин' : 'Чародей',
      ava: ava ? PICS[pic++ % PICS.length] : '', createdAt: now, updatedAt: now });
  });
  const mine = Object.entries(byOwner).map(([o, list]) => ({ key: 'comik:chars:' + o, value: { at: now, classic: list } }));
  await mock('/__mock/rows', 'POST', seed.filter(r => !mine.some(m => m.key === r.key)).concat(mine));

  const { page, ctx, errs } = await openPage(b, { viewport: { width: 1280, height: 900 }, project: 'classic', storage: { 'comik:cookies:ok': '1' } });
  // цикл ResizeObserver в консоль не пишется — ловим его событием
  await page.evaluate(() => { window.__masErr = []; addEventListener('error', e => window.__masErr.push(String(e.message || e))); });
  await login(page, 'hinoma');
  await page.evaluate(() => { setProject('classic'); go('players'); });
  await page.waitForFunction(n => document.querySelectorAll('#players-list .ptile').length === n, SHEETS.length, { timeout: 15000 });
  await page.waitForTimeout(600);

  const shot = async name => { if (SHOTS) { await page.mouse.move(1, 1); await page.screenshot({ path: `${SHOTS}/masonry-${LABEL}${name}.png`, fullPage: true }); } };
  // раскладка: что где стоит (без transform наведения — мышь уводим) и какие span у плиток
  const grab = async () => {
    await page.mouse.move(1, 1);
    return page.evaluate(() => {
      const el = document.getElementById('players-list'), cs = getComputedStyle(el), lr = el.getBoundingClientRect();
      const items = [...el.children].map(k => {
        const r = k.getBoundingClientRect(), s = getComputedStyle(k);
        return { sep: k.classList.contains('players-sep'), tile: k.classList.contains('ptile'), x: Math.round(r.left), w: r.width,
          top: r.top, bottom: r.bottom, mt: parseFloat(s.marginTop) || 0, mb: parseFloat(s.marginBottom) || 0, span: k.style.gridRowEnd };
      });
      // ширина сетки — сумма колонок с отступами: на десктопе колонки по 344 px и справа остаётся поле
      const tr = cs.gridTemplateColumns.split(' ').map(parseFloat), gap = parseFloat(cs.columnGap) || 0;
      return { gap, tracks: tr.length, top: lr.top, bottom: lr.bottom, width: tr.reduce((a, c) => a + c, 0) + gap * (tr.length - 1), items };
    });
  };
  // проверки раскладки; ok=false — вернуть первую причину провала
  const verify = L => {
    const tiles = L.items.filter(i => i.tile), bad = [];
    const cols = [...new Set(tiles.map(t => t.x))].sort((a, c) => a - c);
    if (cols.length !== Math.min(L.tracks, tiles.length)) bad.push(`колонок с плитками ${cols.length} из ${L.tracks}`);
    if (new Set(tiles.map(t => Math.round(t.bottom - t.top))).size < 2) bad.push('все плитки одной высоты — проверять нечего');
    let prevTop = -1e9, maxBottom = L.top, sepAt = null, worst = 0;
    L.items.forEach((it, i) => {
      if (it.sep) {
        if (it.top - it.mt < maxBottom - 0.5) bad.push(`разделитель (${Math.round(it.top)}) выше низа плиток над ним (${Math.round(maxBottom)})`);
        if (it.top - it.mt - maxBottom > L.gap + 4.5) bad.push(`над разделителем пусто ${Math.round(it.top - it.mt - maxBottom)} px`);
        if (Math.abs(it.w - L.width) > 1) bad.push(`разделитель ${Math.round(it.w)} px при сетке ${Math.round(L.width)}`);
        sepAt = it.bottom + it.mb; maxBottom = Math.max(maxBottom, sepAt); return;
      }
      if (it.top < prevTop - 0.5) bad.push(`плитка ${i} выше предыдущей (${Math.round(it.top)} < ${Math.round(prevTop)})`);
      if (sepAt != null && it.top < sepAt - 0.5) bad.push(`плитка ${i} выше разделителя`);
      prevTop = it.top;
      // сосед сверху в той же колонке (или разделитель); первая плитка колонки — у верха списка
      const above = L.items.slice(0, i).filter(o => o.tile && o.x === it.x && o.bottom <= it.top + 0.5).reduce((m, o) => Math.max(m, o.bottom), -1e9);
      const ref = Math.max(above, sepAt == null ? -1e9 : sepAt);
      if (ref === -1e9) { if (Math.abs(it.top - L.top) > 1) bad.push(`плитка ${i} в первом ряду не у верха (${Math.round(it.top - L.top)} px)`); }
      else {
        const g = it.top - ref; worst = Math.max(worst, g - L.gap);
        if (g < L.gap - 1 || g > L.gap + 4) bad.push(`плитка ${i}: зазор сверху ${Math.round(g)} px при отступе ${L.gap}`);
      }
      if (L.items.slice(0, i).some(o => o.tile && o.x === it.x && o.bottom > it.top + 0.5 && o.top < it.bottom - 0.5)) bad.push(`плитка ${i} наезжает на соседа`);
      maxBottom = Math.max(maxBottom, it.bottom);
    });
    if (L.bottom < maxBottom - 0.5) bad.push(`плитки вылезают из списка на ${Math.round(maxBottom - L.bottom)} px`);
    return { ok: !bad.length, why: bad.slice(0, 3).join('; '), cols: cols.length, worst: Math.round(worst * 10) / 10 };
  };
  const same = (a, c) => JSON.stringify(a.items.map(i => [i.x, Math.round(i.top), i.span])) === JSON.stringify(c.items.map(i => [i.x, Math.round(i.top), i.span]));

  for (const w of [375, 820, 1280, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(500);
    const L = await grab(), v = verify(L);
    check(v.ok, `${w}: колонок ${v.cols}, зазоры ≤ отступа (${L.gap}) + ${v.worst} px, порядок и разделитель на месте${v.ok ? '' : ' — ' + v.why}`);
    if (w === 375 || w === 1280) await shot(w);
    await page.waitForTimeout(400);
    check(same(L, await grab()), `${w}: раскладка стоит на месте (не дёргается после замера)`);
  }

  console.log('· наведение, уход с раздела, открытый лист');
  {
    const L0 = await grab();
    // пересчёт посреди наведения (translateY) и нажатия (scale .98, без анимации — сразу) высоты строк не меняет
    await page.hover('#players-list .ptile:nth-child(1)');
    const spans = await page.evaluate(() => {
      const s = document.createElement('style'); s.textContent = '#players-list .ptile{transform:scale(.98)!important;transition:none!important}';
      document.head.appendChild(s); dispatchEvent(new Event('resize'));
      const r = [...document.querySelectorAll('#players-list > *')].map(k => k.style.gridRowEnd); s.remove(); return r;
    });
    check(JSON.stringify(spans) === JSON.stringify(L0.items.map(i => i.span)), 'наведение и нажатие (transform) высоту строк не меняют');

    await page.evaluate(() => go('news')); await page.setViewportSize({ width: 820, height: 900 }); await page.waitForTimeout(300);
    await page.evaluate(() => go('players')); await page.waitForTimeout(400);
    let v = verify(await grab());
    check(v.ok, 'сменили ширину на другом разделе, вернулись — без пробелов' + (v.ok ? '' : ' — ' + v.why));

    await page.evaluate(() => openInlineSheet('mas0', null, false));
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 1920, height: 900 }); await page.waitForTimeout(300);
    await page.evaluate(() => closeInlineSheet()); await page.waitForTimeout(700);
    v = verify(await grab());
    check(v.ok, 'лист открыт, ширину сменили, лист закрыли — без пробелов' + (v.ok ? '' : ' — ' + v.why));

    // поворот: ширина меняется без перерисовки списка — подхватывает наблюдатель
    await page.setViewportSize({ width: 375, height: 900 }); await page.waitForTimeout(300);
    v = verify(await grab());
    check(v.ok, 'смена ширины прямо на разделе — без пробелов' + (v.ok ? '' : ' — ' + v.why));

    // подменился шрифт: имена стали выше без перерисовки списка
    await page.evaluate(() => { const s = document.createElement('style'); s.id = 'masFont'; s.textContent = '#players-list .pt-name{font-size:1.5rem}'; document.head.appendChild(s); });
    await page.waitForTimeout(300);
    v = verify(await grab());
    check(v.ok, 'имена подросли (шрифт) — плитки сдвинулись следом' + (v.ok ? '' : ' — ' + v.why));
    await page.evaluate(() => document.getElementById('masFont').remove()); await page.waitForTimeout(300);
  }

  console.log('· пустой сеттинг');
  {
    await page.evaluate(() => setProject('skazki')); await page.waitForTimeout(600);
    const e = await page.evaluate(() => {
      const el = document.getElementById('players-list'), em = el.querySelector('.empty');
      return { em: !!em, h: em ? em.offsetHeight : 0, list: el.offsetHeight, mas: el.classList.contains('mas') };
    });
    check(e.em && e.h > 60 && e.list >= e.h && !e.mas, `заглушка «пусто» во весь рост (${e.h} px), обычная сетка`);
    await page.evaluate(() => { setProject('classic'); go('players'); }); await page.waitForTimeout(600);
    const v = verify(await grab());
    check(v.ok, 'вернулись в сеттинг с листами — без пробелов' + (v.ok ? '' : ' — ' + v.why));
  }

  const roErr = await page.evaluate(() => window.__masErr);
  check(!roErr.length, 'ResizeObserver не зацикливается' + (roErr.length ? ': ' + roErr.slice(0, 2).join(' | ') : ''));
  check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
  await ctx.close();
  await mock('/__mock/rows', 'POST', seed);
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
