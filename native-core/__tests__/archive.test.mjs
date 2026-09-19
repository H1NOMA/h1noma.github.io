// КОМИК · core — тесты слоя архива на СИНТЕТИЧЕСКИХ карточках (никакого реального контента).
//   node native-core/__tests__/archive.test.mjs
import assert from 'node:assert';
import {
  cardMatches, itemRarity, buildFacets, facetValue, sortCards,
  queryArchive, coreForSetting, archiveForSetting,
  dndCategories, spellLevelOf, srcBlocked,
} from '../index.js';
import { parseArchive } from '../data/loadArchive.js';

let passed = 0;
const test = (n, fn) => { fn(); passed++; console.log('  ✓ ' + n); };

// маленький выдуманный набор карточек — только структура, без описаний
const CARDS = [
  { id: 'w1', cat: 'items', sub: 'weapons', title: 'Клинок Б', kicker: 'Простое рукопашное', status: 'official', srcbook: 'PHB', tags: ['режущее'], dossier: [{ k: 'Урон', v: '1d6' }] },
  { id: 'w2', cat: 'items', sub: 'weapons', title: 'Клинок А', kicker: 'Воинское рукопашное', status: 'official', srcbook: 'PHB', tags: [], dossier: [{ k: 'Урон', v: '1d8' }] },
  { id: 'm1', cat: 'items', sub: 'magic', title: 'Амулет', status: 'community', srcbook: 'HB', dossier: [{ k: 'Редкость', v: 'Легендарная' }] },
  { id: 'm2', cat: 'items', sub: 'magic', title: 'Кольцо', status: 'official', srcbook: 'DMG', dossier: [{ k: 'Редкость', v: 'Обычная' }] },
  { id: 'r1', cat: 'character', sub: 'races', title: 'Народ X', status: 'official', srcbook: 'TCE', hideIn: ['legacy'] },
  { id: 's1', cat: 'spells', sub: 'lvl3', title: 'Заклинание Z', status: 'official', srcbook: 'PHB' },
];

console.log('archive: отбор и сортировка');
test('cardMatches по категории/подкатегории', () => {
  assert.equal(cardMatches(CARDS[0], 'items', 'weapons'), true);
  assert.equal(cardMatches(CARDS[0], 'items', 'magic'), false);
  assert.equal(cardMatches(CARDS[0], 'all', null), true);
});
test('редкость распознаётся', () => {
  assert.equal(itemRarity(CARDS[2]).key, 'legendary');
  assert.equal(itemRarity(CARDS[3]).key, 'common');
  assert.equal(itemRarity(CARDS[0]).key, '');
});
test('сортировка: оружие по алфавиту, магия по редкости', () => {
  const w = sortCards(CARDS.filter(c => c.sub === 'weapons'));
  assert.deepEqual(w.map(c => c.id), ['w2', 'w1']);          // «Клинок А» раньше «Клинок Б»
  const m = sortCards(CARDS.filter(c => c.sub === 'magic'));
  assert.deepEqual(m.map(c => c.id), ['m2', 'm1']);          // Обычная(0) раньше Легендарной(4)
});

console.log('archive: фасеты и запрос');
test('buildFacets даёт источник/тип/правила/редкость', () => {
  const f = buildFacets(CARDS);
  const keys = f.map(x => x.key);
  assert.ok(keys.includes('__src'));
  assert.ok(keys.includes('__status'));
});
test('facetValue', () => {
  assert.equal(facetValue(CARDS[0], '__src'), 'PHB');
  assert.equal(facetValue(CARDS[2], '__src'), 'HB');
  assert.equal(facetValue(CARDS[2], '__status'), 'community');
  assert.equal(facetValue(CARDS[2], '__rar'), 'legendary');
});
test('queryArchive: категория + фасет + поиск', () => {
  const onlyWeapons = queryArchive(CARDS, { cat: 'items', sub: 'weapons' });
  assert.equal(onlyWeapons.total, 2);
  const official = queryArchive(CARDS, { cat: 'items', filters: { __status: ['official'] } });
  assert.ok(official.items.every(c => c.status === 'official'));
  const search = queryArchive(CARDS, { cat: 'all', search: 'кольцо' });
  assert.deepEqual(search.items.map(c => c.id), ['m2']);
});

console.log('archive: ядро под сеттинг');
test('coreForSetting уважает hideIn и блокировку источников', () => {
  // legacy: скрывает r1 (hideIn), TERRA-блок здесь не применяется
  const legacy = coreForSetting(CARDS, 'legacy');
  assert.ok(!legacy.find(c => c.id === 'r1'));
  // terra: r1 из TCE в разделе races заблокирован
  assert.equal(srcBlocked('terra', 'races', 'TCE'), true);
  const terra = coreForSetting(CARDS, 'terra');
  assert.ok(!terra.find(c => c.id === 'r1'));
  // classic: r1 виден
  const classic = coreForSetting(CARDS, 'classic');
  assert.ok(classic.find(c => c.id === 'r1'));
  // assimilation: ядра нет вообще
  assert.equal(coreForSetting(CARDS, 'assimilation').length, 0);
});
test('archiveForSetting = свои + ядро', () => {
  const mine = [{ id: 'u1', cat: 'world', sub: 'npc', title: 'Мой НПС' }];
  const all = archiveForSetting(mine, CARDS, 'classic');
  assert.ok(all.find(c => c.id === 'u1'));
  assert.ok(all.find(c => c.id === 'w1'));
});

console.log('taxonomy + loader');
test('дерево категорий и круг заклинания', () => {
  const cats = dndCategories();
  assert.ok(cats.find(c => c.id === 'spells').subs.length === 10);
  assert.equal(spellLevelOf('lvl3'), 3);
  assert.equal(spellLevelOf('lvl0'), 0);
});
test('parseArchive нормализует и выкидывает мусор', () => {
  const norm = parseArchive([{ id: 'ok', title: 'A' }, null, { title: 'нет id' }]);
  assert.equal(norm.length, 1);
  assert.deepEqual(norm[0].tags, []);
});

console.log(`\nВсе тесты архива пройдены: ${passed} блоков.`);
