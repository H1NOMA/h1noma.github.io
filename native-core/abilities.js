// КОМИК · core/abilities — характеристики, модификаторы, бонус мастерства, навыки.
// Чистая логика правил (без DOM), перенесённая из index.html. Годится для React Native,
// Node и любого бандлера. Никаких зависимостей.

/** Шесть характеристик: ключ + краткая русская подпись. */
export const ABILITIES = [
  ['str', 'СИЛ'], ['dex', 'ЛОВ'], ['con', 'ТЕЛ'],
  ['int', 'ИНТ'], ['wis', 'МДР'], ['cha', 'ХАР'],
];
export const ABILITY_KEYS = ABILITIES.map(([k]) => k);
export const ABILITY_LABEL = Object.fromEntries(ABILITIES);

/** Модификатор характеристики: floor((score-10)/2). Нечисло → 0. */
export function abilityMod(score) {
  const n = parseInt(score, 10);
  return isNaN(n) ? 0 : Math.floor((n - 10) / 2);
}

/** То же, но строкой со знаком: 14 → "+2", 8 → "-1". Пустое при нечисле. */
export function abilityModStr(score) {
  const n = parseInt(score, 10);
  if (isNaN(n)) return '';
  return fmtBonus(Math.floor((n - 10) / 2));
}

/** Знак у числа: 3 → "+3", -1 → "-1", 0 → "+0". */
export function fmtBonus(n) {
  return (n >= 0 ? '+' : '') + n;
}

/** Бонус мастерства по уровню (1–20): 2 + floor((lvl-1)/4). */
export function proficiencyBonus(level) {
  const l = Math.max(1, Math.min(20, parseInt(level, 10) || 1));
  return 2 + Math.floor((l - 1) / 4);
}

// Навык → базовая характеристика (порядок как в листе КОМИКа).
export const SKILLS = [
  ['Акробатика', 'dex'], ['Анализ', 'int'], ['Атлетика', 'str'],
  ['Внимательность', 'wis'], ['Выживание', 'wis'], ['Выступление', 'cha'],
  ['Запугивание', 'cha'], ['История', 'int'], ['Ловкость рук', 'dex'],
  ['Магия', 'int'], ['Медицина', 'wis'], ['Обман', 'cha'],
  ['Природа', 'int'], ['Проницательность', 'wis'], ['Религия', 'int'],
  ['Скрытность', 'dex'], ['Убеждение', 'cha'], ['Уход за животными', 'wis'],
];

/**
 * Значение спасброска: модификатор характеристики + (владеет ? бонус мастерства : 0).
 * @param {number|string} score  значение характеристики
 * @param {boolean} proficient   есть ли владение
 * @param {number} pb            бонус мастерства
 */
export function saveValue(score, proficient, pb) {
  return abilityMod(score) + (proficient ? pb : 0);
}

/**
 * Значение навыка: модификатор + бонус·круги.
 * 0 — нет владения, 1 — владение (×1), 2 — компетентность (×2).
 */
export function skillValue(score, dots, pb) {
  const d = Math.max(0, Math.min(2, parseInt(dots, 10) || 0));
  return abilityMod(score) + d * pb;
}

// Стандартная стоимость покупки характеристик (SRD point-buy), 8–15.
const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
/** Стоимость одного значения при покупке очков (вне 8–15 → null). */
export function pointBuyCost(score) {
  const n = parseInt(score, 10);
  return n in POINT_BUY_COST ? POINT_BUY_COST[n] : null;
}
/** Суммарная стоимость набора значений; null, если что-то вне диапазона. */
export function pointBuyTotal(scores) {
  let total = 0;
  for (const s of scores) {
    const c = pointBuyCost(s);
    if (c == null) return null;
    total += c;
  }
  return total;
}
