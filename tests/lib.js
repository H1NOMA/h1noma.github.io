/* Общие помощники браузерных проверок КОМИК (Playwright + стенд tests/mock_cloud.py).
   Страница ходит в стенд вместо облака: адрес подменяется через localStorage['comik:cloud']. */
const { chromium } = require('playwright');

const BASE = process.env.KOMIK_BASE || 'http://127.0.0.1:8765';
const PHONE = { width: 390, height: 844 }, DESK = { width: 1440, height: 900 };

async function launch() { return chromium.launch(); }

/* новая «чистая» вкладка: своё хранилище, облако → стенд; errs — ошибки страницы и консоли */
async function openPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || PHONE, serviceWorkers: opts.sw ? 'allow' : 'block' });
  const cloud = JSON.stringify({ url: BASE, key: 'anon' });
  await ctx.addInitScript(([cloud, project, extra]) => {
    try {
      if (!sessionStorage.getItem('__komik_init')) {
        sessionStorage.setItem('__komik_init', '1');
        localStorage.setItem('comik:cloud', cloud);
        if (project) localStorage.setItem('comik:ui:project', JSON.stringify(project));
        Object.entries(extra || {}).forEach(([k, v]) => localStorage.setItem(k, v));
      }
    } catch (e) {}
  }, [cloud, opts.project || '', opts.storage || {}]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|realtime|websocket|404 \(Not Found\)/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(BASE + '/' + (opts.query || ''), { waitUntil: 'load' });
  await waitBoot(page);
  return { ctx, page, errs };
}

async function waitBoot(page) {
  await page.waitForFunction(() => typeof SESSION_READY !== 'undefined' && SESSION_READY === true, null, { timeout: 30000 });
  await page.waitForTimeout(400);
}

async function login(page, tag, pass = 'password123') {
  await page.evaluate(() => openAuth('login'));
  // openAuth через 60 мс ставит фокус в логин: если это случится посреди ввода пароля, пароль уедет в логин
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'au-tag', null, { timeout: 5000 });
  await page.fill('#au-tag', tag);
  await page.fill('#au-pass', pass);
  await page.evaluate(() => doLogin());
  await page.waitForFunction(t => typeof currentTag === 'function' && currentTag() === t, tag, { timeout: 15000 });
  await page.waitForTimeout(600);
}

async function mock(path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  return r.json();
}
const rows = async () => Object.fromEntries((await mock('/__mock/rows')).map(r => [r.key, r.value]));

let FAILS = 0;
function check(cond, msg) { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) FAILS++; }
function done() { console.log(FAILS ? `ИТОГ: провалов ${FAILS}` : 'ИТОГ: всё прошло'); process.exitCode = FAILS ? 1 : 0; }

module.exports = { BASE, PHONE, DESK, launch, openPage, waitBoot, login, mock, rows, check, done };
