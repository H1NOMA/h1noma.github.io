// Демо-данные каркаса — полностью выдуманные (никакого контента из архива).
// В боевой версии персонажи приходят из репозиториев (Supabase), карточки — из бандла extract.mjs.

export const SAMPLE_CHARACTER = {
  id: 'demo-1',
  name: 'Тестовый герой',
  role: 'Бард 5',
  level: 5,
  hp: '38',
  ac: '15',
  abil: { str: 10, dex: 16, con: 14, int: 12, wis: 8, cha: 18 },
  saves: { dex: true, cha: true },
  skills: { 'Акробатика': 1, 'Выступление': 2, 'Убеждение': 1 },
  spellcasting: { cls: ['Бард'], lvls: { 'Бард': 5 } },
};

// Синтетические карточки только для демонстрации фильтров/поиска.
export const SAMPLE_CARDS = [
  { id: 'd-w1', cat: 'items', sub: 'weapons', title: 'Учебный клинок', kicker: 'Простое рукопашное', status: 'official', srcbook: 'PHB', tags: ['демо'], dossier: [{ k: 'Урон', v: '1d6' }] },
  { id: 'd-w2', cat: 'items', sub: 'weapons', title: 'Тренировочный молот', kicker: 'Простое рукопашное', status: 'official', srcbook: 'PHB', tags: ['демо'], dossier: [{ k: 'Урон', v: '1d8' }] },
  { id: 'd-m1', cat: 'items', sub: 'magic', title: 'Демо-амулет', status: 'community', srcbook: 'HB', dossier: [{ k: 'Редкость', v: 'Редкая' }] },
  { id: 'd-s1', cat: 'spells', sub: 'lvl1', title: 'Пример заговора', kicker: 'Иллюзия', status: 'official', srcbook: 'PHB', tags: ['демо'] },
  { id: 'd-r1', cat: 'character', sub: 'races', title: 'Народ образца', kicker: 'Раса', status: 'official', srcbook: 'PHB' },
];
