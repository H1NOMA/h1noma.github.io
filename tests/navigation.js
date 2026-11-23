/* Навигация, фокус и печать на локальном стенде: node tests/navigation.js */
const assert = require('node:assert/strict');
const { launch, openPage, login, mock, DESK, PHONE } = require('./lib');

(async () => {
  const seed = await mock('/__mock/rows');
  const stamp = Date.now();
  const character = {
    id: 'nav01', name: 'Ирма', owner: 'testplayer', level: 4, role: 'Воин',
    featsList: ['Атлет', { n: 'Бдительный', lvl: 4 }], notes: 'Встреча у моста',
    createdAt: stamp, updatedAt: stamp
  };
  const browser = await launch();
  try {
    const key = 'comik:chars:testplayer';
    await mock('/__mock/rows', 'POST', seed.filter(row => row.key !== key).concat({
      key, value: { at: stamp, legacy: [character] }
    }));
    const { page, errs } = await openPage(browser, {
      viewport: DESK, project: 'legacy', storage: { 'comik:cookies:ok': '1', 'comik:hint:setting': '1' }
    });
    await page.waitForSelector('#splash', { state: 'detached' });
    const visit = async view => {
      await page.locator('[data-nav="' + view + '"]:visible').first().click();
      await page.locator('#view-' + view + '.active').waitFor();
    };
    await page.locator('#newsCal .cal-nav').first().click();
    const calendarContrast = await page.locator('#newsCal .cd.past:not(.has)').first().evaluate(day => {
      const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = channels => channels.reduce((sum, channel, index) => {
        const c = channel / 255;
        return sum + [0.2126, 0.7152, 0.0722][index] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      }, 0);
      const background = rgb(getComputedStyle(day.closest('#newsCal')).backgroundColor);
      const opacity = Number(getComputedStyle(day).opacity);
      const ink = rgb(getComputedStyle(day).color).map((channel,i) => opacity * channel + (1 - opacity) * background[i]);
      return (luminance(ink) + 0.05) / (luminance(background) + 0.05);
    });
    assert(calendarContrast >= 4.5);
    const card = page.locator('.news-open').first();
    await page.locator('.news-card').first().click();
    await page.locator('#scrim.open #modal .x').click();
    await card.focus();
    await page.keyboard.press('Space');
    const close = page.locator('#scrim.open #modal .x');
    await close.waitFor();
    for (const key of ['Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      assert(await close.evaluate(el => el === document.activeElement));
    }
    await page.keyboard.press('Escape');
    assert(await card.evaluate(el => el === document.activeElement));
    await visit('world');
    await visit('settings');
    await page.goBack();
    await page.locator('#view-world.active').waitFor();
    await page.reload();
    await page.locator('#view-world.active').waitFor();
    await page.goForward();
    await page.locator('#view-settings.active').waitFor();
    await page.waitForSelector('#splash', { state: 'detached' });
    await login(page, 'testplayer');
    await visit('players');
    const tile = page.locator('.ptile[data-char="nav01"]');
    await tile.focus();
    await page.keyboard.press('Enter');
    await page.locator('#miniArch.open').waitFor();
    await page.setViewportSize(PHONE);
    await page.locator('#miniArch.open').waitFor({ state: 'detached' });
    await page.locator('#playerEditor .ma-toggle').click();
    await page.locator('#miniArch.open .vit-x').click();
    await page.setViewportSize(DESK);

    // Подготовка печати идёт по обычной кнопке. PDF в headless вызывает beforeprint/afterprint браузера.
    await page.evaluate(() => { window.print = () => {}; });
    const pdf = page.locator('#playerEditor button').filter({ hasText: /^PDF$/ });
    await pdf.click();
    const sheet = await page.locator('#printSheet').textContent();
    for (const value of ['Атлет · ур. 1', 'Бдительный · ур. 4', character.notes]) assert(sheet.includes(value));
    await page.pdf({ format: 'A4', preferCSSPageSize: true });
    assert.equal(await page.locator('#printSheet').count(), 0);
    await pdf.click();
    await visit('world');
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('#printSheet').count(), 0);
    assert(await page.locator('#view-world #cats').isVisible());
    assert(!(await page.locator('body').innerText()).includes(character.notes));
    assert.deepEqual(errs, []);
    console.log('ИТОГ: навигация, клавиатура, мобильный архив и печать прошли проверку');
  } finally {
    await browser.close();
    await mock('/__mock/rows', 'POST', seed);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
