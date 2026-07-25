// Тема приложения из дизайн-токенов ядра (native-core/settings.THEME).
// Провайдер даёт текущий сеттинг, его цвета и переключатель — визуал совпадает с вебом.
// Выбранный сеттинг запоминается на устройстве (как comik:ui:project на сайте).
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { themeFor, PROJECT_ORDER, DEFAULT_PROJECT, SETTING_TITLES } from '../../native-core/index.js';
import { KEYS } from '../../native-core/data/index.js';
import { store } from './store.js';

const ThemeCtx = createContext(null);

export function ThemeProvider({ children }) {
  const [setting, setSettingState] = useState(DEFAULT_PROJECT);
  const [ready, setReady] = useState(false);   // сеттинг восстановлен с устройства

  useEffect(() => {
    let alive = true;
    store.get(KEYS.uiProject).then(v => {
      if (alive) {
        if (typeof v === 'string' && PROJECT_ORDER.includes(v)) setSettingState(v);
        setReady(true);
      }
    }).catch(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  const value = useMemo(() => ({
    setting,
    ready,
    setSetting(id) {
      setSettingState(id);
      store.set(KEYS.uiProject, id).catch(() => {});
    },
    theme: themeFor(setting),
    settings: PROJECT_ORDER,
    titles: SETTING_TITLES,
  }), [setting, ready]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error('useTheme вне ThemeProvider');
  return ctx;
}
