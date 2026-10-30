/* Аккаунт (v300): закладки, уведомления, смена пароля и логина, выход — в карточке профиля, а не в «Настройках»;
   игрок сам удаляет аккаунт (облако API 4, komik_delete_me): у команды и на облаке без API 4 кнопки нет; после
   удаления строк игрока в облаке нет, войти тем же паролем нельзя, старый токен ничего не пишет, логин занят,
   устройство вычищено. Ошибки удаления (пароль, команда, сеть) — человеческими словами, листы после них пишутся.
   v302: «Выйти» — только это устройство; сессию сняла библиотека или аккаунт удалён на другом устройстве (ответ на
   удаление потерялся) — сайт выходит сам; сбои входа и регистрации — человеческими словами; аватар в шапке на
   880–1179 и закладки гостя в настройках; «С чего начать»; профиль с клавиатуры; копия не трогает реестр логинов.
   node tests/account.js */
const { launch, openPage, login, mock, rows, check, done, BASE, DESK } = require('./lib');

// тосты — в журнал страницы: часть из них живёт 2.6 с, и между шагами их не поймать по экрану
const hookToasts = page => page.evaluate(() => { window.__t = []; const t = window.toast; window.toast = function (m) { window.__t.push(String(m)); return t.apply(this, arguments); }; });
const sawToast = (page, re, ms = 15000) => page.waitForFunction(src => (window.__t || []).some(m => new RegExp(src).test(m)), re.source, { timeout: ms }).then(() => true, () => false);
const toastsNow = page => page.evaluate(() => (window.__t || []).join(' | '));
const delShown = page => page.evaluate(() => { const d = document.getElementById('pcDel'); return !!d && !d.hidden; });
// ответы 4xx/5xx, которые проверка вызывает сама (неверный пароль, отказ сервера), браузер пишет в консоль — это не ошибки сайта
const realErrs = errs => errs.filter(e => !/Failed to load resource: the server responded with a status of (400|401|403|422|429|500|502|503)/.test(e));
const errLine = errs => 'ошибок в консоли нет' + (errs.length ? '\n    ' + [...new Set(errs)].slice(0, 6).join('\n    ') : '');
const authTok = async (tag, pass) => {
  const r = await fetch(BASE + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'anon' }, body: JSON.stringify({ email: tag + '@komikdnd.ru', password: pass }) });
  return r.status;
};

async function register(page, tag, pass) {
  await page.evaluate(() => openAuth('register'));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'au-tag', null, { timeout: 5000 });
  await page.fill('#au-tag', tag); await page.fill('#au-pass', pass); await page.fill('#au-pass2', pass);
  await page.check('#au-agree');
  await page.evaluate(() => doRegister());
}

(async () => {
  const b = await launch();
  const seed = await mock('/__mock/rows');
  await mock('/__mock/fail', 'POST', {});

  {
    console.log('· игрок: профиль вместо настроек (десктоп)');
    const { page, ctx, errs } = await openPage(b, { viewport: DESK });
    await login(page, 'testplayer');
    await hookToasts(page);
    await page.click('#drAva');
    await page.waitForSelector('#modal .pc-acts', { timeout: 5000 });
    const rowsTxt = await page.$$eval('#modal .pc-acts .set-row .rl', els => els.map(e => e.childNodes[0].textContent.trim()));
    check(['Закладки', 'Уведомления о новых играх', 'Сменить пароль', 'Сменить логин', 'Выйти'].every(t => rowsTxt.includes(t)), 'в профиле: закладки, уведомления, пароль, логин, выход (' + rowsTxt.join(', ') + ')');
    check(await page.evaluate(() => !!document.querySelector('#modal #pushBtn.set-sw')), 'переключатель уведомлений — в профиле');
    check(await page.waitForFunction(() => { const d = document.getElementById('pcDel'); return d && !d.hidden; }, null, { timeout: 8000 }).then(() => true, () => false), '«Удалить аккаунт» есть (облако API 4)');
    await page.click('#modal .pc-acts .set-row:has-text("Закладки")');
    check(await page.waitForFunction(() => /Мои закладки/.test(document.getElementById('modal').textContent), null, { timeout: 3000 }).then(() => true, () => false), 'закладки открываются из профиля');
    await page.evaluate(() => closeModal());
    await page.evaluate(() => go('settings'));
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => { const el = document.getElementById('settingsPage'); return { txt: el.textContent, prof: !!el.querySelector('button.set-prof'), push: !!el.querySelector('#pushBtn') }; });
    check(st.prof && !st.push && !/Выйти|Новые игры|Изменить логин|Мой профиль/.test(st.txt), 'в настройках — только шапка профиля, без перенесённых пунктов');
    check(/Иконка приложения/.test(st.txt) && /Доступность/.test(st.txt), 'иконка приложения и доступность — на месте');
    await page.click('#settingsPage button.set-prof');
    check(await page.waitForSelector('#modal .pc-acts', { timeout: 3000 }).then(() => true, () => false), 'шапка в настройках открывает профиль');
    const outs = []; page.on('request', q => { if (/\/auth\/v1\/logout/.test(q.url())) outs.push(q.url().replace(BASE, '')); });
    await page.evaluate(() => { window.__t = []; });
    await page.click('#modal .pc-acts .set-row:has-text("Выйти")');
    await page.waitForFunction(() => currentTag() === null, null, { timeout: 8000 }).catch(() => {});
    check(await page.evaluate(() => currentTag() === null && !document.getElementById('scrim').classList.contains('open')), '«Выйти» из профиля — выход, окно закрыто');
    check(outs.length === 1 && /[?&]scope=local\b/.test(outs[0]), `выход — только на этом устройстве (${outs.join(', ') || 'запроса нет'})`);
    await page.waitForTimeout(300);
    check(/Вы вышли/.test(await toastsNow(page)) && !/Сессия завершена/.test(await toastsNow(page)), 'свой выход — не «потеря сессии»');
    check(errs.length === 0, errLine(errs));
    await ctx.close();
  }

  {
    console.log('· сессию сняла библиотека (пароль сменили или вышли на другом устройстве)');
    const { page, ctx, errs } = await openPage(b, { viewport: DESK });
    await login(page, 'testplayer');
    await hookToasts(page);
    // открыт свой лист с несохранённой правкой: облако его уже не примет (запись уйдёт анонимом)
    const cid = await page.evaluate(async () => { const now = Date.now(); const c = { id: 'lost' + now.toString(36), owner: 'testplayer', name: 'Потеря', level: 1, createdAt: now, updatedAt: now }; CHARS_ALL[CUR_PROJECT].push(c); bindGameData(); await persistChars(); go('players'); return c.id; });
    await page.waitForTimeout(300);
    await page.evaluate(id => openInlineSheet(id), cid);
    await page.waitForSelector('#playerEditor #ep-name', { timeout: 5000 });
    await page.fill('#playerEditor #ep-name', 'Потеря-правка');
    await page.evaluate(() => { window.__t = []; });
    // токен истёк, а refresh-токен сервер уже отозвал: supabase-js сам удаляет сессию (SIGNED_OUT)
    const refresh = '**/auth/v1/token?grant_type=refresh_token';
    await page.route(refresh, r => r.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }) }));
    await page.evaluate(() => { const k = Object.keys(localStorage).find(x => /^sb-.*-auth-token$/.test(x)); const s = JSON.parse(localStorage.getItem(k)); s.expires_at = Math.floor(Date.now() / 1000) - 60; localStorage.setItem(k, JSON.stringify(s)); });
    await page.evaluate(() => supa.auth.getSession().catch(() => {}));
    check(await page.waitForFunction(() => currentTag() === null, null, { timeout: 10000 }).then(() => true, () => false), 'сайт заметил потерю сессии и вышел');
    await page.waitForTimeout(600);
    check(await sawToast(page, /^Сессия завершена/) && !/Нет прав/.test(await toastsNow(page)), `тост «Сессия завершена — войдите снова», без «Нет прав» от записи открытого листа (${await toastsNow(page)})`);
    check(await page.evaluate(() => document.getElementById('drAva').textContent === '?' && localStorage.getItem('comik:session:v1') === 'null' && INLINE_ID === null), 'аватар — «?», вход на устройстве забыт, лист свёрнут');
    await page.unroute(refresh);
    await login(page, 'testplayer');
    const saved = await page.waitForFunction(async id => { const r = await (await fetch('/__mock/rows')).json(); const v = (r.find(x => x.key === 'comik:chars:testplayer') || {}).value || {};
      return Object.values(v).some(l => Array.isArray(l) && l.some(c => c && c.id === id && c.name === 'Потеря-правка')); }, cid, { timeout: 15000, polling: 500 }).then(() => true, () => false);
    check(saved, 'правка листа, сделанная до потери сессии, дошла в облако после нового входа');
    check(realErrs(errs).length === 0, errLine(realErrs(errs)));
    await ctx.close();
  }

  {
    console.log('· вход и регистрация: сбои связи — человеческими словами');
    const { page, ctx } = await openPage(b);
    await hookToasts(page);
    const attempt = async (mode, fn, tag, pass) => {
      const url = mode === 'login' ? '**/auth/v1/token?grant_type=password' : '**/auth/v1/signup';
      if (fn) await page.route(url, fn);
      await page.evaluate(m => { window.__t = []; openAuth(m); }, mode);
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'au-tag', null, { timeout: 5000 });
      await page.fill('#au-tag', tag); await page.fill('#au-pass', pass);
      if (mode === 'register') { await page.fill('#au-pass2', pass); await page.check('#au-agree'); }
      await page.evaluate(m => m === 'login' ? doLogin() : doRegister(), mode);
      await page.waitForFunction(() => (window.__t || []).length > 0, null, { timeout: 20000 }).catch(() => {});
      if (fn) await page.unroute(url);
      return toastsNow(page);
    };
    const j = (status, body) => r => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const cases = [
      ['login', j(502, {}), /^Облако не отвечает/, 'вход, шлюз 502'],
      ['login', r => r.abort(), /^Облако не отвечает/, 'вход, нет сети'],
      ['login', j(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }), /^Слишком много попыток/, 'вход, лимит попыток'],
      ['login', null, /^Неверный логин или пароль$/, 'вход, неверный пароль'],
      ['register', j(503, {}), /^Облако не отвечает/, 'регистрация, шлюз 503'],
      ['register', r => r.abort(), /^Облако не отвечает/, 'регистрация, нет сети'],
    ];
    for (const [mode, fn, re, name] of cases) {
      const t = await attempt(mode, fn, mode === 'login' ? 'testplayer' : 'neterr_' + Date.now().toString(36), mode === 'login' && !fn ? 'wrongpass1' : 'password123');
      check(re.test(t) && !/Supabase/.test(t), `${name} → «${t || '—'}»`);
    }
    check(await page.evaluate(() => currentTag() === null), 'никуда не вошёл');
    await ctx.close();
  }

  {
    console.log('· 880–1179: аватар в шапке, закладки гостя — в настройках');
    const { page, ctx, errs } = await openPage(b, { viewport: { width: 1000, height: 800 } });
    const seen = {};
    for (const w of [390, 879, 880, 1000, 1179, 1180, 1440]) {
      await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(120);
      seen[w] = await page.evaluate(() => { const p = document.getElementById('profBtn'); return !!p && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width > 0; });
    }
    check(!seen[390] && !seen[879] && seen[880] && seen[1000] && seen[1179] && !seen[1180] && !seen[1440], 'аватар в шапке — только на 880–1179 ' + JSON.stringify(seen));
    for (const w of [880, 1179]) {
      await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(120);
      const g = await page.evaluate(() => { const p = document.getElementById('profBtn').getBoundingClientRect(), s = document.getElementById('searchFloat').getBoundingClientRect(); return { gap: p.left - s.right, edge: innerWidth - p.right }; });
      check(g.gap >= 6 && g.edge >= 16, `${w}: поиск и аватар не наезжают, справа нет пустоты (зазор ${Math.round(g.gap)}, до края ${Math.round(g.edge)})`);
    }
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.evaluate(() => { const h = document.getElementById('hintSpot'); if (h) h.remove(); });
    await page.click('#profBtn');
    check(await page.waitForSelector('#modal #auSubmit', { timeout: 3000 }).then(() => true, () => false), 'гость: аватар «?» — вход');
    await page.evaluate(() => { closeModal(); toggleBookmark(ARCHIVE.find(z => z && !z.deleted).id); go('settings'); });
    await page.waitForTimeout(300);
    await page.click('#settingsPage .set-row:has-text("Закладки")');
    check(await page.waitForFunction(() => /Мои закладки/.test(document.getElementById('modal').textContent) && document.querySelectorAll('#modal .bm-item').length === 1, null, { timeout: 3000 }).then(() => true, () => false), 'гость: «Настройки → Закладки» показывает его закладку');
    await page.evaluate(() => closeModal());
    await login(page, 'testplayer');
    check(await page.evaluate(() => document.getElementById('profBtn').textContent === profInitial(SESSION)), 'вошёл: на аватаре — буква имени');
    await page.click('#profBtn');
    check(await page.waitForSelector('#modal .pc-acts .set-row:has-text("Закладки")', { timeout: 3000 }).then(() => true, () => false), 'аватар открывает профиль (там закладки)');
    check(errs.length === 0, errLine(errs));
    await ctx.close();
  }

  {
    console.log('· гость: «С чего начать»');
    const { page, ctx, errs } = await openPage(b);
    const st = () => page.evaluate(() => { const su = document.getElementById('signupBtn'), li = document.querySelectorAll('#onboardCard .ob-steps li')[2]; return { su: !!su && !su.hidden, t: li ? li.textContent : '' }; });
    await page.evaluate(() => { GAMES = (GAMES || []).filter(g => !g || g.game !== CUR_PROJECT || g.deleted); renderNews(); });
    let s = await st();
    check(!s.su && /появится выше, когда Мастер анонсирует игру/.test(s.t), `игр нет — кнопки записи нет, и шаг 3 к ней не отсылает («${s.t}»)`);
    await page.evaluate(() => { const now = Date.now(); GAMES.push({ id: 'gonb', game: CUR_PROJECT, title: 'Проверка', seats: 4, players: [], createdAt: now, updatedAt: now }); renderNews(); });
    s = await st();
    check(s.su && /кнопка «Записаться на игру» выше\.$/.test(s.t), `игра есть — «кнопка выше» («${s.t}»)`);
    await page.evaluate(() => { const h = document.getElementById('hintSpot'); if (h) h.remove(); });
    await page.click('#onboardCard .btn.primary');
    check(await page.waitForFunction(() => { const p = document.getElementById('au-f-pass2'); return !!p && !p.hidden && !!document.getElementById('au-agree'); }, null, { timeout: 3000 }).then(() => true, () => false), '«Создать аккаунт» открывает регистрацию (повтор пароля и согласие)');
    check(errs.length === 0, errLine(errs));
    await ctx.close();
  }

  {
    console.log('· профиль на телефоне: «+» на виду, всё — с клавиатуры');
    const { page, ctx, errs } = await openPage(b);
    await login(page, 'testplayer');
    await page.evaluate(() => openProfileCard());
    await page.waitForSelector('#modal .pc-presets');
    check(await page.evaluate(() => { const box = document.querySelector('#modal .pc-presets').getBoundingClientRect(), m = document.querySelector('#modal .pc-preset.more').getBoundingClientRect(); return m.width > 30 && m.left >= box.left && m.right <= box.right + 0.5; }), '«+ Свои цвета» целиком в карточке');
    check(await page.evaluate(() => document.querySelectorAll('#modal .pc-presets button, #modal .prof-swatches button').length === PROFILE_PRESETS.length + 1 + PROFILE_COLORS.length + INK_COLORS.length), 'пресеты, «+» и свотчи — кнопки');
    await page.click('#pcAdaptRow >> text=Адаптировать под сеттинг');
    check(await page.evaluate(() => PROF_TMP.adapt === true && document.getElementById('pcAdaptRow').getAttribute('aria-checked') === 'true' && document.getElementById('pcManual').inert), 'клик по подписи «Адаптировать под сеттинг» включает её (ручной подбор — мимо клавиатуры)');
    await page.focus('#pcAdaptRow'); await page.keyboard.press('Enter');
    check(await page.evaluate(() => PROF_TMP.adapt === false && !document.getElementById('pcManual').inert), 'Enter по строке — выключает');
    await page.focus('#modal .pc-preset[data-bg]'); await page.keyboard.press('Space');
    check(await page.evaluate(() => { const p = document.querySelector('#modal .pc-preset[data-bg]'); return PROF_TMP.bg === p.dataset.bg && p.getAttribute('aria-pressed') === 'true'; }), 'пресет выбирается с клавиатуры');
    await page.focus('#modal .pc-preset.more'); await page.keyboard.press('Enter');
    check(await page.evaluate(() => !document.getElementById('pcCustom').hidden && document.querySelector('.pc-preset.more').getAttribute('aria-expanded') === 'true'), '«+» с клавиатуры раскрывает свои цвета');
    check(errs.length === 0, errLine(errs));
    await ctx.close();
  }

  {
    console.log('· копия не возвращает в реестр логинов удалённых и старые хэши');
    const { page, ctx } = await openPage(b);
    await login(page, 'hinoma');
    await hookToasts(page);
    await page.evaluate(() => { const f = new File([JSON.stringify({ format: 'comik-backup', version: 1, users: [{ tag: 'gone_old', createdAt: 1 }, { tag: '@Legacy_Guy', passHash: 'x', salt: 'y' }] })], 'b.json'); restoreBackup({ files: [f], value: '' }); });
    check(await sawToast(page, /Копия восстановлена/, 30000), 'копия восстановлена');
    const u = (await rows())['comik:users:v1'] || [];
    check(!u.some(x => /gone_old|legacy_guy/i.test(x.tag) || x.passHash || x.salt), 'в реестре нет ни логинов из копии, ни хэшей');
    await ctx.close();
  }

  {
    console.log('· команда');
    const { page, ctx, errs } = await openPage(b);
    await login(page, 'hinoma');
    await page.evaluate(() => openProfileCard());
    const v = await page.evaluate(() => apiVersion());
    await page.waitForTimeout(300);
    check(v === 4 && !(await delShown(page)), `облако API ${v}, а «Удалить аккаунт» у команды нет`);
    await page.evaluate(() => { closeModal(); go('settings'); });
    await page.waitForTimeout(300);
    check(await page.evaluate(() => /Режим Game Master/.test(document.getElementById('settingsPage').textContent)), 'командные пункты настроек на месте');
    check(errs.length === 0, errLine(errs));
    await ctx.close();
  }

  {
    console.log('· облако без API 4');
    await mock('/__mock/fail', 'POST', { v4: false });
    const { page, ctx, errs } = await openPage(b);
    await login(page, 'testplayer');
    await page.evaluate(() => openProfileCard());
    const v = await page.evaluate(() => apiVersion());
    await page.waitForTimeout(300);
    check(v === 3 && !(await delShown(page)), `облако API ${v} — кнопки удаления нет`);
    check(await page.evaluate(() => pushKey()) === 'push:sub:testplayer', 'пуш-подписки — по-прежнему в своей строке');
    check(errs.length === 0, errLine(errs));
    await ctx.close();
    await mock('/__mock/fail', 'POST', {});
  }

  {
    console.log('· новый игрок (телефон): смена пароля и удаление аккаунта');
    const tag = 'gone_' + Date.now().toString(36), P1 = 'firstpass1', P2 = 'secondpass2';
    const { page, ctx, errs } = await openPage(b);
    await hookToasts(page);
    await register(page, tag, P1);
    await page.waitForFunction(t => currentTag() === t, tag, { timeout: 15000 });
    await page.waitForTimeout(800);
    check((((await rows())['comik:users:v1']) || []).some(u => u.tag === tag), 'зарегистрировался, логин в реестре');

    // смена пароля
    await page.evaluate(() => openProfileCard());
    await page.click('#modal .pc-acts .set-row:has-text("Сменить пароль")');
    await page.waitForSelector('#modal2 #pw-cur', { timeout: 3000 });
    await page.fill('#pw-cur', P1); await page.fill('#pw-new', P2); await page.fill('#pw-new2', P2 + 'x');
    await page.click('#pwGo');
    check(await page.evaluate(() => document.getElementById('pw-f-new2').classList.contains('invalid')), 'несовпадающий повтор — подсвечен');
    await page.fill('#pw-cur', 'wrongpass1'); await page.fill('#pw-new2', P2);
    await page.click('#pwGo');
    check(await page.waitForFunction(() => document.getElementById('pw-f-cur').classList.contains('invalid'), null, { timeout: 8000 }).then(() => true, () => false), 'неверный текущий пароль — подсвечен');
    await page.fill('#pw-cur', P1);
    await page.click('#pwGo');
    check(await sawToast(page, /Пароль изменён/), 'пароль изменён');
    check(!(await page.evaluate(() => document.getElementById('scrim2').classList.contains('open'))), 'окно пароля закрылось');
    check(await authTok(tag, P2) === 200 && await authTok(tag, P1) === 400, 'вход — новым паролем, старый не подходит');

    // что у игрока есть: лист с портретом, закладка, пуш-подписка, профиль; запись на игру и карточка на доске — в облаке
    const pic = await page.evaluate(async t => {
      const c = document.createElement('canvas'); c.width = c.height = 4; const x = c.getContext('2d');
      x.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); x.fillRect(0, 0, 4, 4);
      const now = Date.now();
      CHARS_ALL.classic.push({ id: 'acc' + now.toString(36), owner: t, name: 'Уходящий', ava: c.toDataURL('image/png'), level: 1, createdAt: now, updatedAt: now });
      await persistChars();
      const a = (CHARS_ALL.classic.find(z => z && z.owner === t) || {}).ava || '';
      toggleBookmark(ARCHIVE.find(z => z && !z.deleted).id);
      await pushSaveSub({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + t, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPk', auth: 'aa' } }; } });
      profSet(SESSION, { name: 'Уходящий' });
      localStorage.setItem('comik:games:dirty', '1'); localStorage.setItem('comik:push:want', '1'); sessionStorage.setItem('comik:openChar', 'x');
      return a.startsWith('kvimg:') ? a.slice(6) : '';
    }, tag);
    await page.waitForTimeout(1500);
    let r = await rows();
    check(!!pic && !!r['comik:img:' + pic] && !!r['comik:chars:' + tag] && !!r['comik:bm:' + tag] && !!r['push:sub:' + tag], 'в облаке: лист, портрет, закладки, пуш-подписка');
    const now = Date.now();
    r['comik:games:v1'] = (r['comik:games:v1'] || []).concat([{ id: 'gacc', game: 'classic', title: 'Проверка', seats: 4, createdAt: now, updatedAt: now,
      players: [{ tag, name: 'Уходящий', at: now - 1000 }, { tag: 'testplayer', name: 'Тест', at: now - 900 }] }]);
    const brd = r['comik:tracker:shared:v1'] || {};
    const rev0 = +brd.rev || 0;
    brd['classic::hinoma'] = Object.assign({}, brd['classic::hinoma'], { list: [{ charId: 'x1', name: 'Уходящий', hp: 9, ownTag: tag }, { charId: 'x2', name: 'Тест', hp: 9, ownTag: 'testplayer' }] });
    r['comik:tracker:shared:v1'] = brd;
    await mock('/__mock/rows', 'POST', Object.entries(r).map(([key, value]) => ({ key, value })));

    // окно удаления: кнопка — только при совпавшем логине и пароле от 8 символов
    await page.evaluate(() => openProfileCard());
    await page.waitForFunction(() => { const d = document.getElementById('pcDel'); return d && !d.hidden; }, null, { timeout: 8000 });
    await page.click('#pcDel .set-row');
    await page.waitForSelector('#modal2 #ad-tag', { timeout: 3000 });
    check(/карточка на доске ходов мастера — без портрета/.test(await page.textContent('#modal2 .ad-what')), 'окно удаления честно говорит, что остаётся (карточка на доске ходов)');
    const dis = () => page.evaluate(() => document.getElementById('adGo').disabled);
    const d0 = await dis();
    await page.fill('#ad-tag', 'testplayer'); await page.fill('#ad-pass', P2);
    const d1 = await dis();
    await page.fill('#ad-tag', tag.toUpperCase()); await page.fill('#ad-pass', 'short');
    const d2 = await dis();
    await page.fill('#ad-pass', P2);
    check(d0 && d1 && d2 && !(await dis()), '«Удалить навсегда» активна только при своём логине и пароле от 8 символов');

    // отказы: человеческие слова, ничего не удалено, листы после них снова пишутся
    const fails = [
      [route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'komik:reauth введите пароль ещё раз' }) }), /^Неверный пароль$/, 'отказ komik:reauth'],
      [route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'komik:team аккаунт команды' }) }), /^Аккаунт команды так удалить нельзя$/, 'отказ komik:team'],
      [route => route.abort(), /^Облако не отвечает/, 'обрыв связи'],
    ];
    for (const [fn, re, name] of fails) {
      await page.route('**/rest/v1/rpc/komik_delete_me', fn);
      await page.evaluate(() => { window.__t = []; });
      await page.click('#adGo');
      check(await sawToast(page, re), `${name} → «${(await toastsNow(page)) || '—'}»`);
      await page.unroute('**/rest/v1/rpc/komik_delete_me');
    }
    await page.evaluate(() => { window.__t = []; });
    await page.fill('#ad-pass', 'wrongpass1');
    await page.click('#adGo');
    check(await sawToast(page, /^Неверный пароль$/) && await page.evaluate(() => document.getElementById('ad-f-pass').classList.contains('invalid')), 'неверный пароль → «Неверный пароль», поле подсвечено');
    const lvl = await page.evaluate(async t => { const c = CHARS_ALL.classic.find(z => z && z.owner === t); c.level = 2; c.updatedAt = Date.now(); return persistChars(); }, tag);
    r = await rows();
    check(lvl === true && (r['comik:chars:' + tag].classic || []).some(c => c.level === 2) && !!r['comik:bm:' + tag], 'после отказов всё на месте, лист снова пишется');

    // удаление
    const tok = await page.evaluate(() => { const k = Object.keys(localStorage).find(x => /^sb-.*-auth-token$/.test(x)); return k ? JSON.parse(localStorage.getItem(k)).access_token : ''; });
    await page.fill('#ad-pass', P2);
    await page.evaluate(() => { window.__t = []; });
    await page.click('#adGo');
    check(await sawToast(page, /^Аккаунт удалён$/), 'тост «Аккаунт удалён»' + (await toastsNow(page) ? ` (${await toastsNow(page)})` : ''));
    await page.waitForTimeout(300);
    check(!/Сессия завершена/.test(await toastsNow(page)), 'свой выход после удаления — не «потеря сессии»');
    r = await rows();
    check(!r['comik:chars:' + tag] && !r['comik:bm:' + tag] && !r['push:sub:' + tag] && !r['comik:img:' + pic], 'в облаке нет листа, портрета, закладок, пуш-подписки');
    check(!(r['comik:users:v1'] || []).some(u => u.tag === tag), 'логина нет в реестре');
    const g = (r['comik:games:v1'] || []).find(x => x.id === 'gacc') || {};
    check(!(g.players || []).some(p => p.tag === tag) && (g.players || []).some(p => p.tag === 'testplayer') && (g.gone || {})[tag] > now, 'запись на игру снята (gone), чужая осталась');
    const bl = ((r['comik:tracker:shared:v1'] || {})['classic::hinoma'] || {}).list || [];
    check(!bl.some(c => c.ownTag === tag) && bl.some(c => c.ownTag === 'testplayer') && +r['comik:tracker:shared:v1'].rev === rev0 + 1, 'на доске тег снят, rev вырос');

    const dev = await page.evaluate(t => {
      const ls = Object.keys(localStorage), lc = JSON.parse(localStorage.getItem('comik:chars:v1') || 'null') || {};
      return {
        tag: currentTag(), ava: document.getElementById('drAva').textContent, open: document.getElementById('scrim').classList.contains('open') || document.getElementById('scrim2').classList.contains('open'),
        left: ls.filter(k => k === 'comik:session:v1' || k === 'comik:games:dirty' || /^comik:(bmarks|push):/.test(k) || /^sb-.*-auth-token$/.test(k) || k.endsWith(':' + t)),
        prof: t in (JSON.parse(localStorage.getItem('comik:profiles') || '{}') || {}),
        legacy: Object.values(lc).flat().some(c => c && c.owner === t),
        mem: Object.values(CHARS_ALL).flat().some(c => c && c.owner === t) || BMARKS.length > 0,
        open2: sessionStorage.getItem('comik:openChar'),
      };
    }, tag);
    check(dev.tag === null && dev.ava === '?' && !dev.open, 'вышел, окна закрыты');
    check(!dev.left.length && !dev.prof && !dev.legacy && !dev.mem && dev.open2 === null, 'устройство вычищено' + (dev.left.length ? ': ' + dev.left.join(', ') : ''));

    const w = await fetch(BASE + '/rest/v1/kv', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'anon', Authorization: 'Bearer ' + tok, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key: 'comik:bm:' + tag, value: [] }) });
    check(w.status === 403 && !(await rows())['comik:bm:' + tag], `старый токен записать не может (${w.status})`);
    check(await authTok(tag, P2) === 400, 'вход тем же паролем не проходит');
    await page.evaluate(() => { window.__t = []; });
    await page.evaluate(() => openAuth('login'));
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'au-tag', null, { timeout: 5000 });
    await page.fill('#au-tag', tag); await page.fill('#au-pass', P2);
    await page.evaluate(() => doLogin());
    check(await sawToast(page, /Неверный логин или пароль/) && await page.evaluate(() => currentTag() === null), 'и на сайте вход не проходит');
    await page.evaluate(() => { window.__t = []; });
    await register(page, tag, P2);
    check(await sawToast(page, /Этот логин сейчас недоступен/) && await page.evaluate(() => currentTag() === null), 'зарегистрировать логин заново нельзя');
    const e = realErrs(errs);
    check(e.length === 0, errLine(e));
    await ctx.close();
  }

  {
    console.log('· удаление: ответ потерялся; тот же аккаунт на другом устройстве');
    const tag = 'lost_' + Date.now().toString(36), P = 'lostpass12';
    const A = await openPage(b), B = await openPage(b, { viewport: DESK }), C = await openPage(b);
    await hookToasts(A.page);
    await register(A.page, tag, P);
    await A.page.waitForFunction(t => currentTag() === t, tag, { timeout: 15000 });
    await login(B.page, tag, P);
    await hookToasts(B.page);
    await login(C.page, tag, P);
    await hookToasts(C.page);
    // сервер аккаунт удалил, а ответ до сайта не дошёл
    await A.page.route('**/rest/v1/rpc/komik_delete_me', async route => { await route.fetch(); await route.abort(); });
    await A.page.evaluate(() => openProfileCard());
    await A.page.waitForFunction(() => { const d = document.getElementById('pcDel'); return d && !d.hidden; }, null, { timeout: 8000 });
    await A.page.click('#pcDel .set-row');
    await A.page.waitForSelector('#modal2 #ad-tag', { timeout: 3000 });
    await A.page.fill('#ad-tag', tag); await A.page.fill('#ad-pass', P);
    await A.page.evaluate(() => { window.__t = []; });
    await A.page.click('#adGo');
    check(await sawToast(A.page, /^Аккаунт удалён$/) && !/Облако не отвечает|Неверный пароль/.test(await toastsNow(A.page)), `ответ потерялся, а сайт всё равно понял: «Аккаунт удалён» (${await toastsNow(A.page)})`);
    check(await A.page.evaluate(() => currentTag() === null && !document.getElementById('scrim2').classList.contains('open') && !Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k))), 'устройство вычищено, окно закрыто');
    // другое устройство: токен ещё жив, первая же запись в облако (закладка) получает komik:gone
    await B.page.evaluate(() => { window.__t = []; toggleBookmark(ARCHIVE.find(z => z && !z.deleted).id); });
    check(await B.page.waitForFunction(() => currentTag() === null, null, { timeout: 10000 }).then(() => true, () => false) && await sawToast(B.page, /^Аккаунт удалён$/),
      `другое устройство: запись отбита — вышел, «Аккаунт удалён» (${await toastsNow(B.page)})`);
    const left = await B.page.evaluate(t => Object.keys(localStorage).filter(k => k === 'comik:session:v1' ? localStorage.getItem(k) !== 'null' : (k.endsWith(':' + t) || /^sb-.*-auth-token$/.test(k))), tag);
    check(!/Нет прав/.test(await toastsNow(B.page)) && !left.length, 'без «Нет прав на запись», и там устройство вычищено' + (left.length ? ': ' + left.join(', ') : ''));
    // третье устройство: первая запись — запись на игру (у неё свой тост об отказе)
    await C.page.evaluate(t => { window.__t = []; const now = Date.now(); GAMES.push({ id: 'glost', game: CUR_PROJECT, title: 'Проверка', seats: 4, players: [{ tag: t, name: 'Ушедший', at: now, upd: now }], createdAt: now, updatedAt: now }); persistGamesOnce(); }, tag);
    check(await C.page.waitForFunction(() => currentTag() === null, null, { timeout: 10000 }).then(() => true, () => false) && await sawToast(C.page, /^Аккаунт удалён$/) && !/Нет прав/.test(await toastsNow(C.page)),
      `запись на игру отбита — вышел, «Аккаунт удалён» без «Нет прав» (${await toastsNow(C.page)})`);
    const e = realErrs(A.errs.concat(B.errs, C.errs));
    check(e.length === 0, errLine(e));
    await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
  }

  await mock('/__mock/rows', 'POST', seed);
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
