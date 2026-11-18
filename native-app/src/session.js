// Сессия приложения: тег игрока, хранится в локальном сторе (KEYS.session, в облако не уходит).
// Даёт те же права, что и веб: isDev по DEV_TAGS из ядра.
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { KEYS, normTag, isDev } from '../../native-core/data/index.js';
import { store } from './store.js';

const SessionCtx = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSessionState] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    store.get(KEYS.session).then(v => { if (alive) { setSessionState(v || null); setReady(true); } });
    return () => { alive = false; };
  }, []);

  const value = useMemo(() => ({
    session,
    ready,
    tag: session ? normTag(session) : null,
    dev: isDev(session),
    async login(tag) {
      const t = normTag(tag);
      if (!t) return;
      await store.set(KEYS.session, t);
      setSessionState(t);
    },
    async logout() {
      await store.set(KEYS.session, null);
      setSessionState(null);
    },
  }), [session, ready]);

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error('useSession вне SessionProvider');
  return ctx;
}
