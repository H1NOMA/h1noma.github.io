// КОМИК · core/data/loadArchive — адаптер источника карточек. Данные приложение подаёт само
// (бандл-ассет из extract.mjs, ответ Supabase/API или встроенный тег веб-версии); ядро их не хранит.

/** Нормализует карточку к предсказуемой форме (безопасные значения по умолчанию). */
export function normalizeCard(c) {
  return {
    id: c.id,
    cat: c.cat || '', sub: c.sub || '',
    title: c.title || '', kicker: c.kicker || '', body: c.body || '',
    tags: Array.isArray(c.tags) ? c.tags : [],
    dossier: Array.isArray(c.dossier) ? c.dossier : [],
    status: c.status || 'community',
    srcbook: c.srcbook || null,
    hideIn: Array.isArray(c.hideIn) ? c.hideIn : undefined,
    // остальные поля (sections, img, table…) переносим как есть
    ...c,
  };
}

/** Приводит сырой массив (из ассета/API) к массиву нормализованных карточек. */
export function parseArchive(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(c => c && c.id).map(normalizeCard);
}

/**
 * Единый загрузчик: принимает функцию-источник, возвращающую сырой массив (sync или Promise),
 * и отдаёт нормализованные карточки. Так и веб, и приложение используют один и тот же путь.
 * @param {() => (Array|Promise<Array>)} source
 */
export async function loadArchive(source) {
  const raw = await source();
  return parseArchive(raw);
}
