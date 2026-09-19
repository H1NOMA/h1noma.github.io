// КОМИК · core/archive — чистая логика архива: отбор по категории, фасеты, поиск, сортировка,
// сборка ядра под сеттинг. Работает с массивом карточек, переданным снаружи (данные не встроены).
import { RARITY, RARITY_VARIES, srcBookOf, srcBlocked } from './taxonomy.js';
import { isCoreGame } from './settings.js';

/** Подходит ли карточка под выбранную категорию/подкатегорию. cat==='all'/пусто — без фильтра по категории. */
export function cardMatches(card, cat, sub) {
  if (cat && cat !== 'all' && card.cat !== cat) return false;
  if (sub && card.sub !== sub) return false;
  return true;
}

/** Ступень редкости магического предмета по полю досье «Редкость». */
export function itemRarity(card) {
  const r = (card.dossier || []).find(d => /редкост/i.test(d.k));
  const v = ((r && r.v) || '').toLowerCase();
  if (!v) return { key: '', ord: 9, label: '' };
  if (/артефакт/.test(v)) return RARITY[5];
  if (/легендар/.test(v)) return RARITY[4];
  if (/очень\s*редк/.test(v)) return RARITY[3];
  if (/необычн/.test(v)) return RARITY[1];
  if (/обычн/.test(v)) return RARITY[0];
  if (/редк/.test(v)) return RARITY[2];
  return RARITY_VARIES;
}

const FACET_SKIP = /редкост|описан|заметк|\bавтор|источник|номер|страниц/i;

/**
 * Построить фасеты фильтра по набору карточек раздела: источник, тип (kicker), правила (канон/сообщество),
 * редкость и уникальные поля досье с небольшим числом нечисловых значений.
 * @returns {Array<{key:string,label:string,values:Array<{val:string,label:string}>}>}
 */
export function buildFacets(base) {
  const facets = [];
  const books = [...new Set(base.map(e => srcBookOf(e) || 'HB'))];
  if (books.length > 1) facets.push({ key: '__src', label: 'Источник', values: books.sort().map(b => ({ val: b, label: b })) });

  const kmap = new Map();
  base.forEach(e => { const k = (e.kicker || '').trim(); if (k) kmap.set(k, (kmap.get(k) || 0) + 1); });
  if (kmap.size >= 2 && kmap.size <= 16)
    facets.push({ key: '__kicker', label: 'Тип', values: [...kmap.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => ({ val: v, label: v })) });

  const stO = base.some(e => e.status === 'official'), stC = base.some(e => e.status !== 'official');
  if (stO && stC) facets.push({ key: '__status', label: 'Правила', values: [{ val: 'official', label: 'Канон' }, { val: 'community', label: 'Сообщество' }] });

  const rmap = new Map();
  base.forEach(e => { const ri = itemRarity(e); if (ri.key) rmap.set(ri.key, ri); });
  if (rmap.size > 1) {
    const rs = [...rmap.values()].sort((a, b) => a.ord - b.ord);
    facets.push({ key: '__rar', label: 'Редкость', values: rs.map(r => ({ val: r.key, label: r.label })) });
  }

  const keyVals = {}, keyCount = {};
  base.forEach(e => (e.dossier || []).forEach(d => {
    if (!d.k || d.v == null || FACET_SKIP.test(d.k)) return;
    const v = String(d.v).trim(); if (!v || v === '—') return;
    (keyVals[d.k] = keyVals[d.k] || new Map()).set(v, (keyVals[d.k].get(v) || 0) + 1);
    keyCount[d.k] = (keyCount[d.k] || 0) + 1;
  }));
  const minPresent = Math.max(2, Math.round(base.length * 0.3));
  Object.keys(keyVals).forEach(k => {
    const vm = keyVals[k];
    if (vm.size < 2 || vm.size > 16 || keyCount[k] < minPresent) return;
    const vals = [...vm.keys()];
    if (vals.filter(v => /\d/.test(v)).length / vals.length > 0.4) return;   // числовые поля — не фильтр
    facets.push({ key: k, label: k, values: [...vm.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => ({ val: v, label: v })) });
  });
  return facets;
}

/** Значение карточки по ключу фасета (для сопоставления с выбранными значениями). */
export function facetValue(card, key) {
  if (key === '__src') return srcBookOf(card) || 'HB';
  if (key === '__kicker') return (card.kicker || '').trim();
  if (key === '__status') return card.status === 'official' ? 'official' : 'community';
  if (key === '__rar') return itemRarity(card).key;
  const d = (card.dossier || []).find(x => x.k === key);
  return d ? String(d.v).trim() : '';
}

/** Строка поиска по карточке: название + подзаголовок + текст + теги (нижний регистр). */
export function cardSearchText(card) {
  return (card.title + ' ' + (card.kicker || '') + ' ' + (card.body || '') + ' ' + (card.tags || []).join(' ')).toLowerCase();
}

/** Сортировка: магпредметы — по ступени редкости, затем по алфавиту; иначе — по алфавиту (ru). */
export function sortCards(list) {
  const byRar = list.some(e => itemRarity(e).key);
  return list.slice().sort(byRar
    ? (a, b) => (itemRarity(a).ord - itemRarity(b).ord) || a.title.localeCompare(b.title, 'ru')
    : (a, b) => a.title.localeCompare(b.title, 'ru'));
}

/**
 * Полный запрос по архиву: категория → фасеты (внутри фасета ИЛИ, между фасетами И) → поиск → сортировка.
 * @param {Array} cards        весь массив карточек сеттинга
 * @param {Object} q           { cat, sub, filters:{[facetKey]:string[]}, search }
 * @returns {{ items:Array, total:number, facets:Array }}
 */
export function queryArchive(cards, q = {}) {
  const { cat = 'all', sub = null, filters = {}, search = '' } = q;
  let list = cards.filter(c => cardMatches(c, cat, sub));
  const facets = buildFacets(list);
  list = sortCards(list);
  Object.keys(filters).forEach(fk => {
    const sel = filters[fk];
    if (sel && sel.length) list = list.filter(e => sel.indexOf(facetValue(e, fk)) >= 0);
  });
  const query = (search || '').trim().toLowerCase();
  if (query) list = list.filter(e => cardSearchText(e).includes(query));
  return { items: list, total: list.length, facets };
}

/**
 * Ядро SRD под сеттинг: применяет переопределения, скрывает hideIn и заблокированные источники.
 * @param {Array} core          общий массив карточек ядра
 * @param {string} setting      сеттинг
 * @param {Object} [overrides]  карта переопределений { [id]: card }
 */
export function coreForSetting(core, setting, overrides = {}) {
  if (!isCoreGame(setting)) return [];
  return (core || [])
    .map(c => overrides[c.id] || c)
    .filter(c => !(Array.isArray(c.hideIn) && c.hideIn.indexOf(setting) >= 0))
    .filter(c => !srcBlocked(setting, c.sub, c.srcbook));
}

/** Итоговый архив сеттинга: пользовательские карточки + ядро SRD. */
export function archiveForSetting(userCards, core, setting, overrides = {}) {
  return (userCards || []).concat(coreForSetting(core, setting, overrides));
}
