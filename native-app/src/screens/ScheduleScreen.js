// Экран «Игры» — расписание поверх gamesRepo из ядра.
// Игрок: записывается/отменяет запись. ГМ (разработчик): создаёт игру, убирает записи, завершает.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, Alert } from 'react-native';
import { gamesRepo, seatsLeft, isSignedUp, canManageGame } from '../../../native-core/data/index.js';
import { useTheme } from '../theme.js';
import { useSession } from '../session.js';
import { store } from '../store.js';
import { loadMyChars } from '../chars.js';
import { deeplink } from '../deeplink.js';

const repo = gamesRepo(store);
const uid = () => 'gm' + Date.now().toString(36);

export default function ScheduleScreen() {
  const { theme, setting } = useTheme();
  const { session, tag, dev } = useSession();
  const [games, setGames] = useState([]);
  const [myChars, setMyChars] = useState([]);
  const [title, setTitle] = useState('');
  const [hotId, setHotId] = useState(deeplink.peek());   // игра из deep link — подсветить

  useEffect(() => deeplink.sub(id => setHotId(id)), []);

  const reload = useCallback(async () => {
    const all = await repo.list();
    setGames(all.filter(g => g && g.game === setting));
    setMyChars(tag ? await loadMyChars(setting, tag) : []);
  }, [setting, tag]);

  useEffect(() => { reload(); }, [reload]);

  const createGame = useCallback(async () => {
    const t = title.trim();
    if (!t || !dev) return;
    const all = await repo.list();
    all.push({ id: uid(), game: setting, owner: tag, title: t, seats: 5, players: [], createdAt: Date.now() });
    await repo.save(all);
    setTitle('');
    reload();
  }, [title, dev, setting, tag, reload]);

  const s = styles(theme);

  return (
    <View style={s.wrap}>
      <FlatList
        data={games}
        keyExtractor={g => g.id}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        ListEmptyComponent={<Text style={s.empty}>Свежих объявлений нет. Кто соберёт отряд первым?</Text>}
        renderItem={({ item }) => {
          const free = seatsLeft(item);
          const mine = isSignedUp(item, session);
          const manage = canManageGame(item, session);
          return (
            <View style={[s.card, hotId === item.id && { borderColor: theme.accent, borderWidth: 1.5 }]}>
              <Text style={s.title}>{item.title || 'Сессия'}</Text>
              <Text style={s.meta}>Мест {free}/{item.seats || 0}{item.time ? ` · ${item.time}` : ''}</Text>
              {(item.players || []).length > 0 && (
                <Text style={s.players}>{(item.players || []).map(p => p.name || p.tag).join(', ')}</Text>
              )}
              <View style={s.actRow}>
                {session && !mine && free > 0 && (
                  <Pressable style={s.btnPrimary} onPress={async () => {
                    // первый свой персонаж сеттинга прикрепляется к записи автоматически (как имя героя)
                    const ch = myChars[0];
                    await repo.signup(item.id, session, ch
                      ? { name: ch.name, charId: ch.id, charName: ch.name }
                      : { name: tag });
                    reload();
                  }}><Text style={s.btnPrimaryTxt}>Записаться{myChars[0] ? ` (${myChars[0].name})` : ''}</Text></Pressable>
                )}
                {session && mine && (
                  <Pressable style={s.btnGhost} onPress={async () => {
                    await repo.cancel(item.id, session);
                    reload();
                  }}><Text style={s.btnGhostTxt}>Отменить запись</Text></Pressable>
                )}
                {manage && (
                  <Pressable style={s.btnGhost} onPress={() => {
                    Alert.alert('Игра сыграна?', 'Сессия будет завершена и убрана из списка.', [
                      { text: 'Отмена' },
                      { text: 'Завершить', style: 'destructive', onPress: async () => { await repo.played(item.id, session); reload(); } },
                    ]);
                  }}><Text style={s.btnGhostTxt}>Игра сыграна</Text></Pressable>
                )}
              </View>
            </View>
          );
        }}
      />
      {dev && (
        <View style={s.addRow}>
          <TextInput
            style={s.input}
            placeholder="Название новой сессии"
            placeholderTextColor={theme.muted}
            value={title}
            onChangeText={setTitle}
            onSubmitEditing={createGame}
          />
          <Pressable style={s.addBtn} onPress={createGame}><Text style={s.addTxt}>Создать</Text></Pressable>
        </View>
      )}
      {!session && <Text style={s.note}>Войди во вкладке «Профиль», чтобы записываться на игры.</Text>}
    </View>
  );
}

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg },
  empty: { color: t.muted, textAlign: 'center', marginTop: 40, paddingHorizontal: 24, lineHeight: 20 },
  card: { backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: 14 },
  title: { color: t.txt, fontSize: 16, fontWeight: '700' },
  meta: { color: t.dim, marginTop: 4, fontSize: 13 },
  players: { color: t.muted, marginTop: 6, fontSize: 13 },
  actRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  btnPrimary: { backgroundColor: t.accent, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 },
  btnPrimaryTxt: { color: t.bg, fontWeight: '800' },
  btnGhost: { borderWidth: 1, borderColor: t.line2, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, backgroundColor: t.surface2 },
  btnGhostTxt: { color: t.dim, fontWeight: '600' },
  addRow: { flexDirection: 'row', gap: 8, padding: 12 },
  input: { flex: 1, backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: t.txt },
  addBtn: { borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: t.surface2, borderWidth: 1, borderColor: t.line2 },
  addTxt: { color: t.txt, fontWeight: '600' },
  note: { color: t.muted, textAlign: 'center', paddingBottom: 12, fontSize: 12 },
});
