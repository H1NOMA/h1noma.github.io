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

  await mock('/__mock/rows', 'POST', seed);
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
