// КОМИК · core/data/sync — стратегии слияния и оптимистичная запись. Чистые функции (без облака).

/** Слить по id: к stored добавляем из local те, чьих id ещё нет. */
export function mergeById(stored, local) {
  const ids = new Set((stored || []).map(x => x && x.id));
  return (stored || []).concat((local || []).filter(x => x && !ids.has(x.id)));
}

/**
 * Слить листы персонажей по свежести (updatedAt). Удаление хранится надгробием
 * {deleted:true} и не воскресает — берётся более свежая запись при совпадении id.
 */
export function mergeByFreshness(a, b) {
  const m = new Map();
  (a || []).concat(b || []).forEach(c => {
    if (!c || !c.id) return;
    const prev = m.get(c.id);
    if (!prev || (c.updatedAt || 0) > (prev.updatedAt || 0)) m.set(c.id, c);
  });
  return [...m.values()];
}

/** Живые (не удалённые) записи. */
export function alive(list) {
  return (list || []).filter(c => c && !c.deleted);
}

/**
 * Оптимистичная точечная запись в общий ключ (паттерн «стола» ГМа/игрока):
 * применяем правку сразу, затем читаем самое свежее облако, применяем ТУ ЖЕ идемпотентную
 * правку поверх и пишем назад — так одна правка не затирает чужие.
 *
 * @param {Object} p
 * @param {Object} p.store           хранилище с get(key)/set(key,val)
 * @param {string} p.key             ключ общего объекта
 * @param {(current:any) => any} p.apply  идемпотентно меняет и ВОЗВРАЩАЕТ новое значение
 * @param {any} [p.optimistic]       локальное значение для мгновенного применения (если есть)
 * @param {(value:any) => void} [p.onChange]  колбэк для перерисовки
 * @returns {Promise<any>} итоговое записанное значение
 */
export async function optimisticApply({ store, key, apply, optimistic, onChange }) {
  // 1) мгновенно — поверх того, что уже есть локально
  let local = optimistic !== undefined ? optimistic : await store.get(key);
  local = apply(local);
  if (onChange) onChange(local);
  // 2) поверх самого свежего облака — та же правка идемпотентно
  let fresh;
  try { fresh = await store.get(key); } catch (e) { fresh = local; }
  const merged = apply(fresh == null ? local : fresh);
  try { await store.set(key, merged); } catch (e) { /* офлайн — останется локальное */ }
  if (onChange) onChange(merged);
  return merged;
}
