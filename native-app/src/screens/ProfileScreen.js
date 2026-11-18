// Экран «Профиль» — вход по тегу, пуш-уведомления, удаление аккаунта (требование сторов).
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from 'react-native';
import { useTheme } from '../theme.js';
import { useSession } from '../session.js';
import { enablePush, disablePush, pushEnabled, deleteAccountData } from '../platform.js';

export default function ProfileScreen() {
  const { theme } = useTheme();
  const { session, tag, dev, login, logout } = useSession();
  const [input, setInput] = useState('');
  const [push, setPush] = useState(false);
  const s = styles(theme);

  useEffect(() => {
    let alive = true;
    if (tag) pushEnabled(tag).then(v => { if (alive) setPush(v); });
    return () => { alive = false; };
  }, [tag]);

  if (session) {
    return (
      <View style={s.wrap}>
        <Text style={s.who}>@{tag}</Text>
        {dev && <Text style={s.devBadge}>Разработчик · режим Game Master</Text>}

        <Pressable style={s.btnGhost} onPress={async () => {
          if (push) { await disablePush(tag); setPush(false); return; }
          const r = await enablePush(tag);
          if (r.ok) { setPush(true); Alert.alert('Уведомления включены', 'Токен устройства сохранён — сервер сможет присылать пуши о новых играх.'); }
          else Alert.alert('Не получилось', r.reason === 'denied' ? 'Разрешение на уведомления не выдано.' : String(r.reason));
        }}>
          <Text style={s.btnGhostTxt}>🔔 Уведомления о играх: {push ? 'включены' : 'выключены'}</Text>
        </Pressable>

        <Pressable style={s.btnGhost} onPress={logout}><Text style={s.btnGhostTxt}>Выйти</Text></Pressable>

        <Pressable style={s.btnDanger} onPress={() => {
          Alert.alert('Удалить аккаунт?',
            'Все твои персонажи во всех сеттингах будут удалены (синхронно с сайтом), пуш-токен стёрт. Действие необратимо.',
            [
              { text: 'Отмена' },
              { text: 'Удалить всё', style: 'destructive', onPress: async () => {
                await deleteAccountData(tag);
                await logout();
                Alert.alert('Аккаунт удалён', 'Данные стёрты. Спасибо, что играл с нами.');
              } },
            ]);
        }}>
          <Text style={s.btnDangerTxt}>Удалить аккаунт и данные</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.wrap}>
      <Text style={s.h}>Вход</Text>
      <Text style={s.p}>Укажи свой тег — персонажи и записи на игры привязаны к профилю.</Text>
      <TextInput
        style={s.input}
        placeholder="@тег"
        placeholderTextColor={theme.muted}
        autoCapitalize="none"
        value={input}
        onChangeText={setInput}
        onSubmitEditing={() => login(input)}
      />
      <Pressable style={s.btnPrimary} onPress={() => login(input)}>
        <Text style={s.btnPrimaryTxt}>Войти</Text>
      </Pressable>
    </View>
  );
}

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg, padding: 20, gap: 12 },
  who: { color: t.txt, fontSize: 22, fontWeight: '800' },
  devBadge: { color: t.accent, fontWeight: '600' },
  h: { color: t.txt, fontSize: 20, fontWeight: '800' },
  p: { color: t.dim, lineHeight: 20 },
  input: { backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: t.txt },
  btnPrimary: { backgroundColor: t.accent, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnPrimaryTxt: { color: t.bg, fontWeight: '800' },
  btnGhost: { borderWidth: 1, borderColor: t.line2, borderRadius: 12, padding: 14, alignItems: 'center', backgroundColor: t.surface },
  btnGhostTxt: { color: t.dim, fontWeight: '600' },
  btnDanger: { borderWidth: 1, borderColor: 'rgba(255,90,95,0.5)', borderRadius: 12, padding: 14, alignItems: 'center', backgroundColor: 'rgba(255,90,95,0.08)', marginTop: 16 },
  btnDangerTxt: { color: '#ff5a5f', fontWeight: '700' },
});
