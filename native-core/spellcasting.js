// КОМИК · core/spellcasting — заклинатели: заговоры, известные/подготовленные, ячейки,
// совокупный уровень мультикласса. Чистая логика правил (числовые таблицы — игровые факты).
import { ABILITY_KEYS, ABILITY_LABEL, abilityMod } from './abilities.js';

/**
 * Классы-заклинатели КОМИКа.
 *  ab    — базовая характеристика заклинателя
 *  type  — 'known' (знает список), 'book' (книга Волшебника), 'prep' (готовит по молитвеннику)
 *  half  — полузаклинатель (Паладин/Следопыт)
 *  known — таблица числа известных заклинаний по уровням 1..20 (для type:'known')
 *  hideIn — сеттинги, где класс скрыт
 */
export const CASTERS = {
  'Бард':      { ab: 'cha', type: 'known', known: [4,5,6,7,8,9,10,11,12,14,15,15,16,18,19,19,20,22,22,22] },
  'Волшебник': { ab: 'int', type: 'book' },
  'Друид':     { ab: 'wis', type: 'prep' },
  'Жрец':      { ab: 'wis', type: 'prep' },
  'Колдун':    { ab: 'cha', type: 'known', known: [2,3,4,5,6,7,8,9,10,10,11,11,12,12,13,13,14,14,15,15] },
  'Паладин':   { ab: 'cha', type: 'prep', half: true },
  'Следопыт':  { ab: 'wis', type: 'known', half: true, known: [0,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11], hideIn: ['terra'] },
  'Чародей':   { ab: 'cha', type: 'known', known: [2,3,4,5,6,7,8,9,10,11,12,12,13,13,14,14,15,15] },
};

/** Имена классов-заклинателей, доступных в сеттинге (по hideIn). */
export function casterNames(setting) {
  return Object.keys(CASTERS).filter(cn => !(CASTERS[cn].hideIn && CASTERS[cn].hideIn.indexOf(setting) >= 0));
}

/** Число заговоров класса на его уровне (растёт на 4-м и 10-м). */
export function cantripsKnownFor(cn, cl) {
  const base = { 'Бард': 2, 'Волшебник': 3, 'Жрец': 3, 'Друид': 2, 'Колдун': 2, 'Чародей': 4 };
  if (!(cn in base)) return 0;
  let n = base[cn];
  if (cl >= 10) n += 2; else if (cl >= 4) n += 1;
  return n;
}

/** Предел заклинаний (не заговоров), которыми класс может владеть на уровне. mods — карта модификаторов. */
export function knownSpellsMaxFor(cn, cl, mods = {}) {
  const ci = CASTERS[cn];
  if (!ci) return 0;
  if (ci.type === 'known') return ci.known[Math.min(19, Math.max(0, cl - 1))] || 0;
  if (ci.type === 'book') return 6 + 2 * (cl - 1);                 // книга Волшебника: +2/уровень
  const base = ci.half ? Math.floor(cl / 2) : cl;
  return Math.max(1, base + (mods[ci.ab] || 0));                    // готовящие: (½)уровень + мод
}

/**
 * Сводные лимиты подготовки по набору классов.
 * @param {string[]} cls  классы персонажа
 * @param {Object} lvls   уровни по классам { [cn]: level } (для мультикласса)
 * @param {number} glvl   общий уровень (если у класса нет своего)
 * @param {Object} abil   характеристики { str, dex, ... }
 * @returns {{prepMax:number, lines:string[]}}
 */
export function spellLimits(cls, lvls, glvl, abil) {
  const mods = {};
  ABILITY_KEYS.forEach(k => { mods[k] = abilityMod(abil && abil[k]); });
  let prepMax = 0;
  const lines = [];
  (cls || []).forEach(cn => {
    const ci = CASTERS[cn];
    if (!ci) return;
    const cl = Math.max(1, Math.min(20, parseInt(lvls && lvls[cn], 10) || glvl || 1));
    if (ci.type === 'known') {
      lines.push(`${cn} ${cl}: знает ${ci.known[cl - 1]} закл. по таблице класса — они всегда готовы`);
    } else if (ci.type === 'book') {
      const n = Math.max(1, cl + mods[ci.ab]); prepMax += n;
      lines.push(`${cn} ${cl}: в книге ≈ ${6 + 2 * (cl - 1)} закл., подготовлено ≤ ${n} (уровень + мод. ИНТ)`);
    } else {
      const base = ci.half ? Math.floor(cl / 2) : cl;
      const n = Math.max(1, base + mods[ci.ab]); prepMax += n;
      lines.push(`${cn} ${cl}: подготовлено ≤ ${n} (${ci.half ? '½ уровня' : 'уровень'} + мод. ${ABILITY_LABEL[ci.ab]})`);
    }
  });
  return { prepMax, lines };
}

/** Суммарные лимиты формы: заговоры + известные + подготовленные. */
export function spellSlotsSummary(cls, lvls, glvl, abil) {
  const mods = {};
  ABILITY_KEYS.forEach(k => { mods[k] = abilityMod(abil && abil[k]); });
  let cantripMax = 0, knownMax = 0;
  (cls || []).forEach(cn => {
    const cl = Math.max(1, Math.min(20, parseInt(lvls && lvls[cn], 10) || glvl || 1));
    cantripMax += cantripsKnownFor(cn, cl);
    knownMax += knownSpellsMaxFor(cn, cl, mods);
  });
  return { cantripMax, knownMax, prepMax: spellLimits(cls, lvls, glvl, abil).prepMax };
}

// Таблица ячеек мультикласс-заклинателя: совокупный уровень 1..20 → ячейки кругов 1..9.
export const MULTICLASS_SLOTS = [
  [2,0,0,0,0,0,0,0,0], [3,0,0,0,0,0,0,0,0], [4,2,0,0,0,0,0,0,0], [4,3,0,0,0,0,0,0,0],
  [4,3,2,0,0,0,0,0,0], [4,3,3,0,0,0,0,0,0], [4,3,3,1,0,0,0,0,0], [4,3,3,2,0,0,0,0,0],
  [4,3,3,3,1,0,0,0,0], [4,3,3,3,2,0,0,0,0], [4,3,3,3,2,1,0,0,0], [4,3,3,3,2,1,0,0,0],
  [4,3,3,3,2,1,1,0,0], [4,3,3,3,2,1,1,0,0], [4,3,3,3,2,1,1,1,0], [4,3,3,3,2,1,1,1,0],
  [4,3,3,3,2,1,1,1,1], [4,3,3,3,3,1,1,1,1], [4,3,3,3,3,2,1,1,1], [4,3,3,3,3,2,2,1,1],
];

/**
 * Совокупный уровень заклинателя для мультикласса.
 * Полные касты (Бард/Жрец/Друид/Волшебник/Чародей) — весь уровень;
 * полукасты (Паладин/Следопыт) — floor(lvl/2); трети-касты — floor(lvl/3).
 * @param {Array<{cls:string, level:number, third?:boolean}>} classes
 */
export function multiclassCasterLevel(classes) {
  let total = 0;
  for (const c of classes || []) {
    const lvl = parseInt(c.level, 10) || 0;
    const ci = CASTERS[c.cls];
    if (c.third) total += Math.floor(lvl / 3);          // Мистический рыцарь / Мистический ловкач
    else if (ci && ci.half) total += Math.floor(lvl / 2);
    else if (ci) total += lvl;                          // полный заклинатель
  }
  return Math.min(20, total);
}

/** Ячейки по совокупному уровню: массив из 9 чисел (круги 1..9). */
export function multiclassSlots(casterLevel) {
  const l = Math.max(0, Math.min(20, casterLevel | 0));
  return l === 0 ? [0,0,0,0,0,0,0,0,0] : MULTICLASS_SLOTS[l - 1].slice();
}
