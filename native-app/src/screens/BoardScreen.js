// Экран «Доска» — стол боя поверх boardRepo из ядра.
// ГМ (разработчик): ведёт локальный список участников, публикует стол и включает его для игроков.
// Игрок: видит активную доску своего сеттинга вживую (подписка на изменения стора).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, Alert } from 'react-native';
import { boardRepo, activeBoardForPlayer, isFoeCard } from '../../../native-core/data/index.js';
import { useTheme } from '../theme.js';
import { useSession } from '../session.js';
import { store } from '../store.js';

const repo = boardRepo(store);
const localKey = (setting) => 'app:board:local:' + setting;

export default function BoardScreen() {
  const { theme, setting } = useTheme();
  const { session, dev } = useSession();
  const [localList, setLocalList] = useState([]);
  const [shared, setShared] = useState({});
  const [name, setName] = useState('');

  // локальный список ГМа для сеттинга
  useEffect(() => {
    let alive = true;
    store.get(localKey(setting)).then(v => { if (alive) setLocalList(Array.isArray(v) ? v : []); });
    return () => { alive = false; };
  }, [setting]);

  // общий стол: начальная загрузка + живая подписка
  useEffect(() => {
    let alive = true;
    repo.fetchAll().then(v => { if (alive) setShared(v || {}); });
    const off = repo.subscribe(v => { if (alive) setShared(v || {}); });
    return () => { alive = false; off(); };
  }, [setting]);

  const saveLocal = useCallback(async (list) => {
    setLocalList(list);
    await store.set(localKey(setting), list);
  }, [setting]);

  const myKey = repo.keyFor(setting, session);
  const myBoard = shared[myKey];
  const active = !!(myBoard && myBoard.active);

  const publish = useCallback(async (toggle) => {
    const args = { localList, party: (myBoard && myBoard.party) || '' };
    if (toggle) await repo.toggleActive(setting, session, localList, args.party, setShared);
    else await repo.publish(setting, session, { ...args, active }, setShared);
  }, [localList, myBoard, setting, session, active]);

  const addRow = useCallback(() => {
    const t = name.trim();
    if (!t) return;
    setName('');
    saveLocal([...localList, { name: t, hp: 10, init: 0, ac: '' }]);
  }, [name, localList, saveLocal]);

  const bumpHp = useCallback((i, d) => {
    const list = localList.map((x, j) => j === i ? { ...x, hp: Math.max(0, (parseInt(x.hp, 10) || 0) + d) } : x);
    saveLocal(list);
  }, [localList, saveLocal]);

  const s = styles(theme);

  // --- игрок: только активная доска сеттинга ---
  if (!dev) {
    const key = activeBoardForPlayer(shared, setting, new Set());
    const board = key ? shared[key] : null;
    return (
      <View style={s.wrap}>
        {!board ? (
          <Text style={s.empty}>Сейчас нет активной игры. Когда ГМ начнёт сессию — здесь появится доска боя.</Text>
        ) : (
          <FlatList
            data={board.list || []}
            keyExtractor={(x, i) => String(i)}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            renderItem={({ item }) => (
              <View style={s.card}>
                <Text style={s.cardName}>{item.name}</Text>
                <Text style={s.cardStats}>
                  ИН {item.init ?? 0}{isFoeCard(item) ? '' : ` · ХП ${item.hp ?? '—'} · КД ${item.ac || '—'}`}
                </Text>
              </View>
            )}
          />
        )}
      </View>
    );
  }

  // --- ГМ ---
  return (
    <View style={s.wrap}>
      <Pressable style={[s.activeBar, active && s.activeBarOn]} onPress={() => publish(true)}>
        <Text style={[s.activeTxt, active && s.activeTxtOn]}>
          {active ? '● Доска активна — игроки видят её вживую' : '○ Сделать доску активной для игроков'}
        </Text>
      </Pressable>
      <FlatList
        data={localList}
        keyExtractor={(x, i) => String(i)}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={s.empty}>Пусто. Добавь участников ниже.</Text>}
        renderItem={({ item, index }) => (
          <View style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardName}>{item.name}</Text>
              <Text style={s.cardStats}>ИН {item.init ?? 0} · ХП {item.hp} · {isFoeCard(item) ? 'враг' : 'игрок'}</Text>
            </View>
            <Pressable style={s.hpBtn} onPress={() => bumpHp(index, -1)}><Text style={s.hpTxt}>−</Text></Pressable>
            <Pressable style={s.hpBtn} onPress={() => bumpHp(index, +1)}><Text style={s.hpTxt}>+</Text></Pressable>
            <Pressable style={s.hpBtn} onPress={() => {
              Alert.alert('Убрать участника?', item.name, [
                { text: 'Отмена' },
                { text: 'Убрать', style: 'destructive', onPress: () => saveLocal(localList.filter((_, j) => j !== index)) },
              ]);
            }}><Text style={s.hpTxt}>✕</Text></Pressable>
          </View>
        )}
      />
      <View style={s.addRow}>
        <TextInput
          style={s.input}
          placeholder="Имя существа/участника"
          placeholderTextColor={theme.muted}
          value={name}
          onChangeText={setName}
          onSubmitEditing={addRow}
        />
        <Pressable style={s.addBtn} onPress={addRow}><Text style={s.addTxt}>Добавить</Text></Pressable>
      </View>
      <Pressable style={s.publish} onPress={() => publish(false)}>
        <Text style={s.publishTxt}>Опубликовать стол</Text>
      </Pressable>
    </View>
  );
}

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg },
  empty: { color: t.muted, textAlign: 'center', marginTop: 40, paddingHorizontal: 24, lineHeight: 20 },
  activeBar: { margin: 12, marginBottom: 0, borderWidth: 1, borderColor: t.line2, borderRadius: 12, padding: 12, backgroundColor: t.surface },
  activeBarOn: { borderColor: t.accent },
  activeTxt: { color: t.dim, textAlign: 'center' },
  activeTxtOn: { color: t.accent, fontWeight: '700' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: 12 },
  cardName: { color: t.txt, fontWeight: '700' },
  cardStats: { color: t.dim, marginTop: 2, fontSize: 13 },
  hpBtn: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: t.line2, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2 },
  hpTxt: { color: t.txt, fontSize: 16, fontWeight: '700' },
  addRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12 },
  input: { flex: 1, backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: t.txt },
  addBtn: { borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: t.surface2, borderWidth: 1, borderColor: t.line2 },
  addTxt: { color: t.txt, fontWeight: '600' },
  publish: { margin: 12, borderRadius: 12, padding: 14, backgroundColor: t.accent, alignItems: 'center' },
  publishTxt: { color: t.bg, fontWeight: '800' },
});
