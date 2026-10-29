/* Общие строки через НАСТОЯЩИЙ сервер (стенд --pg, триггер-страж миграции 10-29): игрок правит ХП своей карточки,
   но не чужой и не NPC ГМа; ГМ ставит на карточки тег владельца; двое записываются на последнее место — оба сайта
   приходят к одному ответу облака, без вечных повторов записи; старое надгробие в расписании записи не мешает.
   KOMIK_BASE=http://127.0.0.1:8766 node tests/shared.js   (стенд: tests/sql/stand.sh + mock_cloud.py --pg) */
const { launch, openPage, login, mock, rows, check, done } = require('./lib');

(async () => {
  if (!(await mock('/__mock/fail', 'POST', {})).pg) { console.log('пропущено: нужен стенд на настоящей базе (mock_cloud.py --pg, tests/README.md)'); return; }
  const b = await launch();
  const seed = await mock('/__mock/rows');
  const now = Date.now(), r0 = Object.fromEntries(seed.map(r => [r.key, r.value]));
  const npc = ((r0['comik:chars:hinoma'] || {}).classic || []).find(c => c && c.id && !c.deleted);
  const sheet = (id, owner, name) => ({ at: now, classic: [{ id, owner, name, hp: '12', level: 1, createdAt: now, updatedAt: now }] });
  const board = { active: true, owner: 'hinoma', party: '', round: 1, at: now, log: [], mapPos: {},
    list: [{ charId: 'tp1', name: 'Тест', hp: 12 }, { charId: 'p2c', name: 'Второй', hp: 10, ownTag: 'player_two' }, { charId: npc.id, name: 'NPC', hp: 20 }] };
  const rowsNow = Object.assign({}, r0, {
    'comik:chars:testplayer': sheet('tp1', 'testplayer', 'Тест'), 'comik:chars:player_two': sheet('p2c', 'player_two', 'Второй'),
    'comik:tracker:shared:v1': { rev: 1, at: now, 'classic::hinoma': board },
    'comik:games:v1': [{ id: 'gs1', game: 'classic', title: 'Гонка', seats: 1, players: [], createdAt: now - 5000, updatedAt: now - 5000 },
                       { id: 'gold', deleted: true, updatedAt: 1 }],
  });
  await mock('/__mock/rows', 'POST', Object.entries(rowsNow).map(([key, value]) => ({ key, value })));
  const card = async id => ((await rows())['comik:tracker:shared:v1']['classic::hinoma'].list || []).find(c => c.charId === id) || {};
  const page2 = async tag => { const o = await openPage(b, { storage: { 'comik:cookies:ok': '1' } }); await login(o.page, tag);
    await o.page.evaluate(async () => { setProject('classic'); await trkFetchShared(true); }); await o.page.waitForTimeout(500); return o; };

  console.log('· доска: своё — можно, чужое — нет');
  {
    const { page, ctx, errs } = await page2('testplayer');
    await page.evaluate(() => trkPlayerHpSet('tp1', 5));
    for (let i = 0; i < 20 && (await card('tp1')).hp !== 5; i++) await page.waitForTimeout(300);
    check((await card('tp1')).hp === 5, `свой персонаж: ХП 5 дошло до облака (${(await card('tp1')).hp})`);
    await page.evaluate(([n]) => { trkCloudCardPatch('classic::hinoma', 'c:' + n, { hp: 0 }); trkCloudCardPatch('classic::hinoma', 'c:p2c', { hp: 0 }); }, [npc.id]);
    await page.waitForTimeout(3000);
    check((await card(npc.id)).hp === 20 && (await card('p2c')).hp === 10, `NPC ГМа и чужой персонаж не тронуты (${(await card(npc.id)).hp}, ${(await card('p2c')).hp})`);
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }
  {
    const { page, ctx } = await page2('player_two');
    await page.evaluate(() => trkPlayerHpSet('p2c', 7));
    for (let i = 0; i < 20 && (await card('p2c')).hp !== 7; i++) await page.waitForTimeout(300);
    check((await card('p2c')).hp === 7, `владелец по тегу ГМа: ХП 7 дошло (${(await card('p2c')).hp})`);
    await ctx.close();
  }
  {
    const { page, ctx } = await page2('hinoma');
    const tags = await page.evaluate(([n]) => trkMergedList({}, [{ charId: 'tp1', name: 'Тест' }, { charId: 'p2c' }, { charId: n }, { name: 'Гоблин', foe: true, ownTag: 'x' }]).map(c => c.ownTag || '-').join(','), [npc.id]);
    check(tags === 'testplayer,player_two,hinoma,-', `ГМ при публикации ставит тег владельца листа (${tags})`);
    await ctx.close();
  }

  console.log('· расписание: двое на последнее место, старое надгробие');
  {
    const A = await page2('testplayer'), B = await page2('player_two');
    for (const p of [A.page, B.page]) await p.evaluate(() => { openSignupForm('gs1'); });
    await Promise.all([A.page.evaluate(() => doSignup('gs1')), B.page.evaluate(() => doSignup('gs1'))]);
    await A.page.waitForTimeout(2500);
    const cloud = (await rows())['comik:games:v1'];
    const gs = cloud.find(s => s.id === 'gs1' && !s.deleted), who = (gs.players || []).map(p => p.tag);
    check(who.length === 1, `в облаке ровно один записавшийся (${who.join(',')})`);
    check(!cloud.some(s => s.id === 'gold'), 'надгробие старше 90 дней ушло при записи игрока');
    for (const [n, o] of [['testplayer', A], ['player_two', B]]) {
      const st = await o.page.evaluate(() => ({ dirty: GAMES_DIRTY, who: ((GAMES.find(s => s.id === 'gs1') || {}).players || []).map(p => p.tag).join(','),
        toast: (document.getElementById('toast') || {}).textContent || '' }));
      check(!st.dirty && st.who === who.join(','), `${n}: сайт согласен с облаком (${st.who || 'никого'}), повторов записи нет`);
      if (!who.includes(n)) check(/Мест не осталось/.test(st.toast), `${n}: проигравшему сказано «Мест не осталось» (${st.toast.slice(0, 60)})`);
      await o.ctx.close();
    }
  }

  console.log('· расписание: записался без сети, открыл сайт — место уже занято');
  {
    const day = 864e5, t = Date.now();
    const gs3 = { id: 'gs3', game: 'classic', title: 'Офлайн', seats: 1, createdAt: t - 5 * day, updatedAt: t - 2 * day };
    const r = await rows();
    r['comik:games:v1'] = (r['comik:games:v1'] || []).filter(x => x.id !== 'gs3').concat([{ ...gs3, players: [{ tag: 'player_two', name: 'Второй', at: t - day, upd: t - day }] }]);
    await mock('/__mock/rows', 'POST', Object.entries(r).map(([key, value]) => ({ key, value })));
    // запись testplayer на устройстве (до правки ячейки ГМом), в облако не ушла; сайт открыт заново уже со связью
    const { page, ctx, errs } = await page2('testplayer');
    await page.evaluate(([g, t, day]) => { const mine = JSON.parse(localStorage.getItem('comik:games:v1') || '[]').filter(x => x.id !== 'gs3');
      mine.push({ ...g, players: [{ tag: 'testplayer', name: 'Тест', at: t - 3 * day, upd: t - 3 * day }] });
      localStorage.setItem('comik:games:v1', JSON.stringify(mine)); localStorage.setItem('comik:games:dirty', '1'); }, [gs3, t, day]);
    await mock('/__mock/log', 'DELETE');
    await page.reload(); await page.waitForFunction(() => typeof SESSION_READY !== 'undefined' && SESSION_READY === true, null, { timeout: 30000 });
    await page.waitForTimeout(5000);
    const writes = (await mock('/__mock/log')).filter(x => x.key === 'comik:games:v1' && x.method !== 'GET').length;
    const cloud = ((await rows())['comik:games:v1'] || []).find(x => x.id === 'gs3' && !x.deleted) || {};
    const st = await page.evaluate(() => ({ dirty: GAMES_DIRTY, who: ((GAMES.find(s => s.id === 'gs3') || {}).players || []).map(p => p.tag).join(',') }));
    check((cloud.players || []).map(p => p.tag).join(',') === 'player_two', `в облаке место за тем, кто успел (${(cloud.players || []).map(p => p.tag).join(',')})`);
    check(!st.dirty && st.who === 'player_two', `сайт согласен с облаком (${st.who}), не «грязный»`);
    check(writes <= 2, `записей расписания после старта: ${writes} (не по кругу)`);
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  console.log('· расписание: сервер выправил свою запись (старый формат, часы спешат) — сайт не переписывает по кругу');
  {
    const day = 864e5, t = Date.now();
    const r = await rows();
    r['comik:games:v1'] = (r['comik:games:v1'] || []).filter(x => !['gs4', 'gs5'].includes(x.id)).concat([
      { id: 'gs4', game: 'classic', title: 'Старая запись', seats: 5, createdAt: t - 9 * day, updatedAt: t - 9 * day,
        players: [{ tag: 'testplayer', name: 'Тест', at: t - 8 * day, upd: t - 8 * day }] },   // без charId — как писали раньше
      { id: 'gs5', game: 'classic', title: 'Новая', seats: 5, createdAt: t - day, updatedAt: t - day, players: [] }]);
    await mock('/__mock/rows', 'POST', Object.entries(r).map(([key, value]) => ({ key, value })));
    const { page, ctx, errs } = await page2('testplayer');
    const writes = async () => (await mock('/__mock/log')).filter(x => x.key === 'comik:games:v1' && x.method !== 'GET').length;
    await mock('/__mock/log', 'DELETE');
    await page.evaluate(() => { openSignupForm('gs5'); }); await page.evaluate(() => doSignup('gs5'));
    await page.waitForTimeout(1500);
    let st = await page.evaluate(() => ({ dirty: GAMES_DIRTY, cid: JSON.stringify(((GAMES.find(s => s.id === 'gs4') || {}).players || [])[0] || {}) }));
    check(!st.dirty && (await writes()) <= 2, `запись на новую игру при старой записи без charId: ${await writes()} записи, не «грязный»`);
    await mock('/__mock/log', 'DELETE');
    // часы устройства спешат на трое суток: сервер обрежет время записи
    await page.evaluate(day => { const s = GAMES.find(x => x.id === 'gs5'); const me = s.players.find(p => p.tag === 'testplayer'); me.upd = Date.now() + 3 * day; me.name = 'Тест 2'; return persistGames(); }, day);
    await page.waitForTimeout(1500);
    st = await page.evaluate(() => ({ dirty: GAMES_DIRTY }));
    const cl = ((await rows())['comik:games:v1'] || []).find(x => x.id === 'gs5').players.find(p => p.tag === 'testplayer');
    check(!st.dirty && (await writes()) <= 2 && cl.upd < Date.now() + day, `часы спешат: ${await writes()} записи, в облаке время не из будущего, не «грязный»`);
    check(errs.length === 0, 'ошибок в консоли нет' + (errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''));
    await ctx.close();
  }

  await mock('/__mock/rows', 'POST', seed);
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
