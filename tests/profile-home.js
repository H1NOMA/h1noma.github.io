/* Профиль, памятка и изображения на экране высокой плотности. Запуск со стендом tests/mock_cloud.py. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { BASE, launch, openPage, login, DESK } = require('./lib');
const quiet = { 'comik:cookies:ok': '1', 'comik:hint:setting': '1' };

async function checkGuide(page) {
  const guide = page.locator('#onboardCard details');
  assert.equal(await guide.getAttribute('open'), null);
  await guide.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await guide.locator('li:visible').count(), 4);
  assert(await page.evaluate(() => {
    const summary = document.activeElement;
    updateOnboard();
    return summary === document.activeElement && summary.parentElement.open;
  }));
  await guide.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.locator('#au-pass2').waitFor();
  await page.evaluate(() => closeModal());
  await guide.getByRole('button', { name: 'Калькулятор' }).click();
  await page.locator('#modal').getByRole('heading', { name:'Характеристики' }).waitFor();
  await page.evaluate(() => { closeModal(); go('news'); });
  await page.getByRole('button', { name: 'Скрыть памятку' }).click();
  await page.reload();
  await page.waitForFunction(() => typeof SESSION_READY !== 'undefined' && SESSION_READY);
  assert(await page.locator('#onboardCard').isHidden());
}

async function checkImages(page) {
  const result = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 1024;
    const g = c.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, c.width, c.height);
    gradient.addColorStop(0, '#a3e8ff'); gradient.addColorStop(1, '#332c49');
    g.fillStyle = gradient; g.fillRect(0, 0, c.width, c.height);
    const blob = await new Promise(resolve => c.toBlob(resolve));
    const regular = await compressImage(blob, 1920, .84, IMG_MAX);
    const compact = await compressImage(blob, 1920, .84, 7000);
    const img = new Image();
    img.src = regular; await img.decode();
    const width = img.naturalWidth;
    img.src = compact; await img.decode();
    openAvaCrop(regular, 4/5, 720, 900);
    return { width, compactWidth: img.naturalWidth, compactLength: compact.length };
  });
  assert.equal(result.width, 1920);
  assert(result.compactLength <= 7000 && result.compactWidth < result.width);
  const crop = page.locator('.crop-cv');
  await crop.waitFor();
  assert.equal(await crop.evaluate(c => c.width / c.clientWidth), 3);
  await page.locator('.crop-box [data-x]').click();
  assert.deepEqual(await page.evaluate(() => {
    applyAppIcon('legacy');
    return Array.from(document.querySelectorAll('link[rel="icon"]'), el => el.getAttribute('href'));
  }), ['icon-legacy-192.png', 'icon-legacy-512.png']);
}

async function checkProfile(page) {
  await login(page, 'testplayer');
  await page.evaluate(() => {
    setProject('classic');
    const char = { id:'profile-sheet', owner:currentTag(), name:'Лира', role:'Бард', level:5, updatedAt:Date.now() };
    CHARS_ALL[CUR_PROJECT] = [char, {...char, id:'second', name:'Рин'}, {...char, id:'another', owner:'another'}, {...char, id:'deleted', deleted:true}];
    bindGameData();
    const game = { id:'evening', title:'Вечерняя сессия', game:CUR_PROJECT, date:'2099-02-02', time:'19:00', players:[{tag:currentTag()}] };
    GAMES = [game, {...game, id:'morning', title:'Утренняя сессия', time:'9:00'}, {...game, id:'past', date:'2020-01-01'}, {...game, id:'other', date:'2099-01-01', players:[]}];
    openProfileCard();
  });
  const profile = page.locator('#modal .pc-home');
  assert.deepEqual(await profile.locator('[data-char]').allTextContents(), ['ЛираБард · 5 ур.', 'РинБард · 5 ур.']);
  await profile.locator('[data-game="morning"]').click();
  await page.locator('#modal2').getByRole('heading', { name:'Утренняя сессия' }).waitFor();
  await page.locator('#modal2 .x').click();
  await profile.locator('#pcLook summary').click();
  await profile.locator('#pc-name').fill('Лунный бард');
  assert(await profile.locator('#pcAv svg.profile-die path').count() > 0);
  assert.equal((await profile.locator('#pcAv').textContent()).trim(), '');
  await profile.locator('.pc-preset[data-bg]').first().click();
  const fill = await profile.locator('.pc-preset[data-bg]').first().getAttribute('data-bg');
  await profile.getByRole('button', {name:'Сохранить'}).click();
  await page.evaluate(() => openProfileCard());
  assert.equal(await profile.locator('#pcName').innerText(), 'Лунный бард');
  for (const id of ['pcAv', 'profBtn', 'drAva']) {
    const avatar = page.locator('#' + id);
    assert.equal(await avatar.locator('.profile-die').count(), 1);
    assert.equal(await avatar.evaluate(el => el.style.getPropertyValue('--die-fill')), fill);
    assert.equal(await avatar.evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
  }
  assert.equal(await profile.locator('#pcActivity section').first().evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
  await page.evaluate(() => renderSettings());
  assert.equal(await page.locator('#view-settings .set-av > svg.profile-die').count(), 1);
  assert(await page.evaluate(() => {
    const row=document.createElement('div');
    row.innerHTML=gsAvaHtml({tag:currentTag(), name:profName(SESSION)}, 0, 'morning');
    return !!row.querySelector('.gs-ava > svg.profile-die') && !row.textContent.trim();
  }));
  assert.equal(await profile.locator('#pcActivity h3 svg:has(path)').count(), 2);
  if (process.env.TEST_EVIDENCE) {
    await page.waitForFunction(() => +getComputedStyle(document.getElementById('toast')).opacity === 0);
    await page.locator('#modal').screenshot({path:path.join(process.env.TEST_EVIDENCE, 'profile-mobile.png'), scale:'css', animations:'disabled'});
  }
  await profile.locator('#pcAccount summary').click();
  await profile.getByRole('button', {name:'Пароль'}).waitFor();
  await profile.locator('.pc-bookmarks').click();
  await page.getByRole('heading', {name:'Мои закладки'}).waitFor();
  await page.evaluate(() => openProfileCard());
  await profile.locator('[data-char="profile-sheet"]').click();
  await page.waitForFunction(() => INLINE_ID === 'profile-sheet' && document.querySelector('#playerEditor #ep-name'));
  assert.equal(await page.locator('#playerEditor #ep-name').inputValue(), 'Лира');
  await page.locator('#playerEditor #ep-name').fill('Лира Серебряная');
  await page.evaluate(() => openProfileCard());
  await profile.locator('[data-char="second"]').click();
  await page.waitForFunction(() => INLINE_ID === 'second' && document.querySelector('#playerEditor #ep-name')?.value === 'Рин');
  assert(await page.evaluate(() => CHARS.some(c => c.id === 'profile-sheet' && c.name === 'Лира Серебряная')));
  await page.evaluate(() => openProfileCard());
  await profile.getByRole('button', {name:'Новый персонаж'}).click();
  await page.locator('#np-name').waitFor();
  await page.evaluate(() => closeModal());
  await page.setViewportSize(DESK);
  await page.evaluate(() => openProfileCard());
  const panels = await profile.locator('#pcActivity section').evaluateAll(nodes => nodes.map(el => Math.round(el.getBoundingClientRect().top)));
  assert.equal(panels[0], panels[1]);
}

(async () => {
  assert(['localhost', '127.0.0.1'].includes(new URL(BASE).hostname));
  const browser = await launch();
  try {
    const { page, errs } = await openPage(browser, { storage:quiet, deviceScaleFactor:3 });
    await page.waitForFunction(() => !document.getElementById('splash'));
    await checkGuide(page);
    await checkImages(page);
    await checkProfile(page);
    assert.deepEqual(errs, []);
    console.log('ИТОГ: профиль, памятка, изображения и плотность 3× проверены');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
