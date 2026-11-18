// КОМИК · core/settings — сеттинги: порядок, названия, ядро SRD и дизайн-токены тем.
// Токены перенесены 1:1 из CSS-переменных index.html — их можно скормить теме React Native
// (StyleSheet / styled-components / любой провайдер темы), чтобы визуал совпадал с вебом.

/** Порядок сеттингов (как в шапке; первый — стартовый для новичка). */
export const PROJECT_ORDER = ['classic', 'terra', 'legacy', 'neverland', 'assimilation'];

/** Стартовый сеттинг для первого визита. */
export const DEFAULT_PROJECT = 'classic';

/** Человекочитаемые названия (чистый текст, без разметки). */
export const SETTING_TITLES = {
  legacy: 'LEGACY',
  neverland: 'NEVERLAND',
  assimilation: 'ASSIMILATION',
  terra: 'TERRA AETERNA',
  classic: 'КЛАССИКА',
};

/** Сеттинги с ядром правил SRD (у ASSIMILATION своего ядра нет). */
export const CORE_GAMES = ['legacy', 'neverland', 'terra', 'classic'];
export const isCoreGame = (id) => CORE_GAMES.indexOf(id) >= 0;

/** Виден только владельцам-разработчикам. */
export const isSettingRestricted = (id) => id === 'assimilation';

// Дизайн-токены темы по сеттингу (значения из CSS index.html).
// accent — основной акцент (в CSS это --red), accentRgb — тот же цвет в "r,g,b".
export const THEME = {
  assimilation: {
    bg: '#191b23', bg2: '#20232c', surface: '#282b36', surface2: '#333744',
    line: 'rgba(255,255,255,.13)', line2: 'rgba(255,255,255,.24)',
    txt: '#e9e9f0', dim: '#c3c3d1', muted: '#9d9dac',
    accent: '#ff4757', accentDim: '#e62e3f', accentRgb: '255,71,87',
    header: 'rgba(25,27,35,.92)', glass: 'rgba(40,43,54,.72)', glass2: 'rgba(51,55,68,.82)',
  },
  legacy: {
    bg: '#191436', bg2: '#221b45', surface: '#2b2354', surface2: '#382e68',
    line: 'rgba(190,180,255,.16)', line2: 'rgba(190,180,255,.3)',
    txt: '#e9e5fa', dim: '#c9c2ef', muted: '#a59ed1',
    accent: '#a78bfa', accentDim: '#8b6ef0', accentRgb: '167,139,250',
    header: 'rgba(25,20,54,.92)', glass: 'rgba(34,27,69,.72)', glass2: 'rgba(43,35,84,.82)',
  },
  neverland: {
    bg: '#231b0d', bg2: '#2e2412', surface: '#3a2e18', surface2: '#493a1f',
    line: 'rgba(255,220,140,.16)', line2: 'rgba(255,220,140,.3)',
    txt: '#f2ebd8', dim: '#decfae', muted: '#bba97f',
    accent: '#ffd970', accentDim: '#e8c157', accentRgb: '255,217,112',
    header: 'rgba(35,27,13,.92)', glass: 'rgba(46,36,18,.74)', glass2: 'rgba(58,46,24,.84)',
  },
  terra: {
    bg: '#22201b', bg2: '#2b2823', surface: '#35322b', surface2: '#423e35',
    line: 'rgba(235,225,200,.15)', line2: 'rgba(235,225,200,.28)',
    txt: '#ece6d7', dim: '#d2cab6', muted: '#aba28d',
    accent: '#e8dcbf', accentDim: '#cbbf9d', accentRgb: '232,220,191',
    header: 'rgba(34,32,27,.92)', glass: 'rgba(43,40,35,.74)', glass2: 'rgba(53,50,43,.84)',
  },
  classic: {
    bg: '#0c110d', bg2: '#111811', surface: '#171f17', surface2: '#212b20',
    line: 'rgba(196,164,96,.14)', line2: 'rgba(196,164,96,.26)',
    txt: '#efe8d6', dim: '#cec8b4', muted: '#8f9585',
    accent: '#d3a84a', accentDim: '#bb9236', accentRgb: '211,168,74',
    header: 'rgba(12,17,13,.92)', glass: 'rgba(17,24,17,.74)', glass2: 'rgba(23,31,23,.84)',
  },
};

/** Шрифтовые семейства базовой темы (для загрузки/подмены в приложении). */
export const FONTS = {
  display: 'Chakra Petch',
  mono: 'Share Tech Mono',
  body: 'Inter',
};

/** Токены темы сеттинга с безопасным фолбэком на ASSIMILATION. */
export function themeFor(setting) {
  return THEME[setting] || THEME.assimilation;
}
