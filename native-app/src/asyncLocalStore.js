// Адаптер AsyncStorage под интерфейс Store из native-core/data.
// Это «локальный» слой; облачный (Supabase) подключается отдельно в store.js.
import AsyncStorage from '@react-native-async-storage/async-storage';

export function asyncLocalStore() {
  const subs = new Map();
  return {
    async get(key) {
      const v = await AsyncStorage.getItem(key);
      return v == null ? null : safeParse(v);
    },
    async set(key, value) {
      await AsyncStorage.setItem(key, JSON.stringify(value));
      (subs.get(key) || []).forEach(cb => { try { cb(value); } catch (e) {} });
      return true;
    },
    async getPrefix(prefix) {
      const keys = await AsyncStorage.getAllKeys();
      const hit = keys.filter(k => k.startsWith(prefix));
      const pairs = await AsyncStorage.multiGet(hit);
      return pairs.map(([key, value]) => ({ key, value: value == null ? null : safeParse(value) }));
    },
    subscribe(key, cb) {
      const arr = subs.get(key) || []; arr.push(cb); subs.set(key, arr);
      return () => subs.set(key, (subs.get(key) || []).filter(x => x !== cb));
    },
  };
}

function safeParse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
