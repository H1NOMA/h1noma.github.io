// КОМИК · core/data/repositories — высокоуровневые репозитории поверх Store.
// Собирают вместе хранилище, слияния и права. Один и тот же код для веба и приложения.
import { KEYS, charsKeyFor } from './keys.js';
import { mergeById, mergeByFreshness, optimisticApply } from './sync.js';
import { canManageGame, seatsLeft, currentTag, normTag } from './session.js';
import { boardKey, mergeBoardList } from './board.js';

const SETTINGS = ['legacy', 'neverland', 'assimilation', 'terra', 'classic'];
const emptyBySetting = () => ({ legacy: [], neverland: [], assimilation: [], terra: [], classic: [] });
const now = () => Date.now();

/** Привести значение к карте по сеттингам (легаси-блоб мог быть плоским массивом assimilation). */
function asSettingMap(v) {
  const out = emptyBySetting();
  if (Array.isArray(v)) { out.assimilation = v; return out; }
  if (v && typeof v === 'object') SETTINGS.forEach(g => { if (Array.isArray(v[g])) out[g] = v[g]; });
  return out;
}

/** Персонажи: пер-юзерные ключи comik:chars:<тег> + легаси-блоб, слияние по свежести. */
export function charactersRepo(store) {
  return {
    /** Собрать все листы из облака/локального: { [setting]: Character[] }. */
    async loadAll() {
      const merged = emptyBySetting();
      let rows = [];
      try { rows = await store.getPrefix(KEYS.charsPrefix); } catch (e) { rows = []; }
      for (const r of rows || []) {
        let v = r && r.value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { continue; } }
        const rm = asSettingMap(v);
        SETTINGS.forEach(g => { merged[g] = mergeByFreshness(merged[g], rm[g]); });
      }
      return merged;
    },
    /** Сохранить листы конкретного игрока (его пер-юзерный ключ). */
    async saveForTag(tag, bySetting) {
      return store.set(charsKeyFor(normTag(tag)), bySetting);
    },
    /** Пометить персонажа удалённым (надгробие, не воскресает при слиянии). */
    tombstone(char) {
      return { ...char, deleted: true, updatedAt: now() };
    },
  };
}

/** Игры/расписание: список, запись, отмена, кик, завершение — с проверкой прав. */
export function gamesRepo(store) {
  const list = async () => (await store.get(KEYS.games)) || [];
  const save = (games) => store.set(KEYS.games, games);
  return {
    list, save,
    /** Игры, которыми управляет сессия (разработчик — все; игрок-ГМ — свои). */
    async managedBy(session) {
      return (await list()).filter(g => canManageGame(g, session));
    },
    /** Записать игрока в игру (если есть места и ещё не записан). */
    async signup(gameId, session, { name, charId = '', charName = '' }) {
      const games = await list();
      const g = games.find(x => x && x.id === gameId);
      if (!g) return { ok: false, reason: 'not-found' };
      if (seatsLeft(g) <= 0) return { ok: false, reason: 'full' };
      const tag = currentTag(session);
      g.players = (g.players || []).filter(p => normTag(p.tag) !== tag);
      g.players.push({ tag: session, name, charId, charName, at: now() });
      await save(games);
      return { ok: true, game: g };
    },
    /** Отменить свою запись. */
    async cancel(gameId, session) {
      const games = await list();
      const g = games.find(x => x && x.id === gameId);
      if (!g) return { ok: false };
      const tag = currentTag(session);
      g.players = (g.players || []).filter(p => normTag(p.tag) !== tag);
      await save(games);
      return { ok: true, game: g };
    },
    /** Убрать запись игрока (только владелец игры/разработчик). */
    async kick(gameId, index, session) {
      const games = await list();
      const g = games.find(x => x && x.id === gameId);
      if (!g || !g.players) return { ok: false };
      if (!canManageGame(g, session)) return { ok: false, reason: 'forbidden' };
      g.players.splice(index, 1);
      await save(games);
      return { ok: true, game: g };
    },
    /** Завершить и убрать игру (только владелец/разработчик). */
    async played(gameId, session) {
      const games = await list();
      const g = games.find(x => x && x.id === gameId);
      if (!g) return { ok: false };
      if (!canManageGame(g, session)) return { ok: false, reason: 'forbidden' };
      await save(games.filter(x => x && x.id !== gameId));
      return { ok: true, game: g };
    },
  };
}

/** Новости: список и сохранение (слияние по id при подтягивании встроенных). */
export function newsRepo(store) {
  return {
    async list() { return (await store.get(KEYS.news)) || []; },
    async save(news) { return store.set(KEYS.news, news); },
    merge(stored, embedded) { return mergeById(stored, embedded); },
  };
}

/** «Стол»/доска боя: чтение общих столов, публикация ГМа, точечная правка игрока, подписка. */
export function boardRepo(store) {
  const key = KEYS.trackerShared;
  const fetchAll = async () => (await store.get(key)) || {};
  return {
    fetchAll,
    /** Ключ доски текущей сессии в сеттинге. */
    keyFor(setting, session) { return boardKey(setting, session); },
    /**
     * Опубликовать/обновить свой стол: сливает игроков из свежего облака, врагов берёт из локального.
     * @param {Array} localList  список ГМа
     */
    async publish(setting, session, { localList, party, active }, onChange) {
      const bk = boardKey(setting, session);
      return optimisticApply({
        store, key,
        onChange,
        apply(sharedMap) {
          sharedMap = sharedMap || {};
          const prev = sharedMap[bk] || {};
          const merged = mergeBoardList(localList, prev.list || []);
          sharedMap[bk] = { list: merged, party, at: now(), active: active != null ? active : !!prev.active, owner: currentTag(session) };
          return sharedMap;
        },
      });
    },
    /** Переключить активность своей доски (игроки видят её вживую). */
    async toggleActive(setting, session, localList, party, onChange) {
      const bk = boardKey(setting, session);
      return optimisticApply({
        store, key, onChange,
        apply(sharedMap) {
          sharedMap = sharedMap || {};
          const cur = !!(sharedMap[bk] && sharedMap[bk].active);
          sharedMap[bk] = { list: mergeBoardList(localList, (sharedMap[bk] || {}).list || []), party, at: now(), active: !cur, owner: currentTag(session) };
          return sharedMap;
        },
      });
    },
    /**
     * Точечная правка одной карточки на доске (моё ХП/иниц/спасбросок) — идемпотентно,
     * чтобы не затереть чужие. mutate(card) меняет найденную карточку.
     */
    async applyToCard(boardK, cardId, mutate, onChange) {
      return optimisticApply({
        store, key, onChange,
        apply(sharedMap) {
          sharedMap = sharedMap || {};
          const b = sharedMap[boardK];
          if (b && Array.isArray(b.list)) {
            const c = b.list.find(x => x && x.charId === cardId);
            if (c) { mutate(c); b.at = now(); }
          }
          return sharedMap;
        },
      });
    },
    /** Подписка на изменения общих столов (Realtime). cb(sharedMap). */
    subscribe(cb) { return store.subscribe(key, cb); },
  };
}
