// Supabase Edge Function: рассылка web-push о новой игре.
// Дёргается сайтом, когда ГМ создаёт игру с галочкой «Оповестить».
// Читает подписки из таблицы kv (ключ "push:subs") и шлёт пуш каждому устройству.
//
// Секреты (задать через `supabase secrets set` — см. README):
//   VAPID_PUBLIC   — публичный VAPID-ключ (тот же, что вшит в сайт)
//   VAPID_PRIVATE  — приватный VAPID-ключ (СЕКРЕТ, только здесь)
//   VAPID_SUBJECT  — mailto:... или https://... (контакт владельца)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY подставляются платформой автоматически.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-user-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// только этим аккаунтам разрешено рассылать
const DEV = ["hinoma", "herr_teo"];

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:admin@komikdnd.ru",
  Deno.env.get("VAPID_PUBLIC")!,
  Deno.env.get("VAPID_PRIVATE")!,
);

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("method", { status: 405, headers: cors });

  // авторизация: рассылать может только dev-аккаунт (hinoma / herr_teo).
  // Пользовательский токен приходит отдельным заголовком x-user-token — так шлюз
  // проверяет только анон-ключ в Authorization и не спотыкается о новые ключи проекта.
  const jwt = (req.headers.get("x-user-token") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await supa.auth.getUser(jwt);
  const login = (u?.user?.email || "").split("@")[0].toLowerCase();
  if (!DEV.includes(login)) return new Response("forbidden", { status: 403, headers: cors });

  const body = await req.json().catch(() => ({}));
  const title = "Новая игра · " + (body.setting || "КОМИК");
  const msg = (body.game || "Открыта запись на игру") + (body.time ? " · " + body.time : "");
  // gid уходит в data уведомления (в тексте не виден) → по тапу открываем именно эту игру
  const payload = JSON.stringify({ title, body: msg, tag: "komik-game", gid: String(body.gid || "") });

  const { data: row } = await supa.from("kv").select("value").eq("key", "push:subs").maybeSingle();
  const subs: any[] = Array.isArray(row?.value) ? row!.value : [];

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, payload); sent++; }
    catch (err: any) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint); // подписка мертва — удалим
    }
  }));

  if (dead.length) {
    const alive = subs.filter((s) => !dead.includes(s.endpoint));
    await supa.from("kv").update({ value: alive }).eq("key", "push:subs");
  }

  return new Response(JSON.stringify({ sent, removed: dead.length }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
