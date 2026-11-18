// Единое хранилище приложения: облако Supabase (та же база, что у сайта) + локаль AsyncStorage.
// Общие ключи идут в облако с локальным зеркалом; личные (сессия) — только на устройстве.
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { createLayeredStore, supabaseKvStore } from '../../native-core/data/index.js';
import { asyncLocalStore } from './asyncLocalStore.js';

// Публичный anon-ключ — тот же, что открыт на сайте (доступ ограничивается RLS на стороне Supabase).
const SUPA_URL = 'https://xstrdpoxwbkbumigspdv.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzdHJkcG94d2JrYnVtaWdzcGR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMjg1ODIsImV4cCI6MjA5OTYwNDU4Mn0.En-AP7WJh8AZkylbM44yhhJyNcFf0-ra6M3Yu8ZxAhs';

let cloud = null;
try {
  const supabase = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
  cloud = supabaseKvStore(supabase);
} catch (e) { cloud = null; /* нет сети/клиента — работаем на локали */ }

// тяжёлые ключи (архив с картинками) — ждём дольше, как на сайте (CLOUD_TMO=15с)
export const store = createLayeredStore({ cloud, local: asyncLocalStore(), timeout: 15000 });
