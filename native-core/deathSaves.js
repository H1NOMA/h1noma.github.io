// КОМИК · core/deathSaves — чистая машина состояний спасбросков от смерти.
// Перенесено из логики rollDeathSave (index.html), но без DOM и облака: на входе
// текущее состояние и бросок, на выходе — новое состояние и итог. Идемпотентно применимо.
import { rollDie } from './dice.js';

/**
 * Применить один спасбросок от смерти.
 * @param {{s?:number, f?:number}} ds  текущие успехи/провалы (0..3)
 * @param {number} [roll]              бросок d20 (по умолчанию бросается сам)
 * @param {() => number} [rng]         генератор случайных чисел
 * @returns {{
 *   s:number, f:number,        // новые успехи/провалы
 *   roll:number,               // выпавшее значение
 *   dead:boolean,              // 3 провала
 *   stabilized:boolean,        // 3 успеха — пришёл в себя
 *   hp:number|null,            // 1, если стабилизирован (иначе null)
 *   ds:{s:number,f:number}|null, // новое состояние (null, если стабилизирован — панель убирается)
 *   tag:string                 // краткий итог для тоста
 * }}
 */
export function deathSaveStep(ds, roll, rng = Math.random) {
  const cur = ds || { s: 0, f: 0 };
  if (roll == null) roll = rollDie(20, rng);

  let s = cur.s || 0, f = cur.f || 0;
  if (roll === 20) s += 2;            // натуральная 20 — сразу на ногах (2 успеха → стабилизация)
  else if (roll === 1) f += 2;        // натуральная 1 — два провала
  else if (roll >= 10) s += 1;
  else f += 1;
  s = Math.min(3, s);
  f = Math.min(3, f);

  const dead = f >= 3;
  const stabilized = !dead && s >= 3;
  const tag = dead ? 'Смерть'
    : stabilized ? 'Стабилизация'
    : roll === 20 ? 'крит'
    : roll === 1 ? 'провал'
    : (roll >= 10 ? 'успех' : 'провал');

  return {
    s, f, roll, dead, stabilized,
    hp: stabilized ? 1 : null,
    ds: stabilized ? null : { s, f },
    tag,
  };
}

/** Можно ли ещё бросать (жив, не стабилизирован, hp<=0). */
export function canRollDeathSave(hp, ds) {
  if ((parseInt(hp, 10) || 0) > 0) return false;
  const s = (ds && ds.s) || 0, f = (ds && ds.f) || 0;
  return s < 3 && f < 3;
}
