/* Фото отдельными строками comik:img:<хэш>: перенос, ленивая загрузка, кэш, права, копии.
   Стенд должен быть запущен с данными, где фото ещё внутри строк (например, снапшот из ветки backups):
     python3 tests/mock_cloud.py --seed kv-ДАТА.json.gz &   node tests/images.js */
const fs = require('fs'), crypto = require('crypto'), zlib = require('zlib');
const { launch, openPage, login, mock, rows, check, done, PHONE, DESK } = require('./lib');
const INLINE = /"data:image\//;
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
const imgRows = r => Object.keys(r).filter(k => k.startsWith('comik:img:'));
const sizeOf = v => Buffer.byteLength(JSON.stringify(v));

/* zip без сжатия (как его собирает exportSite) → {имя: Buffer} */
function unzipStore(buf) {
  const out = {}; let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const n = buf.readUInt32LE(p + 18), nl = buf.readUInt16LE(p + 26), xl = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nl).toString('utf8'); const s = p + 30 + nl + xl;
    out[name] = buf.slice(s, s + n); p = s + n;
  }
  return out;
}

(async () => {
  const seed = await mock('/__mock/rows');
  const before = Object.fromEntries(seed.map(r => [r.key, r.value]));
  check(INLINE.test(JSON.stringify(before['comik:archive:v1'])), 'в исходных данных фото архива лежат внутри строки');
  const b = await launch();

  console.log('· команда (hinoma): перенос фото архива, новостей и своих портретов');
  {
    const { ctx, page, errs } = await openPage(b, { viewport: DESK });
    await login(page, 'hinoma');
    await page.evaluate(() => imgMigrateSoon(10));
    let r;
    for (let i = 0; i < 120; i++) {   // перенос идёт в фоне: ждём, пока в облаке не останется фото внутри строк
      r = await rows();
      if (!INLINE.test(JSON.stringify([r['comik:archive:v1'], r['comik:news:v1'], r['comik:chars:hinoma']]))) break;
      await page.waitForTimeout(1000);
    }
    check(!INLINE.test(JSON.stringify(r['comik:archive:v1'])), `архив без фото внутри: ${(sizeOf(before['comik:archive:v1']) / 1e6).toFixed(2)} МБ → ${(sizeOf(r['comik:archive:v1']) / 1e3).toFixed(0)} КБ`);
    check(!INLINE.test(JSON.stringify(r['comik:news:v1'])), `новости без фото внутри: ${(sizeOf(r['comik:news:v1']) / 1e3).toFixed(1)} КБ`);
    check(!INLINE.test(JSON.stringify(r['comik:chars:hinoma'])), `листы hinoma без портретов внутри: ${(sizeOf(r['comik:chars:hinoma']) / 1e3).toFixed(0)} КБ`);
    const chars = k => Object.keys(k).filter(x => x.startsWith('comik:chars:'));
    const cb = chars(before).reduce((s, k) => s + sizeOf(before[k]), 0), ca = chars(r).reduce((s, k) => s + sizeOf(r[k]), 0);
    check(chars(r).every(k => !INLINE.test(JSON.stringify(r[k]))), `листы всех игроков без портретов внутри: ${(cb / 1e6).toFixed(2)} МБ → ${(ca / 1e3).toFixed(0)} КБ`);
    // чужие строки команда переписывает условной записью: меняются только портреты (свою hinoma пишет обычным сохранением)
    check(chars(r).filter(k => k !== 'comik:chars:hinoma').every(k => JSON.stringify(r[k]).replace(/kvimg:[0-9a-f]{32}/g, '') === JSON.stringify(before[k]).replace(/data:image\/[^"]+/g, '')), 'в чужих строках листов изменились только портреты (штампы, имена, поля — те же)');
    const live = v => Object.values(v || {}).filter(Array.isArray).flat().filter(c => c && !c.deleted).map(c => c.id + ':' + (c.updatedAt || 0)).sort().join(',');
    check(live(r['comik:chars:hinoma']) === live(before['comik:chars:hinoma']), 'свои листы hinoma те же (id и время правки)');
    const ir = imgRows(r);
    check(ir.length > 0 && ir.every(k => k === 'comik:img:' + sha(r[k])), `строки фото: ${ir.length}, у всех ключ = хэш содержимого`);
    // карточки те же: id, заголовки, updatedAt не изменились
    // (надгробия старше 90 дней клиент вычищает при любой записи архива — их не считаем)
    const old = x => x.deleted && Date.now() - (x.updatedAt || 0) > 90 * 864e5;
    const ids = o => Object.values(o).flat().filter(x => x && x.id && !old(x)).map(x => x.id + ':' + (x.updatedAt || 0) + ':' + (x.title || '')).sort().join('|');
    check(ids(r['comik:archive:v1']) === ids(before['comik:archive:v1']), 'карточки архива те же (id, заголовок, время правки)');
    // каждая ссылка ведёт на существующую строку
    const refs = JSON.stringify([r['comik:archive:v1'], r['comik:news:v1'], r['comik:chars:hinoma']]).match(/kvimg:[0-9a-f]{32}/g) || [];
    check(refs.length && refs.every(x => r['comik:img:' + x.slice(6)]), `ссылок kvimg: ${refs.length}, все ведут на строки фото`);
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  console.log('· гость: фото грузятся, когда попали на экран, второй заход — с устройства');
  {
    const { ctx, page, errs } = await openPage(b, { viewport: PHONE, project: 'legacy' });
    await mock('/__mock/log', 'DELETE');
    await page.evaluate(() => { setProject('legacy'); go('world'); });
    await page.waitForTimeout(500);
    const card = await page.evaluate(() => { const c = ARCHIVE.find(x => x && /^kvimg:/.test(x.img || '')); if (!c) return null; openModal(c.id); return c.id; });
    check(!!card, 'в LEGACY есть карточка с фото по ссылке');
    await page.waitForFunction(() => { const i = document.querySelector('#modal .dos-img img'); return i && /^data:image\//.test(i.getAttribute('src') || ''); }, null, { timeout: 15000 }).catch(() => {});
    const shown = await page.evaluate(() => { const i = document.querySelector('#modal .dos-img img'); return i ? (i.getAttribute('src') || '').slice(0, 15) : 'нет'; });
    check(shown === 'data:image/jpeg' || shown.startsWith('data:image/'), 'фото в карточке появилось: ' + shown);
    const log = await mock('/__mock/log');
    const imgGets = log.filter(x => x.method === 'GET' && /comik:img:/.test(x.key));
    check(imgGets.length >= 1 && imgGets.length <= 3, `запросов фото на одну карточку: ${imgGets.length}`);
    await page.evaluate(() => closeModal());
    await mock('/__mock/log', 'DELETE');
    await page.reload(); await page.waitForFunction(() => SESSION_READY === true);
    await page.evaluate(id => { setProject('legacy'); go('world'); openModal(id); }, card);
    await page.waitForFunction(() => { const i = document.querySelector('#modal .dos-img img'); return i && /^data:image\//.test(i.getAttribute('src') || ''); }, null, { timeout: 10000 }).catch(() => {});
    const log2 = await mock('/__mock/log');
    const again = log2.filter(x => x.method === 'GET' && /comik:img:/.test(x.key)).length;
    const shown2 = await page.evaluate(() => !!(document.querySelector('#modal .dos-img img') || {}).src);
    check(shown2 && again === 0, `после перезагрузки фото с устройства, запросов в облако: ${again}`);
    const boot = log2.filter(x => x.method === 'GET').reduce((s, x) => s + x.bytes, 0);
    check(boot < 700000, `старт гостя качает из облака ${(boot / 1e6).toFixed(2)} МБ (было ≈ ${(sizeOf(before['comik:archive:v1']) / 1e6 + sizeOf(before['comik:news:v1']) / 1e6).toFixed(1)} МБ только архив+новости)`);
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  console.log('· игрок: портрет на сервере без миграции 10-28 остаётся внутри, после неё — уезжает');
  {
    const r0 = await rows();
    // своя, ещё не загруженная в облако картинка
    const tmpPg = await openPage(b, { viewport: PHONE });
    const pic = await tmpPg.page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 24; const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 24, 24); x.fillStyle = '#fff'; x.fillText(String(performance.now()), 2, 14); return c.toDataURL('image/png'); });
    await tmpPg.ctx.close();
    const sheet = { id: 'tpsheet1', owner: 'testplayer', name: 'Тестовый', level: '1', ava: pic, updatedAt: Date.now() - 1000 };
    const row = { at: Date.now() - 1000, classic: [sheet] };
    await mock('/__mock/rows', 'POST', Object.entries({ ...r0, 'comik:chars:testplayer': row }).map(([key, value]) => ({ key, value })));
    await mock('/__mock/fail', 'POST', { player_img: false });
    let { ctx, page, errs } = await openPage(b, { viewport: PHONE });
    await login(page, 'testplayer');
    await page.evaluate(() => imgMigrateSoon(10));
    await page.waitForTimeout(4000);
    let r = await rows();
    check(INLINE.test(JSON.stringify(r['comik:chars:testplayer'])), 'старый сервер: портрет игрока остался внутри листа (ничего не потеряно)');
    check(JSON.stringify(r['comik:chars:testplayer']) === JSON.stringify(row), 'старый сервер: строку игрока не переписывали');
    const toasts = await page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
    check(!/Нет прав/.test(toasts), 'без тоста «нет прав»');
    await ctx.close();
    await mock('/__mock/fail', 'POST', { player_img: true });
    ({ ctx, page, errs } = await openPage(b, { viewport: PHONE }));
    await login(page, 'testplayer');
    await page.evaluate(() => imgMigrateSoon(10));
    await page.waitForTimeout(4000);
    r = await rows();
    const sh = (r['comik:chars:testplayer'].classic || [])[0] || {};
    check(/^kvimg:/.test(sh.ava || ''), 'новый сервер: портрет игрока уехал в строку фото, в листе ссылка');
    check(sh.updatedAt === sheet.updatedAt && sh.name === sheet.name, 'лист тот же (время правки и имя не тронуты)');
    await page.evaluate(() => go('players'));
    await page.waitForTimeout(800);
    const pv = await page.evaluate(() => { const i = document.querySelector('.pt-ava img, .cs-ava img'); return i ? (i.getAttribute('src') || '').slice(0, 11) : 'нет'; });
    check(pv === 'data:image/', 'портрет в списке игрока показан: ' + pv);
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  console.log('· резервная копия и zip для репозитория забирают фото с собой');
  {
    const { ctx, page, errs } = await openPage(b, { viewport: DESK });
    await login(page, 'hinoma');
    await page.waitForTimeout(1500);
    let dl = page.waitForEvent('download');
    await page.evaluate(() => downloadBackup());
    const bk = JSON.parse(fs.readFileSync(await (await dl).path(), 'utf8'));
    const refs = (JSON.stringify([bk.chars, bk.archive, bk.news]).match(/kvimg:[0-9a-f]{32}/g) || []).map(x => x.slice(6));
    check(refs.length > 0 && refs.every(h => bk.images && typeof bk.images[h] === 'string' && sha(bk.images[h]) === h), `копия: ссылок ${refs.length}, все фото внутри копии (images: ${Object.keys(bk.images || {}).length})`);
    dl = page.waitForEvent('download');
    await page.evaluate(() => exportSite());
    const z = unzipStore(fs.readFileSync(await (await dl).path()));
    const arc = JSON.parse(z['data/archive.json'].toString('utf8'));
    const paths = Object.values(arc).flat().map(c => c && c.img).filter(Boolean);
    check(paths.length > 0 && paths.every(p => /^img\/content\/[a-z0-9-]+-[0-9a-f]{8}\.(jpg|png|webp|gif)$/.test(p) && z[p]), `zip: фото архива — файлами img/content (${paths.length}), все файлы в архиве`);
    check(!INLINE.test(z['data/news.json'].toString('utf8')) && !/kvimg:/.test(z['data/news.json'].toString('utf8')), 'zip: новости без base64 и без ссылок на облако');
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    // восстановление копии в пустое облако возвращает и фото
    await mock('/__mock/rows', 'POST', []);
    const p2 = await openPage(b, { viewport: DESK });
    await login(p2.page, 'hinoma');
    const tmp = '/tmp/komik-bk-test.json'; fs.writeFileSync(tmp, JSON.stringify(bk));
    await p2.page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'bkTest'; i.onchange = () => restoreBackup(i); document.body.appendChild(i); });
    await p2.page.setInputFiles('#bkTest', tmp);
    await p2.page.waitForTimeout(6000);
    const r = await rows();
    // фото карточек — либо файлы репозитория (img/content, они же лежат в data/archive.json), либо ссылки на строки облака
    const imgs = [].concat(...Object.values(r['comik:archive:v1'] || {}).filter(Array.isArray), r['comik:news:v1'] || [], ...Object.values(r['comik:chars:hinoma'] || {}).filter(Array.isArray))
      .map(x => x && (x.img || x.ava)).filter(Boolean);
    const okImg = v => (/^img\/content\//.test(v) && fs.existsSync(__dirname + '/../' + v)) || (/^kvimg:/.test(v) && r['comik:img:' + v.slice(6)]);
    check(imgs.length > 20 && imgs.every(okImg), `восстановление в пустое облако: фото ${imgs.length}, все на месте (файлы репозитория или строки облака)`);
    check(!INLINE.test(JSON.stringify([r['comik:archive:v1'], r['comik:news:v1'], r['comik:chars:hinoma']])), 'после восстановления фото не легли обратно внутрь строк');
    check(p2.errs.length === 0, 'ошибок в консоли нет' + (p2.errs.length ? '\n    ' + p2.errs.slice(0, 5).join('\n    ') : ''));
    await p2.ctx.close();
    await ctx.close();
  }
  await mock('/__mock/rows', 'POST', seed);
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
