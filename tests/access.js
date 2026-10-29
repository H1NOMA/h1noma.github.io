/* Права облака 10-29 со стороны сайта: чужие листы — из витрины kv_chars_pub (без биографии и заметок), свои —
   целиком и уезжают в облако целиком; команда читает kv и витрину не спрашивает; пуш-подписки — в своей строке
   push:sub:<тег>, а с облаком без миграции 10-29 — по-старому в push:subs; картинки только свои.
   node tests/access.js */
const { launch, openPage, login, mock, rows, check, done } = require('./lib');

const SECRET = ['bio', 'notes', 'inv', 'gear', 'history', 'abil', 'coins', 'ledger', 'codeHash'];
const sub = ep => `({ endpoint: '${ep}', toJSON(){ return { endpoint: this.endpoint, keys: { p256dh: 'BPk', auth: 'aa' } }; } })`;

(async () => {
  const b = await launch();
  const seed = await mock('/__mock/rows');
  const now = Date.now();
  const own = { at: now, classic: [{ id: 'tpc1', owner: 'testplayer', name: 'Тестовый', bio: 'тайная биография', level: 2, createdAt: now, updatedAt: now }] };
  await mock('/__mock/rows', 'POST', seed.filter(r => r.key !== 'comik:chars:testplayer').concat([{ key: 'comik:chars:testplayer', value: own }]));
  await mock('/__mock/fail', 'POST', { v3: true });
  const pubHits = async () => (await mock('/__mock/log')).filter(x => x.path === '/rest/v1/kv_chars_pub').length;
  const others = p => p.evaluate(secret => {
    const all = Object.values(CHARS_ALL).flat().filter(c => c && !c.deleted && c.owner && c.owner !== currentTag());
    return { n: all.length, leaked: [...new Set(all.flatMap(c => Object.keys(c).filter(k => secret.includes(k))))] };
  }, SECRET);

  {
    console.log('· гость');
    await mock('/__mock/log', 'DELETE');
    const { page, ctx, errs } = await openPage(b);
    await page.waitForTimeout(800);
    const o = await others(page);
    check(o.n > 5 && !o.leaked.length, `чужие листы есть (${o.n}), без закрытых полей${o.leaked.length ? ': ' + o.leaked.join(',') : ''}`);
    check(await pubHits() > 0, 'спросил витрину');
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  {
    console.log('· игрок');
    const ext = [];
    const { page, ctx, errs } = await openPage(b);
    page.on('request', r => { const h = new URL(r.url()).hostname; if (h !== '127.0.0.1') ext.push(r.url()); });
    await login(page, 'testplayer');
    // после входа «свои» поменялись — строки перечитываются ближайшим тиком (afterAuthChange)
    await page.waitForFunction(() => { const c = (CHARS_ALL.classic || []).find(x => x && x.id === 'tpc1'); return c && !c._pub; }, null, { timeout: 8000 }).catch(() => {});
    const mine = await page.evaluate(() => { const c = (CHARS_ALL.classic || []).find(x => x && x.id === 'tpc1'); return c && c.bio; });
    check(mine === 'тайная биография', 'свой лист — целиком (с биографией)');
    const o = await others(page);
    check(o.n > 5 && !o.leaked.length, `чужие листы есть (${o.n}), без закрытых полей${o.leaked.length ? ': ' + o.leaked.join(',') : ''}`);
    await page.evaluate(() => { const c = CHARS_ALL.classic.find(x => x.id === 'tpc1'); c.level = 3; c.updatedAt = Date.now(); return persistChars(); });
    let r = await rows();
    const saved = r['comik:chars:testplayer'], list = Object.values(saved).filter(Array.isArray).flat();
    check(list.length === 1 && list[0].bio === 'тайная биография' && list[0].level === 3, `сохранил свой лист целиком и только его (${list.length} шт.)`);

    // фоновый тик: зонд видит смену чужой строки через витрину и перечитывает её
    const hin = r['comik:chars:hinoma'], c0 = hin.classic.find(c => c && !c.deleted);
    c0.name = 'Переименован'; c0.updatedAt = Date.now() + 1000; hin.at = Date.now() + 1000;
    await mock('/__mock/rows', 'POST', Object.entries(r).map(([key, value]) => ({ key, value })));
    const got = await page.evaluate(async () => { const m = await fetchCloudCharsChanged(); return m ? Object.values(m).flat().map(c => c.name) : null; });
    check(got && got.includes('Переименован'), `фоновый тик подхватил чужую правку из витрины (${got ? got.length : 'null'} листов)`);

    // пуш-подписка — в своей строке
    const before = JSON.stringify(r['push:subs'] || null);
    check(await page.evaluate(`pushSaveSub(${sub('https://fcm.googleapis.com/fcm/send/t1')})`), 'подписка сохранилась');
    r = await rows();
    check((r['push:sub:testplayer'] || []).some(x => x.endpoint === 'https://fcm.googleapis.com/fcm/send/t1' && x.tag === 'testplayer'), 'она в push:sub:testplayer');
    check(JSON.stringify(r['push:subs'] || null) === before, 'общая push:subs не тронута');
    await page.evaluate(`pushRemoveSub(${sub('https://fcm.googleapis.com/fcm/send/t1')})`);
    r = await rows();
    check(!(r['push:sub:testplayer'] || []).some(x => x.endpoint.endsWith('/t1')), 'отписка убрала её');

    // картинки — только свои
    const img = await page.evaluate(() => ({
      tag: imgTag('https://evil.example/x.png'), own: imgTag('img/content/a.png'),
      html: sanitizeHTML('<p><img src="https://evil.example/a.png"><img src="img/x.png"><span style="background:url(https://evil.example/b.png)">т</span></p>'),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    }));
    check(!/evil/.test(img.tag) && /src="img\/content\/a.png"/.test(img.own), 'imgTag: чужой адрес без src, свой файл — с src');
    check(!/evil/.test(img.html) && /src="img\/x.png"/.test(img.html), 'санитайзер: чужие картинки и url() вырезаны, свои на месте');
    check(/img-src 'self' data: blob:;/.test(img.csp) && !/img-src[^;]*https:/.test(img.csp) && !/media-src[^;]*https:/.test(img.csp), 'CSP: картинки и звук только свои');
    check(ext.length === 0, 'запросов на чужие адреса нет' + (ext.length ? ': ' + ext.slice(0, 3).join(' ') : ''));
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  {
    console.log('· команда');
    const { page, ctx, errs } = await openPage(b);
    await login(page, 'hinoma');
    await page.waitForFunction(() => !Object.values(CHARS_ALL).flat().some(c => c && c._pub), null, { timeout: 8000 }).catch(() => {});
    await mock('/__mock/log', 'DELETE');
    const res = await page.evaluate(async () => { await fetchCloudChars(); await fetchCloudCharsChanged(); await persistChars();
      const c = Object.values(CHARS_ALL).flat().find(x => x && x.id === 'tpc1'); return c && c.bio; });
    check(res === 'тайная биография', 'видит чужой лист целиком');
    check(await pubHits() === 0, 'витрину не спрашивает');
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  if ((await mock('/__mock/fail', 'POST', { v3: true })).pg) console.log('· облако без миграции 10-29 — пропущено: стенд на настоящей базе (она с 10-29)');
  else {
    console.log('· облако без миграции 10-29');
    await mock('/__mock/fail', 'POST', { v3: false });
    await mock('/__mock/log', 'DELETE');
    const { page, ctx, errs } = await openPage(b);
    await login(page, 'testplayer');
    await page.waitForTimeout(500);
    const res = await page.evaluate(secret => Object.values(CHARS_ALL).flat().some(x => x && x.owner === 'hinoma' && !x.deleted && Object.keys(x).some(k => secret.includes(k))), SECRET);
    check(res, 'чужие листы — как раньше, из kv');
    check(await pubHits() === 0, 'витрину не спрашивает');
    check(await page.evaluate(`pushSaveSub(${sub('https://fcm.googleapis.com/fcm/send/t2')})`), 'подписка сохранилась');
    const r = await rows();
    check((r['push:subs'] || []).some(x => x.endpoint.endsWith('/t2')) && !r['push:sub:testplayer']?.some(x => x.endpoint.endsWith('/t2')), 'она в общей push:subs');
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
    await mock('/__mock/fail', 'POST', { v3: true });
  }

  await mock('/__mock/rows', 'POST', seed);
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
