// Supabase Edge Function: рассылка web-push о новой игре.
// Дёргается сайтом, когда ГМ создаёт игру с галочкой «Оповестить».
// Читает подписки из таблицы kv (ключ "push:subs") и шлёт пуш каждому устройству.
//
// Секреты (на своём облаке — docker-compose.override.yml → services.functions.environment,
// поправить и переразвернуть: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)):
//   VAPID_PRIVATE  — приватный VAPID-ключ (СЕКРЕТ, только здесь), 43 символа base64url
//   VAPID_PUBLIC   — публичный ключ; необязателен: он и так вшит в сайт, ниже есть копия
//   VAPID_SUBJECT  — mailto:... или https://... (контакт владельца)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY подставляются платформой автоматически.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-user-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// только этим аккаунтам разрешено рассылать (тот же список, что DEV_TAGS на сайте)
const DEV = ["hinoma", "herr_teo", "arlissss"];

// Публичный ключ — тот же, что VAPID_PUBLIC в index.html. Подписки браузеров привязаны
// именно к нему; приватный ключ на сервере обязан быть из той же пары.
const SITE_VAPID_PUBLIC =
  "BJjgF7Dfj-PGEBho4AK_eec8YivMgnT5Oux8KdfLOx3sDcqpEBJ22tYzdsQ0fhx3S5IlRr-y3zTqsnOszzEpFI4";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// значение из окружения: без пробелов, переводов строк и кавычек — при ручном вводе в
// override-файл они попадают внутрь ключа, и web-push отвергает его как «не 65 байт»
const clean = (v: string | undefined | null) => (v || "").trim().replace(/^["']+|["']+$/g, "").trim();
// длина ключа после base64url-декодирования (65 байт публичный, 32 приватный); -1 = не base64
const b64len = (s: string) => {
  try { return atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)).length; }
  catch { return -1; }
};

// Раньше setVapidDetails звался при загрузке модуля: битый ключ ронял функцию целиком, и любой
// вызов отвечал 500 «event loop error». Теперь ключи проверяются здесь, а ответ объясняет, что не так.
let vapidReady = false;
function initVapid(): string {
  if (vapidReady) return "";
  const subject = clean(Deno.env.get("VAPID_SUBJECT")) || "mailto:admin@komikdnd.ru";
  let pub = clean(Deno.env.get("VAPID_PUBLIC"));
  const priv = clean(Deno.env.get("VAPID_PRIVATE"));
  if (b64len(pub) !== 65) pub = SITE_VAPID_PUBLIC;   // в окружении ключ обрезан/пуст — берём вшитый
  if (!priv) return "VAPID_PRIVATE не задан на сервере (docker-compose.override.yml → functions.environment). Почини: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)";
  const n = b64len(priv);
  if (n !== 32) return `VAPID_PRIVATE повреждён: после декодирования ${n} байт вместо 32 (ключ должен быть 43 символа base64url без кавычек). Почини: bash <(curl -fsS https://komikdnd.ru/migrate/push.sh)`;
  try { webpush.setVapidDetails(subject, pub, priv); }
  catch (e) { return "VAPID: " + ((e as Error)?.message || String(e)); }
  vapidReady = true;
  return "";
}

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("method", { status: 405, headers: cors });

  // авторизация: рассылать может только dev-аккаунт (см. DEV).
  // Пользовательский токен приходит отдельным заголовком x-user-token — так шлюз
  // проверяет только анон-ключ в Authorization и не спотыкается о новые ключи проекта.
  const jwt = (req.headers.get("x-user-token") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await supa.auth.getUser(jwt);
  const login = (u?.user?.email || "").split("@")[0].toLowerCase();
  if (!DEV.includes(login)) return new Response("forbidden", { status: 403, headers: cors });

  const vapidErr = initVapid();
  if (vapidErr) return json({ error: vapidErr }, 500);

  const body = await req.json().catch(() => ({}));
  const title = "Новая игра · " + (body.setting || "КОМИК");
  const msg = (body.game || "Открыта запись на игру") + (body.time ? " · " + body.time : "");
  // gid уходит в data уведомления (в тексте не виден) → по тапу открываем именно эту игру
  const payload = JSON.stringify({ title, body: msg, tag: "komik-game", gid: String(body.gid || "") });

  const { data: row } = await supa.from("kv").select("value").eq("key", "push:subs").maybeSingle();
  const subs: any[] = Array.isArray(row?.value) ? row!.value : [];

  let sent = 0;
  const dead: string[] = [];
  const failed: { code: number | string; msg: string }[] = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, payload); sent++; }
    catch (err: any) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) { dead.push(s.endpoint); return; } // подписка мертва — удалим
      // 401/403 от push-службы = подпись VAPID не принята: приватный ключ сервера не из той пары,
      // что публичный на сайте. Подписки оформлены под другой ключ — их надо переоформить.
      failed.push({ code: code ?? "net", msg: String(err?.body || err?.message || err).slice(0, 160) });
    }
  }));

  if (dead.length) {
    const alive = subs.filter((s) => !dead.includes(s.endpoint));
    await supa.from("kv").update({ value: alive }).eq("key", "push:subs");
  }

  const out: Record<string, unknown> = { sent, removed: dead.length, failed: failed.length };
  if (failed.length) {
    out.errors = failed.slice(0, 3);
    if (failed.some((f) => f.code === 401 || f.code === 403)) {
      out.hint = "Push-служба отвергает подпись: приватный ключ на сервере не из той пары, что VAPID_PUBLIC на сайте. Либо верни прежний приватный ключ (migrate/push.sh), либо после смены пары попроси игроков выключить и снова включить уведомления.";
    }
  }
  return json(out);
});
