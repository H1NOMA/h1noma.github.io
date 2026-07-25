// КОМИК · core/taxonomy — структура архива: категории/подкатегории, справочники источников,
// ступени редкости, ограничения источников по сеттингам. Только структура и коды — без описаний карточек.

/** Дерево категорий архива для D&D-сеттингов. withPaths — добавить раздел «Пути»; extra — доп. категории. */
export function dndCategories(withPaths = false, extra = []) {
  const c = [];
  if (withPaths) c.push({ id: 'paths', label: 'Пути', type: 'cards', subs: [] });
  return c.concat([
    { id: 'character', label: 'Персонаж', type: 'cards', subs: [
      { id: 'races', label: 'Расы' }, { id: 'classes', label: 'Классы' },
      { id: 'backgrounds', label: 'Предыстории' }, { id: 'feats', label: 'Черты' },
    ]},
    { id: 'items', label: 'Снаряжение', type: 'cards', subs: [
      { id: 'weapons', label: 'Оружие' }, { id: 'armor', label: 'Доспехи' },
      { id: 'gear', label: 'Инструменты и товары' }, { id: 'magic', label: 'Магические предметы' },
    ]},
    { id: 'mechanics', label: 'Правила', type: 'cards', subs: [
      { id: 'combat', label: 'Бой' }, { id: 'adventure', label: 'Приключения и отдых' },
      { id: 'spellcasting', label: 'Магия и заклинания' }, { id: 'conditions', label: 'Состояния' },
    ]},
    { id: 'spells', label: 'Заклинания', type: 'cards', subs:
      Array.from({ length: 10 }, (_, i) => ({ id: 'lvl' + i, label: i === 0 ? 'Заговоры' : i + ' круг' })) },
    { id: 'world', label: 'Мир', type: 'cards', subs: [
      { id: 'locations', label: 'Локации' }, { id: 'factions', label: 'Фракции' },
      { id: 'npc', label: 'Персоналии' }, { id: 'deities', label: 'Божества' }, { id: 'bestiary', label: 'Бестиарий' },
    ]},
  ]).concat(extra || []);
}

/** Круг заклинания из подкатегории: 'lvl3' → 3, 'lvl0' → 0. */
export function spellLevelOf(sub) {
  const n = parseInt(String(sub || 'lvl0').slice(3), 10);
  return isNaN(n) ? 0 : n;
}

// Коды и названия книг-источников (справочные названия, не описания).
export const SOURCES = {
  SRD:  { en: 'System Reference Document 5.1', ru: 'Системный справочник 5.1' },
  PHB:  { en: "Player's Handbook", ru: '«Книга игрока»' },
  DMG:  { en: "Dungeon Master's Guide", ru: '«Руководство Мастера»' },
  MM:   { en: 'Monster Manual', ru: '«Бестиарий»' },
  VGM:  { en: "Volo's Guide to Monsters", ru: '«Путеводитель Воло по монстрам»' },
  MTF:  { en: "Mordenkainen's Tome of Foes", ru: '«Том врагов Морденкайнена»' },
  XGE:  { en: "Xanathar's Guide to Everything", ru: '«Путеводитель Занатара по всему»' },
  FTD:  { en: "Fizban's Treasury of Dragons", ru: '«Сокровищница драконов Физбана»' },
  TCE:  { en: "Tasha's Cauldron of Everything", ru: '«Котёл всего Таши»' },
  MPMM: { en: 'Monsters of the Multiverse', ru: '«Монстры Мультивселенной»' },
  HB:   { en: 'Homebrew', ru: 'Своё / сообщество' },
};

/** Код источника карточки, если он известен (иначе null). */
export function srcBookOf(card) {
  return (card && card.srcbook && SOURCES[card.srcbook]) ? card.srcbook : null;
}

// Ступени редкости магических предметов (для фильтра и сортировки).
export const RARITY = [
  { key: 'common', ord: 0, label: 'Обычная' },
  { key: 'uncommon', ord: 1, label: 'Необычная' },
  { key: 'rare', ord: 2, label: 'Редкая' },
  { key: 'veryrare', ord: 3, label: 'Очень редкая' },
  { key: 'legendary', ord: 4, label: 'Легендарная' },
  { key: 'artifact', ord: 5, label: 'Артефакт' },
];
export const RARITY_VARIES = { key: 'varies', ord: 6, label: 'Варьируется' };

// Ограничения источников по сеттингам: в TERRA недоступны некоторые книги для рас/классов.
export const SETTING_SRC_BLOCK = {
  terra: { subs: ['races', 'classes'], srcs: ['TCE', 'MPMM', 'VRGR'] },
};

/** Заблокирован ли источник карточки в данном сеттинге. */
export function srcBlocked(setting, sub, book) {
  const p = SETTING_SRC_BLOCK[setting];
  return !!(p && book && p.subs.indexOf(sub) >= 0 && p.srcs.indexOf(book) >= 0);
}
