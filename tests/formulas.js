/* Формулы бросков (кнопка «#» Мастера на «Доске ходов»): кнопка только у ГМа на доске; группы — свёрнутые таблицы,
   раскрываются нажатием и запоминаются; строки с ▸ раскрывают мини-таблицу; поиск раскрывает совпавшее;
   на телефоне ничего не вылезает за экран, на десктопе окно шире обычного.
   node tests/formulas.js [папка-для-скриншотов] */
const { launch, openPage, login, check, done, PHONE, DESK } = require('./lib');
const SHOTS = process.argv[2] || '';

(async () => {
  const b = await launch();
  const vis = p => p.evaluate(() => { const e = document.getElementById('fxBtn'); return !!(e && !e.hidden && getComputedStyle(e).display !== 'none'); });
  const shot = (p, name) => SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png` }) : null;
  for (const [n, vp] of [['phone', PHONE], ['desk', DESK]]) {
    console.log(`· ${n}`);
    const { page, ctx, errs } = await openPage(b, { viewport: vp, storage: { 'comik:cookies:ok': '1' } });
    await page.evaluate(() => { setProject('legacy'); go('combat'); }); await page.waitForTimeout(400);
    check(!(await vis(page)), `${n}: гость — кнопки нет`);
    await login(page, 'hinoma');
    await page.evaluate(() => go('combat')); await page.waitForTimeout(500);
    check(await vis(page), `${n}: мастер на доске — кнопка есть`);
    await page.click('#fxBtn'); await page.waitForTimeout(400);

    const st = await page.evaluate(() => ({
      groups: document.querySelectorAll('#fxList details.fx-sec').length,
      open: document.querySelectorAll('#fxList details.fx-sec[open]').length,
      rows: document.querySelectorAll('#fxList .fx-tbl>tbody>tr:not(.fx-subrow)').length,
      data: FX_DATA.reduce((s, g) => s + g[1].length, 0),
      width: Math.round(document.getElementById('modal').getBoundingClientRect().width),
    }));
    check(st.groups === 8 && st.open === 0, `${n}: 8 групп, все свёрнуты (раскрыто ${st.open})`);
    check(st.rows === st.data, `${n}: в таблицах все строки (${st.rows} из ${st.data})`);
    if (n === 'desk') check(st.width > 900, `${n}: окно шире обычного (${st.width} px)`);
    await shot(page, `fx-${n}-closed`);

    // группа раскрывается по нажатию на заголовок
    await page.click('#fxList details.fx-sec[data-g="Бой"] > summary'); await page.waitForTimeout(200);
    const boi = await page.evaluate(() => { const d = document.querySelector('#fxList details[data-g="Бой"]'); const t = d.querySelector('.fx-tbl');
      return { open: d.open, th: [...t.querySelectorAll(':scope>thead th')].filter(x => getComputedStyle(x).display !== 'none').map(x => x.textContent), h: Math.round(t.getBoundingClientRect().height) }; });
    check(boi.open && boi.h > 200, `${n}: «Бой» раскрылся таблицей (${boi.h} px), колонки: ${boi.th.join(' | ')}`);
    check(n === 'phone' ? boi.th.length === 2 : boi.th.length === 3, `${n}: колонок ${boi.th.length}`);

    // строка с ▸ раскрывает мини-таблицу, повторное нажатие сворачивает
    const sub = () => page.evaluate(() => { const r = [...document.querySelectorAll('#fxList tr.fx-has')].find(x => x.textContent.includes('Атаки толпы')); const s = r.nextElementSibling;
      return { open: r.classList.contains('open'), aria: r.querySelector('.fx-tg').getAttribute('aria-expanded'), shown: getComputedStyle(s).display !== 'none', rows: s.querySelectorAll('.fx-sub tbody tr').length }; });
    check(!(await sub()).shown, `${n}: мини-таблица «Атаки толпы» сначала скрыта`);
    await page.click('#fxList tr.fx-has:has-text("Атаки толпы") .fx-tg'); await page.waitForTimeout(150);
    let s = await sub();
    check(s.open && s.shown && s.aria === 'true' && s.rows === 7, `${n}: нажатие раскрыло мини-таблицу (${s.rows} строк)`);
    await shot(page, `fx-${n}-open`);
    await page.click('#fxList tr.fx-has:has-text("Атаки толпы") td.fx-f'); await page.waitForTimeout(150);
    s = await sub();
    check(!s.open && !s.shown && s.aria === 'false', `${n}: повторное нажатие свернуло`);
    // клавиатура: Enter на кнопке строки
    await page.focus('#fxList tr.fx-has:has-text("Укрытие") .fx-tg'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
    check(await page.evaluate(() => [...document.querySelectorAll('#fxList tr.fx-has')].find(x => x.textContent.includes('Укрытие')).classList.contains('open')), `${n}: Enter раскрывает строку`);
    const isOpen = name => page.evaluate(nm => [...document.querySelectorAll('#fxList tr.fx-has')].find(x => x.textContent.includes(nm)).classList.contains('open'), name);
    // выделение где-то ещё на странице не мешает ▸ и клавиатуре
    await page.evaluate(() => { const td = [...document.querySelectorAll('#fxList td.fx-f')].find(x => x.closest('tr').textContent.includes('Инициатива')); const r = document.createRange(); r.selectNodeContents(td); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await page.evaluate(() => [...document.querySelectorAll('#fxList tr.fx-has .fx-tg')].find(x => x.textContent.includes('Атаки толпы')).click());
    check(await isOpen('Атаки толпы'), `${n}: при выделенном тексте в другой строке ▸ раскрывает`);
    await page.focus('#fxList tr.fx-has:has-text("Укрытие") .fx-tg'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    check(!(await isOpen('Укрытие')), `${n}: при выделенном тексте Enter сворачивает`);
    await page.evaluate(() => getSelection().removeAllRanges());
    // двойной щелчок по формуле (выделить слово) строку не переключает
    await page.dblclick('#fxList tr.fx-has:has-text("Атаки толпы") td.fx-f'); await page.waitForTimeout(150);
    check(await isOpen('Атаки толпы'), `${n}: двойной щелчок по формуле не сворачивает строку`);
    await page.evaluate(() => getSelection().removeAllRanges());
    if (n === 'phone') {   // примечание стоит сразу под формулой, даже если название в три строки
      const gap = await page.evaluate(() => { const tr = [...document.querySelectorAll('#fxList .fx-tbl>tbody>tr')].find(x => x.textContent.includes('Атака дальнобойным'));
        return Math.round(tr.querySelector('.fx-d').getBoundingClientRect().top - tr.querySelector('.fx-f').getBoundingClientRect().bottom); });
      check(gap < 6, `${n}: примечание под формулой без пустой полосы (${gap} px)`);
    }

    // ничего не вылезает за экран; широкая таблица ячеек листается внутри своей рамки
    await page.click('#fxList details.fx-sec[data-g="Магия"] > summary'); await page.waitForTimeout(150);
    await page.click('#fxList tr.fx-has:has-text("Ячейки по уровню") .fx-tg'); await page.waitForTimeout(150);
    const ov = await page.evaluate(() => { const m = document.getElementById('modal'); const w = [...document.querySelectorAll('#fxList .fx-wrap')].map(x => x.scrollWidth - x.clientWidth);
      return { page: document.documentElement.scrollWidth - innerWidth, modal: m.scrollWidth - m.clientWidth, wrap: Math.max(...w) }; });
    check(ov.page <= 0 && ov.modal <= 0 && ov.wrap <= 1, `${n}: по ширине влезает (страница ${ov.page}, окно ${ov.modal}, таблицы ${ov.wrap})`);
    await shot(page, `fx-${n}-slots`);

    // поиск: группы с совпадениями раскрыты, мини-таблица раскрывается, если слово внутри неё
    for (const [q, want] of [['крит', 'Критическое попадание'], ['grapple', 'Захват'], ['dc', 'Типичные Сл'], ['ПАДЕНИЕ', 'Падение'], ['xp', 'Сложность сражения'], ['пассивка', 'Пассивная проверка']]) {
      await page.fill('#fxQ', q); await page.waitForTimeout(120);
      const got = await page.evaluate(() => [...document.querySelectorAll('#fxList .fx-n')].map(e => e.textContent));
      check(got.includes(want), `${n}: поиск «${q}» → «${want}» (${got.length} строк)`);
    }
    await page.fill('#fxQ', 'кольчуга'); await page.waitForTimeout(120);
    const q2 = await page.evaluate(() => ({ open: [...document.querySelectorAll('#fxList details.fx-sec')].every(d => d.open),
      armor: [...document.querySelectorAll('#fxList tr.fx-has')].some(x => x.classList.contains('open') && x.textContent.includes('Лёгкий / средний')) }));
    check(q2.open && q2.armor, `${n}: «кольчуга» — группа раскрыта, таблица доспехов открыта`);
    await shot(page, `fx-${n}-search`);
    await page.fill('#fxQ', 'абракадабра'); await page.waitForTimeout(120);
    check(await page.evaluate(() => !!document.querySelector('.fx-empty')), `${n}: пусто — «Ничего не найдено»`);
    // очистили поиск — вернулось то, что раскрывали руками
    await page.fill('#fxQ', ''); await page.waitForTimeout(150);
    const back = await page.evaluate(() => [...document.querySelectorAll('#fxList details.fx-sec[open]')].map(d => d.dataset.g).sort().join(','));
    check(back === 'Бой,Магия', `${n}: после поиска раскрыто прежнее (${back})`);
    // закрыли и открыли снова — группы помнятся
    await page.evaluate(() => closeModal()); await page.waitForTimeout(200);
    await page.click('#fxBtn'); await page.waitForTimeout(300);
    const again = await page.evaluate(() => [...document.querySelectorAll('#fxList details.fx-sec[open]')].map(d => d.dataset.g).sort().join(','));
    check(again === 'Бой,Магия', `${n}: при новом открытии раскрыто прежнее (${again})`);
    await page.waitForTimeout(500);   // окно въехало, фокус в поиске — заголовок и поиск на экране, а не прокручены вверх
    const top = await page.evaluate(() => Math.round(document.getElementById('fxQ').getBoundingClientRect().top));
    check(top > 0 && top < 400, `${n}: окно открылось с начала (поиск на ${top} px)`);
    // запрос только из знаков препинания — это не поиск: раскрытие группы запоминается
    await page.fill('#fxQ', '. ,'); await page.waitForTimeout(120);
    await page.click('#fxList details.fx-sec[data-g="Деньги"] > summary'); await page.waitForTimeout(150);
    check(await page.evaluate(() => FX_OPEN.has('Деньги')), `${n}: при запросе «. ,» раскрытие группы запомнилось`);
    await page.click('#fxList details.fx-sec[data-g="Деньги"] > summary'); await page.waitForTimeout(150);
    await page.evaluate(() => closeModal());

    await page.evaluate(() => go('news')); await page.waitForTimeout(300);
    check(!(await vis(page)), `${n}: в новостях кнопки нет`);
    await page.evaluate(() => { go('combat'); devToggleAdmin(); }); await page.waitForTimeout(300);
    check(!(await vis(page)), `${n}: режим мастера выключен — кнопки нет`);
    await page.evaluate(() => devToggleAdmin());
    check(errs.length === 0, `${n}: ошибок в консоли нет` + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }
  {
    const { page, ctx } = await openPage(b, { viewport: PHONE, storage: { 'comik:cookies:ok': '1' } });
    await login(page, 'testplayer'); await page.evaluate(() => { setProject('legacy'); go('combat'); }); await page.waitForTimeout(400);
    check(!(await vis(page)), 'игрок на доске — кнопки нет');
    await ctx.close();
  }
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
