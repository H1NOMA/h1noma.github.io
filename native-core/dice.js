// КОМИК · core/dice — чистые броски кубов (без DOM). Возвращают данные, не рисуют UI.

export const DICE = [4, 6, 8, 10, 12, 20, 100];

/** Один бросок d{sides}. rng — генератор [0,1) (по умолчанию Math.random). */
export function rollDie(sides, rng = Math.random) {
  return 1 + Math.floor(rng() * sides);
}

/**
 * Несколько одинаковых кубов. Возвращает { rolls, total, crit }.
 * crit=true, если среди d20 выпала 1 или 20.
 */
export function rollDice(count, sides, rng = Math.random) {
  const rolls = [];
  let total = 0, crit = false;
  for (let i = 0; i < count; i++) {
    const v = rollDie(sides, rng);
    rolls.push(v);
    total += v;
    if (sides === 20 && (v === 1 || v === 20)) crit = true;
  }
  return { rolls, total, crit };
}

/**
 * Бросок пула кубов из карты { [sides]: count }, напр. {6:2, 8:1, 20:1}.
 * Возвращает { total, crit, parts:[{sides,count,rolls,sum}] }.
 */
export function rollPool(pool, rng = Math.random) {
  const parts = [];
  let total = 0, crit = false;
  for (const sides of DICE) {
    const count = pool[sides] | 0;
    if (!count) continue;
    const r = rollDice(count, sides, rng);
    total += r.total;
    crit = crit || r.crit;
    parts.push({ sides, count, rolls: r.rolls, sum: r.total });
  }
  return { total, crit, parts };
}
