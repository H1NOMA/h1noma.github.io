// Тема приложения из дизайн-токенов ядра (native-core/settings.THEME).
// Провайдер даёт текущий сеттинг, его цвета и переключатель — визуал совпадает с вебом.
import React, { createContext, useContext, useMemo, useState } from 'react';
import { themeFor, PROJECT_ORDER, DEFAULT_PROJECT, SETTING_TITLES } from '../../native-core/index.js';

const ThemeCtx = createContext(null);

export function ThemeProvider({ children }) {
  const [setting, setSetting] = useState(DEFAULT_PROJECT);
  const value = useMemo(() => ({
    setting,
    setSetting,
    theme: themeFor(setting),
    settings: PROJECT_ORDER,
    titles: SETTING_TITLES,
  }), [setting]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error('useTheme вне ThemeProvider');
  return ctx;
}
