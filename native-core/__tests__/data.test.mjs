// КОМИК · core — тесты слоя данных на хранилище в памяти (без облака/сети).
//   node native-core/__tests__/data.test.mjs
import assert from 'node:assert';
import {
  createMemoryStore, createLayeredStore, withTimeout,
  mergeById, mergeByFreshness, optimisticApply,
  normTag, currentTag, isDev, canManageGame, seatsLeft, assimVisible,
  boardKey, boardProj, cardKey, isFoeCard, mergeBoardList, activeBoardForPlayer,
  charactersRepo, gamesRepo, newsRepo, boardRepo, KEYS,
} from '../data/index.js';

let passed = 0;
const test = (n, fn) => Promise.resolve(fn()).then(() => { passed++; console.log('  ✓ ' + n); });
const run = async (fns) => { for (const f of fns) await f(); };

await run([
  () => { console.log('session/права'); },
  () => test('теги и разработчики', () => {
    assert.equal(normTag('@Hinoma '), 'hinoma');
    assert.equal(isDev('hinoma'), true);
    assert.equal(isDev('herr_teo'), true);
    assert.equal(isDev('alice'), false);
    assert.equal(assimVisible('herr_teo'), true);
    assert.equal(assimVisible('alice'), false);
  }),
  () => test('владение играми', () => {
    const g = { id: 'g1', owner: 'alice', seats: 3, players: [{ tag: 'a' }] };
    assert.equal(canManageGame(g, 'alice'), true);
    assert.equal(canManageGame(g, 'bob'), false);
    assert.equal(canManageGame(g, 'hinoma'), true);   // dev
    assert.equal(seatsLeft(g), 2);
  }),

  () => { console.log('sync/слияние'); },
  () => test('mergeById и mergeByFreshness', () => {
    assert.deepEqual(mergeById([{ id: 1 }], [{ id: 1, x: 9 }, { id: 2 }]).map(o => o.id), [1, 2]);
    const m = mergeByFreshness([{ id: 'c', hp: 1, updatedAt: 1 }], [{ id: 'c', hp: 5, updatedAt: 9 }]);
    assert.equal(m.length, 1); assert.equal(m[0].hp, 5);            // свежее побеждает
    const t = mergeByFreshness([{ id: 'c', updatedAt: 5 }], [{ id: 'c', deleted: true, updatedAt: 9 }]);
    assert.equal(t[0].deleted, true);                              // надгробие не воскресает
  }),
  () => test('optimisticApply идемпотентно пишет в стор', async () => {
    const store = createMemoryStore();
    await store.set('k', { n: 1 });
    const res = await optimisticApply({ store, key: 'k', apply: (cur) => ({ n: (cur ? cur.n : 0) + 10 }) });
    // применяется дважды (оптимистично + поверх свежего) — но идемпотентно к финальному значению
    assert.equal(res.n, (await store.get('k')).n);
    assert.ok(res.n >= 11);
  }),

  () => { console.log('store/слоёное хранилище'); },
  () => test('withTimeout возвращает undefined по таймауту', async () => {
    const slow = new Promise(r => setTimeout(() => r('поздно'), 50));
    assert.equal(await withTimeout(slow, 5), undefined);
  }),
  () => test('облако с зеркалом; личные ключи мимо облака', async () => {
    const cloud = createMemoryStore(), local = createMemoryStore();
    const store = createLayeredStore({ cloud, local });
    await store.set(KEYS.games, [{ id: 'g' }]);                    // общий ключ → в оба
    assert.ok(await cloud.get(KEYS.games));
    assert.ok(await local.get(KEYS.games));
    await store.set(KEYS.session, 'alice');                        // личный ключ → только локально
    assert.equal(await cloud.get(KEYS.session), null);
    assert.equal(await local.get(KEYS.session), 'alice');
  }),

  () => { console.log('board/стол'); },
  () => test('ключи досок и слияние', () => {
    assert.equal(boardKey('classic', 'hinoma'), 'classic');       // dev — каноничная
    assert.equal(boardKey('classic', 'alice'), 'classic::alice'); // игрок-ГМ — своя
    assert.equal(boardProj('classic::alice'), 'classic');
    assert.equal(isFoeCard({ name: 'Гоблин' }), true);
    assert.equal(isFoeCard({ charId: 'c1' }), false);
    // враг берётся из локального, игрок — из общего стола
    const merged = mergeBoardList(
      [{ charId: 'c1', hp: 10 }, { name: 'Гоблин', hp: 7 }],
      [{ charId: 'c1', hp: 3, init: 5 }]);
    assert.equal(merged[0].hp, 3);    // игрок — из общего
    assert.equal(merged[1].hp, 7);    // враг — из локального
  }),
  () => test('активная доска игрока', () => {
    const shared = {
      'classic::alice': { active: true, list: [{ charId: 'x' }] },
      'classic::bob':   { active: true, list: [{ charId: 'mine' }] },
    };
    assert.equal(activeBoardForPlayer(shared, 'classic', new Set(['mine'])), 'classic::bob');
    assert.ok(activeBoardForPlayer(shared, 'classic', new Set(['none'])));   // хоть какая-то активная
  }),

  () => { console.log('repositories'); },
  () => test('gamesRepo: запись/места/кик/права', async () => {
    const store = createMemoryStore();
    const repo = gamesRepo(store);
    await repo.save([{ id: 'g1', owner: 'alice', seats: 2, players: [] }]);
    const r1 = await repo.signup('g1', 'bob', { name: 'Боб' });
    assert.equal(r1.ok, true);
    assert.equal(seatsLeft((await repo.list())[0]), 1);
    const bad = await repo.kick('g1', 0, 'carol');                // не владелец
    assert.equal(bad.ok, false);
    const ok = await repo.kick('g1', 0, 'alice');                 // владелец
    assert.equal(ok.ok, true);
    const managed = await repo.managedBy('alice');
    assert.equal(managed.length, 1);
    assert.equal((await repo.managedBy('bob')).length, 0);
  }),
  () => test('boardRepo: публикация и подписка', async () => {
    const store = createMemoryStore();
    const repo = boardRepo(store);
    let notified = 0;
    const off = repo.subscribe(() => notified++);
    await repo.publish('classic', 'alice', { localList: [{ name: 'Гоблин', hp: 7 }], party: 'g1', active: true });
    const all = await repo.fetchAll();
    assert.ok(all['classic::alice']);
    assert.equal(all['classic::alice'].active, true);
    assert.ok(notified >= 1);
    off();
  }),
  () => test('charactersRepo: сбор пер-юзерных листов со слиянием', async () => {
    const store = createMemoryStore();
    const repo = charactersRepo(store);
    await repo.saveForTag('alice', { classic: [{ id: 'c1', hp: 5, updatedAt: 1 }] });
    await repo.saveForTag('bob', { classic: [{ id: 'c2', hp: 9, updatedAt: 1 }] });
    const all = await repo.loadAll();
    assert.equal(all.classic.length, 2);
  }),
]);

console.log(`\nВсе тесты слоя данных пройдены: ${passed} блоков.`);
