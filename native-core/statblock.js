// КОМИК · core/statblock — структурный статблок существ/божеств (как на сайте):
// поля сетки + разбор «строчного» досье бестиария в структуру. Без DOM.
import { fmtBonus } from './abilities.js';

/** Поля статблока в порядке вывода (как в вебе). */
export const STAT_FIELDS = [
  ['ac', 'КД'], ['hp', 'Хиты'], ['speed', 'Скорость'],
  ['str', 'СИЛ'], ['dex', 'ЛОВ'], ['con', 'ТЕЛ'], ['int', 'ИНТ'], ['wis', 'МДР'], ['cha', 'ХАР'],
  ['saves', 'Спасброски'], ['skills', 'Навыки'], ['res', 'Сопротивления'], ['imm', 'Иммунитеты'],
  ['senses', 'Чувства'], ['langs', 'Языки'], ['cr', 'Опасность'],
];
export const STAT_ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// ключи досье бестиария, уходящие в сетку (их прячем из «строчного» досье)
export const BEAST_STAT_DOS = new Set(['КД', 'Хиты', 'Скорость', 'Характеристики', 'Спасброски', 'Навыки',
  'Чувства', 'Языки', 'Опасность', 'Сопротивления', 'Сопротивление урону', 'Иммунитеты', 'Иммунитет к урону', 'Иммунитет к состояниям']);
const DOS_MAP = { 'КД': 'ac', 'Хиты': 'hp', 'Скорость': 'speed', 'Спасброски': 'saves', 'Навыки': 'skills',
  'Чувства': 'senses', 'Языки': 'langs', 'Опасность': 'cr', 'Сопротивления': 'res', 'Сопротивление урону': 'res',
  'Иммунитеты': 'imm', 'Иммунитет к урону': 'imm', 'Иммунитет к состояниям': 'imm' };
const ABIL_RU = { 'СИЛ': 'str', 'ЛОВ': 'dex', 'ТЕЛ': 'con', 'ИНТ': 'int', 'МДР': 'wis', 'ХАР': 'cha' };

/** Структурный статблок карточки: e.stat, иначе разбор досье (строка «Характеристики» → 6 полей). */
export function beastStat(card) {
  if (card.stat && Object.keys(card.stat).length) return card.stat;
  const st = {};
  (card.dossier || []).forEach(d => {
    const k = (d.k || '').trim(), v = (d.v || '').trim();
    if (!k || !v) return;
    if (k === 'Характеристики') {
      Object.keys(ABIL_RU).forEach(ru => {
        const m = v.match(new RegExp(ru + '\\s*(-?\\d+)'));
        if (m) st[ABIL_RU[ru]] = m[1];
      });
    } else if (DOS_MAP[k] && !st[DOS_MAP[k]]) st[DOS_MAP[k]] = v;
  });
  return st;
}

/** Модификатор из значения характеристики статблока («14» → «+2»); null, если не число. */
export function statModText(v) {
  const m = String(v == null ? '' : v).match(/-?\d+/);
  if (!m) return null;
  return fmtBonus(Math.floor((parseInt(m[0], 10) - 10) / 2));
}

/** Есть ли у карточки статблок для показа (бестиарий/божества). */
export function hasStatblock(card) {
  if (!card) return false;
  if (card.sub !== 'bestiary' && card.sub !== 'deities') return false;
  const st = beastStat(card);
  return STAT_FIELDS.some(([k]) => st[k]);
}
