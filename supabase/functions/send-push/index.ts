// КОМИК · Supabase Edge Function: рассылка пушей приложения о новой игре.
// Приложение складывает Expo push-токены в kv-ключ comik:apppush:v1 (тег → {token, at});
// эта функция читает карту и шлёт уведомление всем через Expo Push API.
//
// Деплой:   supabase functions deploy send-push --no-verify-jwt
// Секреты:  supabase secrets set PUSH_SECRET=<придумай-строку>
// Вызов:    POST https://<project>.supabase.co/functions/v1/send-push
//           { "secret": "...", "title": "КОМИК", "body": "Новая игра: ...", "gid": "gm123" }
// gid не обязателен — если есть, тап по пушу откроет игру (deep link ?g=gid).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') return new Response('POST only', { status: 405 });
    const { secret, title, body, gid } = await req.json();

    if (!secret || secret !== Deno.env.get('PUSH_SECRET')) {
      return new Response('forbidden', { status: 403 });
    }

    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data, error } = await supa.from('kv').select('value').eq('key', 'comik:apppush:v1').maybeSingle();
    if (error) throw error;

    let map = data?.value ?? {};
    if (typeof map === 'string') { try { map = JSON.parse(map); } catch { map = {}; } }
    const tokens = Object.values(map as Record<string, { token?: string }>)
      .map((v) => v?.token)
      .filter((t): t is string => typeof t === 'string' && t.startsWith('ExponentPushToken'));

    if (!tokens.length) return Response.json({ ok: true, sent: 0 });

    // Expo принимает до 100 сообщений за запрос
    let sent = 0;
    for (let i = 0; i < tokens.length; i += 100) {
      const chunk = tokens.slice(i, i + 100).map((to) => ({
        to,
        title: title || 'КОМИК',
        body: body || 'Новая игра',
        sound: 'default',
        data: gid ? { url: 'https://komikdnd.ru/?g=' + gid, gid } : {},
      }));
      const r = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      if (r.ok) sent += chunk.length;
    }
    return Response.json({ ok: true, sent });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
