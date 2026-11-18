// Персонажи: обёртка над charactersRepo — мои листы по сеттингам, сохранение в свой
// пер-юзерный облачный ключ (тот же, что использует сайт), удаление надгробием.
import { charactersRepo, normTag } from '../../native-core/data/index.js';
import { store } from './store.js';

const repo = charactersRepo(store);
const SETTINGS = ['legacy', 'neverland', 'assimilation', 'terra', 'classic'];
export const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Все мои листы (включая надгробия — нужны для корректной синхронизации). */
async function myMap(tag) {
  const all = await repo.loadAll();
  const mine = {};
  SETTINGS.forEach(g => { mine[g] = (all[g] || []).filter(c => c && normTag(c.owner || '') === tag); });
  return mine;
}

/** Мои живые персонажи сеттинга. */
export async function loadMyChars(setting, tag) {
  if (!tag) return [];
  const mine = await myMap(tag);
  return (mine[setting] || []).filter(c => !c.deleted);
}

/** Создать/обновить персонажа (owner проставляется, updatedAt — для слияния). */
export async function saveMyChar(setting, tag, char) {
  const mine = await myMap(tag);
  const c = { ...char, owner: tag, updatedAt: Date.now() };
  const arr = mine[setting] || (mine[setting] = []);
  const i = arr.findIndex(x => x && x.id === c.id);
  if (i >= 0) arr[i] = c; else arr.push(c);
  await repo.saveForTag(tag, mine);
  return c;
}

/** Удалить персонажа (надгробие — не воскресает при слиянии с облаком). */
export async function deleteMyChar(setting, tag, id) {
  const mine = await myMap(tag);
  const arr = mine[setting] || [];
  const i = arr.findIndex(x => x && x.id === id);
  if (i >= 0) { arr[i] = repo.tombstone(arr[i]); await repo.saveForTag(tag, mine); }
}
