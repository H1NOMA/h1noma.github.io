/* Синтаксис всех встроенных <script> в index.html и sw.js: node tests/syntax.js */
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let n = 0, bad = 0;
for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  const attrs = m[1] || '';
  if (/type="application\/json"/.test(attrs) || /\bsrc=/.test(attrs)) continue;
  n++;
  try { new vm.Script(m[2], { filename: 'index.html#script' + n }); }
  catch (e) { bad++; const line = html.slice(0, m.index).split('\n').length; console.log(`✗ скрипт №${n} (строка ${line}): ${e.message}`); }
}
try { new vm.Script(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), { filename: 'sw.js' }); }
catch (e) { bad++; console.log('✗ sw.js: ' + e.message); }
console.log(bad ? `ИТОГ: ошибок ${bad}` : `ИТОГ: синтаксис в порядке (скриптов: ${n} + sw.js)`);
process.exitCode = bad ? 1 : 0;
