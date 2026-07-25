// Единое хранилище приложения: локаль (AsyncStorage) + опционально облако (Supabase).
// Пока облако выключено (нужны ключи) — приложение полностью работает офлайн на локали.
import { createLayeredStore } from '../../native-core/data/index.js';
import { asyncLocalStore } from './asyncLocalStore.js';

// --- Облако (включить, когда будут ключи) -----------------------------------
// import { createClient } from '@supabase/supabase-js';
// import { supabaseKvStore } from '../../native-core/data/index.js';
// const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// const cloud = supabaseKvStore(supabase);
const cloud = null;
// ----------------------------------------------------------------------------

export const store = createLayeredStore({ cloud, local: asyncLocalStore() });
