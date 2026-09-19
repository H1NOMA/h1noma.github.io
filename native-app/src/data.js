// Реальные данные приложения: бандл карточек (ядро SRD + бестиарий + встроенный архив сайта)
// + пользовательский архив и правки ядра из облака. Сливается тем же кодом, что и на сайте.
import { KEYS, alive } from '../../native-core/data/index.js';
import { coreForSetting } from '../../native-core/index.js';

let CORE_CACHE = null;
let EMB_CACHE = null;

/** Ядро карточек (SRD + бестиарий). Лениво: JSON.parse тяжёлых бандлов — при первом обращении. */
export function getCore() {
  if (!CORE_CACHE) {
    const core = require('../assets/data/core-data.json');
    const beasts = require('../assets/data/core-bestiary.json');
    CORE_CACHE = core.concat(beasts);
  }
  return CORE_CACHE;
}

/** Встроенные пользовательские карточки сайта (карта по сеттингам). */
export function getEmbeddedArchive() {
  if (!EMB_CACHE) EMB_CACHE = require('../assets/data/archive-data.json') || {};
  return EMB_CACHE;
}

/**
 * Полный архив сеттинга: пользовательские карточки (облако + встроенные, без надгробий)
 * + ядро с учётом облачных правок/скрытий (CORE_OVER) и блокировок источников.
 */
export async function loadArchiveFor(setting, store) {
  let cloudMap = {}, over = {};
  try { cloudMap = (await store.get(KEYS.archive)) || {}; } catch (e) {}
  try { over = (await store.get('comik:coreover:v1')) || {}; } catch (e) {}
  const emb = getEmbeddedArchive();
  const cloud = Array.isArray(cloudMap[setting]) ? cloudMap[setting] : [];
  const embedded = Array.isArray(emb[setting]) ? emb[setting] : [];
  const ids = new Set(cloud.map(c => c && c.id));
  const user = alive(cloud.concat(embedded.filter(c => c && !ids.has(c.id))));
  const core = coreForSetting(getCore(), setting, over && typeof over === 'object' ? over : {});
  return user.concat(core);
}
