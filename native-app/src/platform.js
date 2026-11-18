// Платформенное: пуш-уведомления (Expo push token → облако) и удаление аккаунта.
import * as Notifications from 'expo-notifications';
import { charactersRepo, normTag } from '../../native-core/data/index.js';
import { store } from './store.js';

const KEY_APP_PUSH = 'comik:apppush:v1';   // карта тег → { token, at } для рассылки с сервера
const SETTINGS = ['legacy', 'neverland', 'assimilation', 'terra', 'classic'];

/**
 * Включить пуши: запросить разрешение, получить Expo push token и записать его в облако
 * под тегом игрока. Отправку делает сервер (Supabase Edge Function / бот) по этой карте.
 * @returns {{ok:boolean, reason?:string, token?:string}}
 */
export async function enablePush(tag) {
  try {
    const perm = await Notifications.requestPermissionsAsync();
    if (perm.status !== 'granted') return { ok: false, reason: 'denied' };
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    const map = (await store.get(KEY_APP_PUSH)) || {};
    map[normTag(tag)] = { token, at: Date.now() };
    await store.set(KEY_APP_PUSH, map);
    return { ok: true, token };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/** Выключить пуши: убрать свой токен из облачной карты. */
export async function disablePush(tag) {
  try {
    const map = (await store.get(KEY_APP_PUSH)) || {};
    delete map[normTag(tag)];
    await store.set(KEY_APP_PUSH, map);
  } catch (e) {}
}

/** Включены ли пуши для тега (токен лежит в карте). */
export async function pushEnabled(tag) {
  try {
    const map = (await store.get(KEY_APP_PUSH)) || {};
    return !!map[normTag(tag)];
  } catch (e) { return false; }
}

/**
 * Удаление аккаунта (требование сторов): надгробия на все свои листы во всех сеттингах
 * (синхронизируется с сайтом), удаление пуш-токена. Сессию чистит вызывающий (logout).
 */
export async function deleteAccountData(tag) {
  const t = normTag(tag);
  const repo = charactersRepo(store);
  const all = await repo.loadAll();
  const mine = {};
  SETTINGS.forEach(g => {
    mine[g] = (all[g] || [])
      .filter(c => c && normTag(c.owner || '') === t)
      .map(c => c.deleted ? c : repo.tombstone(c));
  });
  await repo.saveForTag(t, mine);
  await disablePush(t);
}
