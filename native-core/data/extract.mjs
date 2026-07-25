// КОМИК · core/data/extract — локальный инструмент выгрузки встроенных JSON-блоков из index.html
// в отдельные ассеты для приложения. Запускаешь у себя, файлы кладутся рядом (и НЕ коммитятся —
// содержимое карточек остаётся твоим ассетом там, где уже лежит).
//
//   node native-core/data/extract.mjs [путь-к-index.html]
//
// Забирает <script id="ID" type="application/json">…</script> для набора известных блоков и
// пишет native-core/data/<ID>.json. Плюс печатает сводку (сколько карточек, какие категории).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || join(HERE, '..', '..', 'index.html');
const BLOCKS = ['core-data', 'core-bestiary', 'archive-data', 'news-data', 'chrono-data', 'hero-img-data'];

const html = readFileSync(SRC, 'utf8');

function extractBlock(id) {
  const re = new RegExp('<script id="' + id + '" type="application/json">([\\s\\S]*?)</script>');
  const m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return { __parseError: e.message }; }
}

let ok = 0;
for (const id of BLOCKS) {
  const data = extractBlock(id);
  if (data == null) { console.log(`— ${id}: не найден, пропуск`); continue; }
  if (data.__parseError) { console.log(`✗ ${id}: ошибка разбора — ${data.__parseError}`); continue; }
  const out = join(HERE, id + '.json');
  writeFileSync(out, JSON.stringify(data));
  const n = Array.isArray(data) ? data.length : Object.keys(data).length;
  const cats = Array.isArray(data) ? [...new Set(data.map(x => x && x.cat).filter(Boolean))] : [];
  console.log(`✓ ${id}.json — ${n} ${Array.isArray(data) ? 'карточек' : 'ключей'}${cats.length ? ' · категории: ' + cats.join(', ') : ''}`);
  ok++;
}
console.log(`\nГотово: ${ok}/${BLOCKS.length} блоков выгружено в native-core/data/`);
console.log('Эти .json — твой контент; они в .gitignore и не попадают в репозиторий.');
