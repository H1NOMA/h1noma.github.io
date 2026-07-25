// КОМИК · core/data/session — аккаунты, теги, права. Чистая логика (без DOM/облака).

/** Аккаунты-разработчики: полные права во всех сеттингах. */
export const DEV_TAGS = ['hinoma', 'herr_teo'];

/** Нормализованный тег: без @, обрезан, в нижнем регистре. */
export function normTag(t) {
  return String(t || '').trim().replace(/^@+/, '').toLowerCase();
}

/** Тег текущей сессии (или null). */
export function currentTag(session) {
  return session ? normTag(session) : null;
}

/** Отображаемый тег. */
export function dispTag(t) {
  return normTag(t);
}

/** Разработчик ли текущая сессия. */
export function isDev(session) {
  return !!(session && DEV_TAGS.indexOf(normTag(session)) >= 0);
}

/** Виден ли сеттинг ASSIMILATION этой сессии (только разработчикам). */
export function assimVisible(session) {
  return DEV_TAGS.indexOf(normTag(session || '')) >= 0;
}

/**
 * Может ли сессия управлять игрой (редактировать/удалять/вести).
 * Разработчик — всеми; игрок-ГМ — только своими анонсами (owner === его тег).
 */
export function canManageGame(game, session) {
  if (isDev(session)) return true;
  return !!(game && session && normTag(game.owner || '') === currentTag(session));
}

/** Свободных мест в игре. */
export function seatsLeft(game) {
  return Math.max(0, (parseInt(game.seats, 10) || 0) - ((game.players || []).length));
}

/** Записан ли игрок (по тегу) в игру. */
export function isSignedUp(game, session) {
  const tag = currentTag(session);
  return !!(tag && (game.players || []).some(p => normTag(p.tag) === tag));
}
