// Supabase Edge Function: рассылка web-push о новой игре.
// POST — дёргает сайт, когда ГМ создаёт игру с галочкой «Оповестить» (или тест уведомлений).
// GET  — отдаёт публичный VAPID-ключ, которым сервер подписывает пуши. Сайт оформляет подписки
//        именно под него, поэтому смена пары ключей на сервере больше не требует правки сайта:
//        устройства сами переподпишутся при следующем открытии.
//
// Секреты (на своём облаке — docker-compose.override.yml → services.functions.environment,
// поправить и переразвернуть: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)):
//   VAPID_PRIVATE  — приватный VAPID-ключ (СЕКРЕТ, только здесь), 43 символа base64url
//   VAPID_SUBJECT  — mailto:... или https://... (контакт владельца)
//   VAPID_PUBLIC   — больше не нужен: публичный ключ ВЫЧИСЛЯЕТСЯ из приватного (см. ниже).
//                    Раньше его вписывали руками, он обрезался/расходился с приватным,
//                    и функция падала на каждом запросе «Vapid public key should be 65 bytes».
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY подставляются платформой автоматически.
//
// Защита рассылки: рассылать может только аккаунт команды (тег из DEV + привязка в public.devs.uid),
// тело запроса — до 8 КБ, тексты — до 120 символов, не чаще раза в 10 с; пуши уходят только
// на адреса настоящих push-служб (PUSH_HOSTS), не больше 500 штук и по 20 одновременно.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-user-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// только этим аккаунтам разрешено рассылать (тот же список, что DEV_TAGS на сайте)
const DEV = ["hinoma", "herr_teo", "arlissss"];

// ── Ограничения рассылки ──
const MAX_BODY = 8 * 1024;       // тело запроса, байт: сайт шлёт меньше 1 КБ
const MAX_TEXT = 120;            // setting / game / time, символов (заодно пуш не превысит 4 КБ)
const MAX_SUBS = 500;            // подписок за одну рассылку
const BATCH = 20;                // одновременных запросов к push-службам
const MIN_GAP_MS = 10_000;       // между рассылками
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;   // gid игры — тот же шаблон, что SAFE_ID в index.html
// push:subs может переписать любой вошедший игрок, поэтому пуши уходят только на адреса
// push-служб браузеров, а не на любой сервер из списка. Chrome и браузеры на его движке — FCM
// (fcm.googleapis.com, изредка jmt17.google.com), Firefox — Mozilla, Safari/iPhone — Apple,
// Edge — Windows (WNS). Если у какого-то браузера пуши перестали доходить, а в ответе рассылки
// растёт skipped, — его адрес нужно добавить сюда.
const PUSH_HOSTS = ["fcm.googleapis.com", "jmt17.google.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const PUSH_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com"];
const B64U = /^[A-Za-z0-9_-]+=*$/;
type Target = { endpoint: string; keys: { p256dh: string; auth: string } };

// запись из push:subs → то, что уходит в web-push; null — битая запись или чужой адрес
function pushTarget(s: any): Target | null {
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048 || !s.keys) return null;
  const { p256dh, auth } = s.keys;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100
    || !B64U.test(p256dh) || !B64U.test(auth)) return null;
  let u: URL; try { u = new URL(s.endpoint); } catch { return null; }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!PUSH_HOSTS.includes(h) && !PUSH_SUFFIXES.some((x) => h.endsWith(x))) return null;
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

// текст из запроса: только строка/число, не длиннее MAX_TEXT символов (эмодзи пополам не режем)
const cap = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? Array.from(String(v)).slice(0, MAX_TEXT).join("") : "";

// тело не больше MAX_BODY байт (null — больше): ни шлюз, ни Caddy размер запроса не ограничивают
async function readBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return null;
  if (!req.body) return "";
  const parts: Uint8Array[] = [];
  let n = 0;
  const rd = req.body.getReader();
  for (let c = await rd.read(); !c.done; c = await rd.read()) {
    n += c.value.length;
    if (n > MAX_BODY) { rd.cancel().catch(() => {}); return null; }
    parts.push(c.value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return new TextDecoder().decode(buf);
}

// Время последней рассылки. Живёт в памяти экземпляра функции (перезапуск контейнера обнуляет) —
// от двойного нажатия и от цикла с украденного аккаунта команды этого хватает.
let lastSend = 0;

// Ключ, вшитый в сайт как запасной (VAPID_PUBLIC в index.html). Только для подсказок в ответе:
// подписываем всегда ключом, вычисленным из приватного.
const SITE_VAPID_PUBLIC =
  "BJjgF7Dfj-PGEBho4AK_eec8YivMgnT5Oux8KdfLOx3sDcqpEBJ22tYzdsQ0fhx3S5IlRr-y3zTqsnOszzEpFI4";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// значение из окружения: без пробелов, переводов строк и кавычек — при ручном вводе в
// override-файл они попадают внутрь ключа
const clean = (v: string | undefined | null) => (v || "").trim().replace(/^["']+|["']+$/g, "").trim();
const b64uDecode = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
const b64len = (s: string) => { try { return b64uDecode(s).length; } catch { return -1; } };

// ── Публичный ключ P-256 из приватного скаляра: Q = d·G. Чистый BigInt, без зависимостей.
// Так пара не может «разойтись»: подпись и ключ, который видят устройства, всегда из одной пары.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G: [bigint, bigint] = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
];
const mod = (a: bigint) => { const r = a % P; return r >= 0n ? r : r + P; };
const inv = (a: bigint) => { let r = 1n, b = mod(a), e = P - 2n; while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; };
type Pt = [bigint, bigint] | null;
function add(p1: Pt, p2: Pt): Pt {
  if (!p1) return p2; if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  let l: bigint;
  if (x1 === x2) {
    if (mod(y1 + y2) === 0n) return null;
    l = mod(3n * x1 * x1 - 3n) * inv(2n * y1) % P;               // a = −3
  } else l = mod(y2 - y1) * inv(x2 - x1) % P;
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}
export function vapidPublicFromPrivate(priv: string): string {
  let bin: string; try { bin = b64uDecode(priv); } catch { return ""; }
  if (bin.length !== 32) return "";
  let d = 0n; for (let i = 0; i < 32; i++) d = (d << 8n) | BigInt(bin.charCodeAt(i));
  if (d <= 0n || d >= N) return "";
  let R: Pt = null, Q: Pt = G;
  while (d > 0n) { if (d & 1n) R = add(R, Q); Q = add(Q, Q); d >>= 1n; }
  if (!R) return "";
  const h = "04" + R[0].toString(16).padStart(64, "0") + R[1].toString(16).padStart(64, "0");
  let s = ""; for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Ключи проверяются при первом запросе, а не при загрузке модуля: раньше битый ключ ронял
// модуль целиком, и функция отвечала 500 «event loop error» даже на OPTIONS.
let vapid: { pub: string; err: string } | null = null;
function initVapid() {
  if (vapid) return vapid;
  const subject = clean(Deno.env.get("VAPID_SUBJECT")) || "mailto:admin@komikdnd.ru";
  const priv = clean(Deno.env.get("VAPID_PRIVATE"));
  const fix = " Почини на сервере: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)";
  if (!priv) return (vapid = { pub: "", err: "VAPID_PRIVATE не задан (docker-compose.override.yml → functions.environment)." + fix });
  const n = b64len(priv);
  if (n !== 32) return (vapid = { pub: "", err: `VAPID_PRIVATE повреждён: ${n} байт вместо 32 (нужно 43 символа base64url без кавычек).` + fix });
  const pub = vapidPublicFromPrivate(priv);
  if (!pub) return (vapid = { pub: "", err: "VAPID_PRIVATE не является ключом P-256." + fix });
  try { webpush.setVapidDetails(subject, pub, priv); }
  catch (e) { return (vapid = { pub: "", err: "VAPID: " + ((e as Error)?.message || String(e)) }); }
  return (vapid = { pub, err: "" });
}

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ключ для подписки: открытая информация, авторизация не нужна
  if (req.method === "GET") {
    const v = initVapid();
    if (v.err) return json({ error: v.err }, 503);
    return json({ publicKey: v.pub, site: v.pub === SITE_VAPID_PUBLIC });
  }
  if (req.method !== "POST") return new Response("method", { status: 405, headers: cors });

  // авторизация: рассылать может только dev-аккаунт (см. DEV).
  // Пользовательский токен приходит отдельным заголовком x-user-token — так шлюз
  // проверяет только анон-ключ в Authorization и не спотыкается о новые ключи проекта.
  const jwt = (req.headers.get("x-user-token") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = jwt ? await supa.auth.getUser(jwt) : { data: null };
  // только адрес вида <тег>@komikdnd.ru: регистрация открыта, и hinoma@gmail.com иначе прошёл бы как dev
  const email = (u?.user?.email || "").toLowerCase();
  const m = /^([^@]+)@komikdnd\.ru$/.exec(email);
  const login = m ? m[1] : "";
  if (!login || !DEV.includes(login)) return new Response("forbidden", { status: 403, headers: cors });

  // Тег — всего лишь имя: удалённый аккаунт команды мог бы перерегистрировать кто угодно. Поэтому
  // вдобавок нужна привязка к самому аккаунту — public.devs.uid (миграция 2026-09-27-hardening.sql).
  // Пока миграция не накатана (нет колонки uid или таблицы devs), остаётся проверка только по тегу.
  const { data: devRows, error: devErr } = await supa.from("devs").select("tag").eq("uid", u!.user!.id);
  if (devErr) {
    if (!["42703", "42P01", "PGRST204", "PGRST205"].includes(devErr.code)) {
      return json({ error: "Не удалось проверить права команды — база не ответила, попробуйте позже" }, 503);
    }
  } else if (!(devRows || []).some((r: any) => r?.tag === login)) {
    return json({ error: "Этот аккаунт не привязан к команде на сервере — рассылка запрещена" }, 403);
  }

  const v = initVapid();
  if (v.err) return json({ error: v.err }, 500);

  const raw = await readBody(req).catch(() => "");
  if (raw === null) return json({ error: "Слишком большой запрос — не больше 8 КБ" }, 413);
  let body: any = {};
  try { body = JSON.parse(raw || "{}"); } catch { /* битый JSON — как пустой запрос */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};

  const wait = lastSend + MIN_GAP_MS - Date.now();
  if (wait > 0) return json({ error: `Слишком часто — следующая рассылка через ${Math.ceil(wait / 1000)} сек` }, 429);
  lastSend = Date.now();

  const time = cap(body.time);
  const title = "Новая игра · " + (cap(body.setting) || "КОМИК");
  const msg = (cap(body.game) || "Открыта запись на игру") + (time ? " · " + time : "");
  // gid уходит в data уведомления (в тексте не виден) → по тапу открываем именно эту игру
  const gid = SAFE_ID.test(String(body.gid ?? "")) ? String(body.gid) : "";
  const payload = JSON.stringify({ title, body: msg, tag: "komik-game", gid });

  const { data: row } = await supa.from("kv").select("value").eq("key", "push:subs").maybeSingle();
  const all: any[] = Array.isArray(row?.value) ? row!.value : [];
  // только адреса push-служб, без повторов и не больше MAX_SUBS; остальное пропускаем (skipped)
  const subs: Target[] = [];
  const seen = new Set<string>();
  for (const s of all) {
    const t = pushTarget(s);
    if (!t || seen.has(t.endpoint) || subs.length >= MAX_SUBS) continue;
    seen.add(t.endpoint);
    subs.push(t);
  }

  let sent = 0;
  const dead = new Set<string>();
  const failed: { code: number | string; msg: string }[] = [];
  // пачками по BATCH: сотни одновременных запросов подвесили бы функцию
  for (let i = 0; i < subs.length; i += BATCH) {
    await Promise.all(subs.slice(i, i + BATCH).map(async (s) => {
      try { await webpush.sendNotification(s, payload, { TTL: 86400, urgency: "high", timeout: 10000 }); sent++; }
      catch (err: any) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) { dead.add(s.endpoint); return; } // подписка мертва — удалим
        // 401/403 от push-службы = подпись не принята: подписка оформлена под другой ключ.
        // Устройство переоформит её само при следующем открытии сайта.
        failed.push({ code: code ?? "net", msg: String(err?.body || err?.message || err).slice(0, 160) });
      }
    }));
  }

  if (dead.size) {
    // перечитываем перед записью: пока шла рассылка, кто-то мог подписаться — его не теряем
    const { data: fresh } = await supa.from("kv").select("value").eq("key", "push:subs").maybeSingle();
    const cur: any[] = Array.isArray(fresh?.value) ? fresh!.value : all;
    await supa.from("kv").update({ value: cur.filter((s) => s && !dead.has(s.endpoint)) }).eq("key", "push:subs");
  }

  const out: Record<string, unknown> = {
    sent, removed: dead.size, failed: failed.length, total: subs.length, skipped: all.length - subs.length,
  };
  if (failed.length) {
    out.errors = failed.slice(0, 3);
    if (failed.some((f) => f.code === 401 || f.code === 403)) {
      out.hint = "Часть устройств подписана под прежний ключ. Они переподпишутся сами, когда откроют сайт; " +
        "пока этого не случилось, уведомление до них не дойдёт.";
    }
  }
  return json(out);
});
