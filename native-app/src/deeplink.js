// Deep links: сайт шлёт ссылки вида https://komikdnd.ru/?g=<id> (тап по пушу открывает игру),
// у приложения — схема komik:// (komik://g/<id>). Парсим оба формата.
let lastGameId = null;
const subs = new Set();

export const deeplink = {
  set(id) { lastGameId = id; subs.forEach(f => { try { f(id); } catch (e) {} }); },
  take() { const v = lastGameId; lastGameId = null; return v; },
  peek() { return lastGameId; },
  sub(f) { subs.add(f); return () => subs.delete(f); },
};

/** Достаёт id игры из URL: ?g=ID · komik://g/ID · …/g/ID. Нет игры → null. */
export function parseGameId(url) {
  if (!url) return null;
  try {
    const q = url.match(/[?&]g=([^&#]+)/);
    if (q) return decodeURIComponent(q[1]);
    const p = url.match(/(?:^komik:\/\/|\/)g\/([^/?#]+)/);
    if (p) return decodeURIComponent(p[1]);
  } catch (e) {}
  return null;
}
