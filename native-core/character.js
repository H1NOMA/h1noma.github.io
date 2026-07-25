// КОМИК · core/character — чистый «селектор» листа персонажа: из объекта персонажа
// считает производные значения (модификаторы, спасброски, навыки, лимиты заклинаний).
// Ничего не мутирует, DOM не трогает — идеально для useMemo в React/React Native.
import { ABILITIES, abilityMod, fmtBonus, proficiencyBonus, saveValue, skillValue, SKILLS } from './abilities.js';
import { spellSlotsSummary } from './spellcasting.js';

/** Максимум ХП числом из строки «27» / «27 (макс)» и т.п. */
export function maxHp(char) {
  return parseInt(String((char && char.hp) || '').match(/\d+/) || '0', 10) || 0;
}

/** Бонус мастерства персонажа: из поля prof, иначе по уровню. */
export function charProfBonus(char) {
  const raw = parseInt((char && char.prof), 10);
  if (!isNaN(raw)) return raw;
  return proficiencyBonus((char && char.level) || 1);
}

/**
 * Собрать производные значения листа.
 * @param {Object} char  { level, prof, abil:{str..}, saves:{k:bool}, skills:{name:0|1|2},
 *                          hp, ac, spellcasting:{cls:[], lvls:{}} }
 * @returns {{
 *   pb:number, maxHp:number,
 *   mods:Object, modsStr:Object,
 *   saves:Array<{key,label,proficient,value,text}>,
 *   skills:Array<{name,ability,dots,value,text}>,
 *   spells:{cantripMax,knownMax,prepMax}|null
 * }}
 */
export function deriveSheet(char) {
  const c = char || {};
  const abil = c.abil || {};
  const pb = charProfBonus(c);

  const mods = {}, modsStr = {};
  ABILITIES.forEach(([k]) => { const m = abilityMod(abil[k]); mods[k] = m; modsStr[k] = fmtBonus(m); });

  const savesMap = c.saves || {};
  const saves = ABILITIES.map(([key, label]) => {
    const proficient = !!savesMap[key];
    const value = saveValue(abil[key], proficient, pb);
    return { key, label, proficient, value, text: fmtBonus(value) };
  });

  const skillsMap = c.skills || {};
  const skills = SKILLS.map(([name, ability]) => {
    const dots = Math.max(0, Math.min(2, parseInt(skillsMap[name], 10) || 0));
    const value = skillValue(abil[ability], dots, pb);
    return { name, ability, dots, value, text: fmtBonus(value) };
  });

  let spells = null;
  const sc = c.spellcasting;
  if (sc && Array.isArray(sc.cls) && sc.cls.length) {
    spells = spellSlotsSummary(sc.cls, sc.lvls || {}, c.level || 1, abil);
  }

  return { pb, maxHp: maxHp(c), mods, modsStr, saves, skills, spells };
}
