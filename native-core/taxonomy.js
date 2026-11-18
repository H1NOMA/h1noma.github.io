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

// Категории ASSIMILATION (киберпанк-сеттинг со своим деревом разделов).
export const ASSIM_CATS = [
  { id: 'character', label: 'Персонаж', type: 'cards', subs: [
    { id: 'origin', label: 'Происхождение' }, { id: 'occupation', label: 'Занятость' }, { id: 'traits', label: 'Черты' },
  ]},
  { id: 'items', label: 'Предметы', type: 'cards', subs: [
    { id: 'weapons', label: 'Оружие' }, { id: 'implants', label: 'Импланты' },
    { id: 'consumables', label: 'Расходники' }, { id: 'property', label: 'Имущество' },
  ]},
  { id: 'world', label: 'Мир', type: 'cards', subs: [
    { id: 'chumbas', label: 'Чумбы' }, { id: 'reapers', label: 'Риперы' }, { id: 'netrunners', label: 'Нетраннеры' },
    { id: 'traders', label: 'Торговцы' }, { id: 'corps', label: 'Корпорации' },
    { id: 'locations', label: 'Локации' }, { id: 'enemies', label: 'Противники' },
  ]},
  { id: 'mechanics', label: 'Механики', type: 'cards', subs: [
    { id: 'combat', label: 'Бой' }, { id: 'environment', label: 'Среда' }, { id: 'economy', label: 'Экономика' },
    { id: 'augment', label: 'Аугментация' }, { id: 'transport', label: 'Транспорт' }, { id: 'cyberspace', label: 'Киберпространство' },
  ]},
];
const CAT_ABYSS = { id: 'abyss', label: 'Бездна', type: 'cards', subs: [] };
const CAT_WILL = { id: 'will', label: 'Воля', type: 'cards', subs: [] };
const CAT_QUILL = { id: 'quill', label: 'Перо дьявола', type: 'cards', subs: [] };
const CAT_TRAUMA = { id: 'trauma', label: 'Травмы', type: 'cards', subs: [], dev: true };
const CAT_AETHER = { id: 'aether', label: 'Эфир', type: 'cards', subs: [] };

/** Дерево категорий архива конкретного сеттинга (как CATS_ALL на сайте). */
export function settingCategories(setting) {
  switch (setting) {
    case 'assimilation': return ASSIM_CATS.concat([CAT_AETHER]);
    case 'legacy': return dndCategories(true, [CAT_ABYSS]);
    case 'neverland': return dndCategories(false, [CAT_ABYSS]);
    case 'terra': return dndCategories(false, [CAT_WILL, CAT_QUILL, CAT_TRAUMA]);
    case 'classic': return dndCategories(false, []);
    default: return dndCategories(false, []);
  }
}

// Приветствия сеттингов (чистый текст, без разметки — акцент строится в UI).
export const SETTING_HERO = {
  assimilation: {
    title: 'Новый рассвет над New-Liberty',
    text: 'Легендами не рождаются — их куёт эпоха. Финальная глава RISING OF DARKNESS приведёт «героев» в город больших обещаний — New-Liberty, где неон ярче солнца, а память стоит дешевле патронов. Сможете ли вы закончить то, что началось на Луне?',
    empty: 'Новостей пока нет — но New-Liberty никогда не спит.',
  },
  legacy: {
    title: 'Луна взошла над Фаэруном',
    text: 'Когда серебряный диск поднимается над шпилями, просыпается то, что днём прячется в тенях. LEGACY — история о клятвах, данных при лунном свете, и о цене, которую платят те, кто их нарушил. Тайна зовёт — идёшь?',
    empty: 'Хроники молчат. Луна ещё не раскрыла своих тайн.',
  },
  neverland: {
    title: 'Зов Древних',
    text: 'Под золотом ушедших империй спят те, кто старше самих богов. NEVERLAND — путь через сокровищницы забытых царей и храмы, где шёпот древних сильнее стали. Богатство ждёт смелых. Цена — рассудок.',
    empty: 'Свитки пусты. Древние пока безмолвствуют.',
  },
  terra: {
    title: 'Туман над вечным городом',
    text: 'Газовые фонари, стук пишущих машинок и магия, о которой не пишут в газетах. TERRA AETERNA — детективные дела начала XX века, где за каждым убийством в тумане стоит нечто большее, чем человек. Дело открыто.',
    empty: 'Свежих сводок нет. Город затаился в тумане.',
  },
  classic: {
    title: 'Каноничные приключения',
    text: 'Ни особых правил, ни домашних механик — только классика. КЛАССИКА — чистые каноничные приключения по базовым правилам: подземелья, драконы и герои, какими они были задуманы. Бросай кубик — история начинается здесь.',
    empty: 'Свежих объявлений нет. Кто соберёт отряд первым?',
  },
};

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
