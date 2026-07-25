// Экран «Профиль» — вход по тегу (как на сайте). Сессия хранится локально на устройстве.
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../theme.js';
import { useSession } from '../session.js';

export default function ProfileScreen() {
  const { theme } = useTheme();
  const { session, tag, dev, login, logout } = useSession();
  const [input, setInput] = useState('');
  const s = styles(theme);

  if (session) {
    return (
      <View style={s.wrap}>
        <Text style={s.who}>@{tag}</Text>
        {dev && <Text style={s.devBadge}>Разработчик · режим Game Master</Text>}
        <Pressable style={s.btnGhost} onPress={logout}><Text style={s.btnGhostTxt}>Выйти</Text></Pressable>
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
  btnGhost: { borderWidth: 1, borderColor: t.line2, borderRadius: 12, padding: 14, alignItems: 'center', backgroundColor: t.surface, marginTop: 8 },
  btnGhostTxt: { color: t.dim, fontWeight: '600' },
});
