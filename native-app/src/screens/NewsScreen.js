// Экран «Новости» — приветствие сеттинга + новости из облака (те же данные, что на сайте).
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, RefreshControl, StyleSheet } from 'react-native';
import { KEYS, newsRepo } from '../../../native-core/data/index.js';
import { SETTING_HERO } from '../../../native-core/index.js';
import { useTheme } from '../theme.js';
import { store } from '../store.js';

const repo = newsRepo(store);

export default function NewsScreen() {
  const { theme, setting } = useTheme();
  const [news, setNews] = useState([]);
  const [open, setOpen] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const all = await repo.list();
      setNews((all || []).filter(n => n && (!n.game || n.game === setting)));
    } finally { setRefreshing(false); }
  }, [setting]);

  useEffect(() => { reload(); }, [reload]);

  const hero = SETTING_HERO[setting] || SETTING_HERO.classic;
  const s = styles(theme);

  return (
    <FlatList
      style={s.wrap}
      data={news}
      keyExtractor={n => n.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
      contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 30 }}
      ListHeaderComponent={
        <View style={s.hero}>
          <Text style={s.heroTitle}>{hero.title}</Text>
          <Text style={s.heroText}>{hero.text}</Text>
        </View>
      }
      ListEmptyComponent={<Text style={s.empty}>{hero.empty}</Text>}
      renderItem={({ item }) => {
        const opened = open === item.id;
        return (
          <Pressable style={s.card} onPress={() => setOpen(opened ? null : item.id)}>
            <Text style={s.title}>{item.title}</Text>
            {!!item.date && <Text style={s.date}>{String(item.date).slice(0, 10)}</Text>}
            {!!item.body && (
              <Text style={s.body} numberOfLines={opened ? undefined : 3}>{item.body}</Text>
            )}
          </Pressable>
        );
      }}
    />
  );
}

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg },
  hero: { borderWidth: 1, borderColor: t.line2, borderRadius: 14, padding: 16, backgroundColor: t.surface, marginBottom: 6 },
  heroTitle: { color: t.accent, fontSize: 20, fontWeight: '800', marginBottom: 8 },
  heroText: { color: t.dim, lineHeight: 21 },
  empty: { color: t.muted, textAlign: 'center', marginTop: 24, paddingHorizontal: 20, lineHeight: 20 },
  card: { backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: 14 },
  title: { color: t.txt, fontSize: 16, fontWeight: '700' },
  date: { color: t.muted, fontSize: 12, marginTop: 2 },
  body: { color: t.dim, marginTop: 8, lineHeight: 20 },
});
