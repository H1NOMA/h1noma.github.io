// Экран архива — живой поиск/фильтр через ядро (queryArchive). Данные каркаса синтетические;
// в боевой версии подставляются реальные карточки из бандла (extract.mjs) или API.
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, FlatList, StyleSheet } from 'react-native';
import { queryArchive, dndCategories } from '../../../native-core/index.js';
import { useTheme } from '../theme.js';
import { SAMPLE_CARDS } from '../sampleData.js';

export default function ArchiveScreen() {
  const { theme } = useTheme();
  const cats = useMemo(() => dndCategories(), []);
  const [cat, setCat] = useState('all');
  const [search, setSearch] = useState('');

  const result = useMemo(
    () => queryArchive(SAMPLE_CARDS, { cat, search }),
    [cat, search]
  );

  const s = styles(theme);
  return (
    <View style={s.wrap}>
      <TextInput
        style={s.search}
        placeholder="Поиск в архиве…"
        placeholderTextColor={theme.muted}
        value={search}
        onChangeText={setSearch}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chips} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
        <Chip label="Все" on={cat === 'all'} onPress={() => setCat('all')} t={theme} />
        {cats.map(c => (
          <Chip key={c.id} label={c.label} on={cat === c.id} onPress={() => setCat(c.id)} t={theme} />
        ))}
      </ScrollView>
      <FlatList
        data={result.items}
        keyExtractor={i => i.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={s.empty}>Ничего не найдено</Text>}
        renderItem={({ item }) => (
          <View style={s.card}>
            {!!item.kicker && <Text style={s.kicker}>{item.kicker}</Text>}
            <Text style={s.title}>{item.title}</Text>
            {(item.dossier || []).slice(0, 2).map((d, i) => (
              <Text key={i} style={s.dos}>{d.k}: {String(d.v)}</Text>
            ))}
          </View>
        )}
      />
      <Text style={s.count}>{result.total} карточек · демо-данные</Text>
    </View>
  );
}

function Chip({ label, on, onPress, t }) {
  return (
    <Pressable onPress={onPress} style={[chip(t).base, on && chip(t).on]}>
      <Text style={[chip(t).txt, on && chip(t).txtOn]}>{label}</Text>
    </Pressable>
  );
}

const chip = (t) => StyleSheet.create({
  base: { borderColor: t.line2, borderWidth: 1, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: t.surface },
  on: { borderColor: t.accent, backgroundColor: t.surface2 },
  txt: { color: t.dim, fontSize: 13 },
  txtOn: { color: t.accent, fontWeight: '700' },
});

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg },
  search: { margin: 12, marginBottom: 8, backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: t.txt },
  chips: { flexGrow: 0, marginBottom: 4 },
  card: { backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: 12 },
  kicker: { color: t.muted, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 },
  title: { color: t.txt, fontSize: 16, fontWeight: '700' },
  dos: { color: t.dim, marginTop: 2, fontSize: 13 },
  empty: { color: t.muted, textAlign: 'center', marginTop: 40 },
  count: { color: t.muted, textAlign: 'center', paddingVertical: 8, fontSize: 12 },
});
