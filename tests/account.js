/* Аккаунт (v300): закладки, уведомления, смена пароля и логина, выход — в карточке профиля, а не в «Настройках»;
   игрок сам удаляет аккаунт (облако API 4, komik_delete_me): у команды и на облаке без API 4 кнопки нет; после
   удаления строк игрока в облаке нет, войти тем же паролем нельзя, старый токен ничего не пишет, логин занят,
   устройство вычищено. Ошибки удаления (пароль, команда, сеть) — человеческими словами, листы после них пишутся.
   node tests/account.js */
const { launch, openPage, login, mock, rows, check, done, BASE, DESK } = require('./lib');

// тосты — в журнал страницы: часть из них живёт 2.6 с, и между шагами их не поймать по экрану
const hookToasts = page => page.evaluate(() => { window.__t = []; const t = window.toast; window.toast = function (m) { window.__t.push(String(m)); return t.apply(this, arguments); }; });
const sawToast = (page, re, ms = 15000) => page.waitForFunction(src => (window.__t || []).some(m => new RegExp(src).test(m)), re.source, { timeout: ms }).then(() => true, () => false);
const toastsNow = page => page.evaluate(() => (window.__t || []).join(' | '));
const delShown = page => page.evaluate(() => { const d = document.getElementById('pcDel'); return !!d && !d.hidden; });
// ответы 4xx/5xx, которые проверка вызывает сама (неверный пароль, отказ сервера), браузер пишет в консоль — это не ошибки сайта
const realErrs = errs => errs.filter(e => !/Failed to load resource: the server responded with a status of (400|401|403|422|500)/.test(e));
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
    await page.click('#modal .pc-acts .set-row:has-text("Выйти")');
    await page.waitForFunction(() => currentTag() === null, null, { timeout: 8000 }).catch(() => {});
    check(await page.evaluate(() => currentTag() === null && !document.getElementById('scrim').classList.contains('open')), '«Выйти» из профиля — выход, окно закрыто');
    check(errs.length === 0, errLine(errs));
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
    brd['classic::hinoma'] = Object.assign({}, brd['classic::hinoma'], { list: [{ charId: 'x1', name: 'Уходящий', hp: 9, ownTag: tag, ava: 'kvimg:' + pic }, { charId: 'x2', name: 'Тест', hp: 9, ownTag: 'testplayer' }] });
    r['comik:tracker:shared:v1'] = brd;
    await mock('/__mock/rows', 'POST', Object.entries(r).map(([key, value]) => ({ key, value })));

    // окно удаления: кнопка — только при совпавшем логине и пароле от 8 символов
    await page.evaluate(() => openProfileCard());
    await page.waitForFunction(() => { const d = document.getElementById('pcDel'); return d && !d.hidden; }, null, { timeout: 8000 });
    await page.click('#pcDel .set-row');
    await page.waitForSelector('#modal2 #ad-tag', { timeout: 3000 });
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
    r = await rows();
    check(!r['comik:chars:' + tag] && !r['comik:bm:' + tag] && !r['push:sub:' + tag] && !r['comik:img:' + pic], 'в облаке нет листа, портрета, закладок, пуш-подписки');
    check(!(r['comik:users:v1'] || []).some(u => u.tag === tag), 'логина нет в реестре');
    const g = (r['comik:games:v1'] || []).find(x => x.id === 'gacc') || {};
    check(!(g.players || []).some(p => p.tag === tag) && (g.players || []).some(p => p.tag === 'testplayer') && (g.gone || {})[tag] > now, 'запись на игру снята (gone), чужая осталась');
    const bl = ((r['comik:tracker:shared:v1'] || {})['classic::hinoma'] || {}).list || [];
    check(bl.some(c => c.charId === 'x1' && c.ownTag === '-' && !('ava' in c)) && bl.some(c => c.ownTag === 'testplayer') && +r['comik:tracker:shared:v1'].rev === rev0 + 1,
      'на доске его карточка ничья («-») и без портрета, rev вырос');

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

  await mock('/__mock/rows', 'POST', seed);
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
