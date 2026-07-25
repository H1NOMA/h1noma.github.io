// КОМИК · core/data/board — «стол»/трекер боя: ключи досок, слияние карточек, активная доска игрока.
// Чистая логика (перенесена из трекера index.html без DOM/облака).
import { normTag, currentTag, isDev } from './session.js';

/**
 * Ключ общего стола. Разработчик держит каноничную доску сеттинга (ключ = сеттинг).
 * Игрок-ГМ (только «Классика») получает СВОЮ доску `сеттинг::тег`, чтобы столы Мастеров не затирались.
 */
export function boardKey(setting, session) {
  return isDev(session) ? setting : setting + '::' + (currentTag(session) || 'gm');
}

/** Сеттинг из ключа доски: `classic::tag` → `classic`. */
export function boardProj(key) {
  return String(key || '').split('::')[0] || '';
}

/** Ключ участника: персонаж — по charId, монстр/ручной — по имени. */
export function cardKey(x) {
  return x && x.charId ? 'c:' + x.charId : 'n:' + ((x && x.name) || '');
}

/** Карточка «противника» (монстр/NPC ГМа): её ХП и КД скрыты от игроков. */
export function isFoeCard(x) {
  if (!x) return false;
  if (x.foe === true) return true;
  if (x.foe === false) return false;
  return !x.charId;
}

/**
 * Список для публикации: у врагов боевые значения ведёт ГМ (берём из локального списка),
 * у игроков ХП/инициатива/спасброски принадлежат игроку (берём из общего стола),
 * чтобы публикация ГМа не откатывала и не «воскрешала» умирающего игрока.
 * @param {Array} localList   список ГМа
 * @param {Array} sharedList  текущий общий стол
 */
export function mergeBoardList(localList, sharedList) {
  const m = {};
  (sharedList || []).forEach(p => { if (p) m[cardKey(p)] = p; });
  return (localList || []).map(x => {
    if (isFoeCard(x)) return { ...x };
    const p = m[cardKey(x)];
    return p ? { ...x, hp: p.hp, init: p.init, ds: p.ds } : { ...x };
  });
}

/**
 * Активная доска для игрока в сеттинге. Сканирует ключи `setting` и `setting::*`,
 * предпочитает доску, где стоит персонаж игрока; иначе — первую активную.
 * @param {Object} shared     карта всех общих столов { [key]: board }
 * @param {string} setting    текущий сеттинг
 * @param {Set<string>} myCharIds  id живых персонажей игрока
 * @returns {string|null} ключ доски
 */
export function activeBoardForPlayer(shared, setting, myCharIds) {
  const pref = setting + '::';
  let best = null;
  for (const k in shared) {
    if (k !== setting && k.indexOf(pref) !== 0) continue;
    const s = shared[k];
    if (!(s && s.active && Array.isArray(s.list) && s.list.length)) continue;
    const mine = s.list.some(x => x && x.charId && myCharIds && myCharIds.has(x.charId));
    if (mine) return k;
    if (!best) best = k;
  }
  return best;
}

/** Карточка текущего игрока на доске (по его id персонажей). */
export function myCardOn(board, myCharIds) {
  if (!board || !Array.isArray(board.list)) return null;
  return board.list.find(x => x && x.charId && myCharIds && myCharIds.has(x.charId)) || null;
}
