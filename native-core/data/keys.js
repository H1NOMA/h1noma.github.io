// КОМИК · core/data/keys — ключи хранилища (совпадают с вебом, чтобы приложение читало те же данные).
export const KEYS = {
  archive: 'comik:archive:v1',
  chars:   'comik:chars:v1',      // легаси-блоб; актуально — пер-юзерные comik:chars:<тег>
  charsPrefix: 'comik:chars:',
  users:   'comik:users:v1',
  session: 'comik:session:v1',
  news:    'comik:news:v1',
  games:   'comik:games:v1',
  hero:    'comik:hero:v1',
  access:  'comik:access:v1',
  chrono:  'comik:chrono:v1',
  chronoGames: 'comik:chrono:games:v1',
  trackerShared: 'comik:tracker:shared:v1',
  bookmarks: 'comik:bm:v1',
  uiProject: 'comik:ui:project',
};

// Личные ключи — не уходят в облако (живут только на устройстве).
export const LOCAL_ONLY = new Set([KEYS.session, KEYS.access, KEYS.uiProject, KEYS.bookmarks]);

/** Общий ли ключ (идёт в облако) или личный (только локально). */
export function isSharedKey(key) {
  return !LOCAL_ONLY.has(key);
}

/** Ключ пер-юзерного листа персонажей: comik:chars:<тег>. */
export function charsKeyFor(tag) {
  return KEYS.charsPrefix + tag;
}
