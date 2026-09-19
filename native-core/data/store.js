// КОМИК · core/data/store — абстракция хранилища «ключ → значение» с realtime-подпиской.
// Веб и приложение реализуют один интерфейс, а логика репозиториев от бэкенда не зависит.
//
// Интерфейс Store:
//   get(key)            → Promise<any|null>
//   set(key, value)     → Promise<boolean>
//   getPrefix(prefix)   → Promise<Array<{key,value}>>   (для пер-юзерных ключей)
//   subscribe(key, cb)  → () => void                    (отписка; cb(value) при изменении)

import { isSharedKey } from './keys.js';

/** Промис с таймаутом (по истечении резолвится в undefined — сигнал «облако молчит»). */
export function withTimeout(promise, ms = 4000) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, ms);
    Promise.resolve(promise).then(v => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(undefined); } });
  });
}

/** Хранилище в памяти — для тестов и офлайна. Полноценно поддерживает подписки. */
export function createMemoryStore() {
  const mem = new Map();
  const subs = new Map();
  return {
    async get(key) { return mem.has(key) ? clone(mem.get(key)) : null; },
    async set(key, value) {
      mem.set(key, clone(value));
      (subs.get(key) || []).forEach(cb => { try { cb(clone(value)); } catch (e) {} });
      return true;
    },
    async getPrefix(prefix) {
      return [...mem.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: clone(value) }));
    },
    subscribe(key, cb) {
      const arr = subs.get(key) || []; arr.push(cb); subs.set(key, arr);
      return () => subs.set(key, (subs.get(key) || []).filter(x => x !== cb));
    },
  };
}

/**
 * Слоёное хранилище: общие ключи — облако с зеркалом в локальное, личные — только локальное.
 * Повторяет семантику sget/sset из веб-версии (облако с таймаутом, откат на локальный кэш).
 * @param {Object} p
 * @param {Store} p.cloud   облачное хранилище (например, supabaseKvStore) или null
 * @param {Store} p.local   локальное хранилище (memory / AsyncStorage-обёртка)
 * @param {number} [p.timeout]
 * @param {(key)=>boolean} [p.shared]  общий ли ключ (по умолчанию isSharedKey)
 */
export function createLayeredStore({ cloud, local, timeout = 4000, shared = isSharedKey }) {
  return {
    async get(key) {
      if (cloud && shared(key)) {
        const v = await withTimeout(cloud.get(key), timeout);
        if (v !== undefined) return v;              // undefined = таймаут → локальный кэш
      }
      return local.get(key);
    },
    async set(key, value) {
      if (cloud && shared(key)) {
        const ok = await withTimeout(cloud.set(key, value), timeout);
        await local.set(key, value);                // локальное зеркало для офлайна
        return ok === true;
      }
      return local.set(key, value);
    },
    async getPrefix(prefix) {
      if (cloud && cloud.getPrefix) {
        const rows = await withTimeout(cloud.getPrefix(prefix), timeout);
        if (rows !== undefined) return rows;
      }
      return local.getPrefix ? local.getPrefix(prefix) : [];
    },
    subscribe(key, cb) {
      if (cloud && shared(key) && cloud.subscribe) return cloud.subscribe(key, cb);
      if (local.subscribe) return local.subscribe(key, cb);
      return () => {};
    },
  };
}

/**
 * Адаптер Supabase: таблица `kv (key text primary key, value jsonb)` + Realtime.
 * Клиент внедряется снаружи (никакой зависимости в ядре):
 *   import { createClient } from '@supabase/supabase-js';
 *   const store = supabaseKvStore(createClient(url, anonKey));
 */
export function supabaseKvStore(client) {
  return {
    async get(key) {
      const { data, error } = await client.from('kv').select('value').eq('key', key).maybeSingle();
      if (error) throw error;
      return data ? data.value : null;
    },
    async set(key, value) {
      const { error } = await client.from('kv').upsert({ key, value });
      if (error) throw error;
      return true;
    },
    async getPrefix(prefix) {
      const like = prefix.replace(/([%_])/g, '\\$1') + '%';
      const { data, error } = await client.from('kv').select('key,value').like('key', like);
      if (error) throw error;
      return data || [];
    },
    subscribe(key, cb) {
      const ch = client.channel('kv:' + key)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'kv', filter: 'key=eq.' + key }, payload => {
          let v = payload.new && payload.new.value;
          if (v == null) return;
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return; } }
          cb(v);
        })
        .subscribe();
      return () => { try { client.removeChannel(ch); } catch (e) {} };
    },
  };
}

function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}
