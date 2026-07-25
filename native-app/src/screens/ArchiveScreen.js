// Экран «Архив» — реальные карточки: бандл (ядро SRD + бестиарий + встроенный архив)
// + облачный архив и правки ядра. Категории/подкатегории сеттинга, поиск, полная карточка.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, FlatList, Modal, StyleSheet } from 'react-native';
import { queryArchive, settingCategories, beastStat, statModText, STAT_FIELDS, STAT_ABIL, BEAST_STAT_DOS, hasStatblock } from '../../../native-core/index.js';
import { useTheme } from '../theme.js';
import { useSession } from '../session.js';
import { loadArchiveFor } from '../data.js';
import { store } from '../store.js';

export default function ArchiveScreen() {
  const { theme, setting } = useTheme();
  const { dev } = useSession();
  const [cards, setCards] = useState(null);          // null = грузится
  const [cat, setCat] = useState('all');
  const [sub, setSub] = useState(null);
  const [search, setSearch] = useState('');
  const [openCard, setOpenCard] = useState(null);

  const cats = useMemo(() => settingCategories(setting).filter(c => !c.dev || dev), [setting, dev]);

  const reload = useCallback(async () => {
    setCards(null);
    const list = await loadArchiveFor(setting, store);
    setCards(list);
  }, [setting]);

  useEffect(() => { setCat('all'); setSub(null); setSearch(''); reload(); }, [reload]);

  const result = useMemo(() => {
    if (!cards) return { items: [], total: 0 };
    return queryArchive(cards, { cat, sub, search });
  }, [cards, cat, sub, search]);

  const s = styles(theme);

  // архив ASSIMILATION закрыт для всех, кроме разработчиков (как на сайте)
  if (setting === 'assimilation' && !dev) {
    return <View style={s.wrap}><Text style={s.empty}>Архив ASSIMILATION закрыт.</Text></View>;
  }

  const curCat = cats.find(c => c.id === cat);

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
        <Chip label="Все" on={cat === 'all'} onPress={() => { setCat('all'); setSub(null); }} t={theme} />
        {cats.map(c => (
          <Chip key={c.id} label={c.label} on={cat === c.id} onPress={() => { setCat(c.id); setSub(null); }} t={theme} />
        ))}
      </ScrollView>
      {curCat && curCat.subs.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chips} contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }}>
          {curCat.subs.map(x => (
            <Chip key={x.id} small label={x.label} on={sub === x.id} onPress={() => setSub(sub === x.id ? null : x.id)} t={theme} />
          ))}
        </ScrollView>
      )}
      {!cards ? (
        <Text style={s.empty}>Архив загружается…</Text>
      ) : (
        <FlatList
          data={result.items}
          keyExtractor={i => i.id}
          initialNumToRender={20}
          maxToRenderPerBatch={30}
          windowSize={7}
          contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 30 }}
          ListEmptyComponent={<Text style={s.empty}>Ничего не найдено</Text>}
          renderItem={({ item }) => (
            <Pressable style={s.card} onPress={() => setOpenCard(item)}>
              {!!item.kicker && <Text style={s.kicker}>{item.kicker}</Text>}
              <Text style={s.title}>{item.title}</Text>
              {!!item.body && <Text style={s.bodyPrev} numberOfLines={2}>{item.body}</Text>}
            </Pressable>
          )}
        />
      )}
      {!!cards && <Text style={s.count}>{result.total} карточек</Text>}
      <CardModal card={openCard} onClose={() => setOpenCard(null)} theme={theme} />
    </View>
  );
}

/* Полная карточка: досье, статблок-сетка (бестиарий/божества), разделы, теги, источник. */
export function CardModal({ card, onClose, theme }) {
  const s = styles(theme);
  if (!card) return null;
  const withStat = hasStatblock(card);
  const st = withStat ? beastStat(card) : {};
  const dossier = (card.dossier || []).filter(r =>
    (r.k || r.v) && !(card.sub === 'bestiary' && BEAST_STAT_DOS.has((r.k || '').trim())));
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.modalScrim}>
        <View style={s.modalBox}>
          <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 30 }}>
            {!!card.kicker && <Text style={s.kicker}>{card.kicker}</Text>}
            <Text style={s.modalTitle}>{card.title}</Text>
            {dossier.map((r, i) => (
              <View key={i} style={s.dosRow}>
                <Text style={s.dosK}>{r.k}</Text>
                <Text style={s.dosV}>{String(r.v)}</Text>
              </View>
            ))}
            {!!card.body && <Text style={s.modalBody}>{card.body}</Text>}
            {withStat && (
              <View style={s.statWrap}>
                <Text style={s.statHead}>Статблок</Text>
                <View style={s.statTop}>
                  {[['ac', 'КД'], ['hp', 'Хиты'], ['speed', 'Скорость']].map(([k, lbl]) => (
                    <View key={k} style={s.statCellWide}>
                      <Text style={s.statLbl}>{lbl}</Text>
                      <Text style={s.statVal}>{st[k] || '—'}</Text>
                    </View>
                  ))}
                </View>
                <View style={s.abilGrid}>
                  {STAT_ABIL.map(k => {
                    const lbl = STAT_FIELDS.find(([kk]) => kk === k)[1];
                    const mod = statModText(st[k]);
                    return (
                      <View key={k} style={s.abilCell}>
                        <Text style={s.statLbl}>{lbl}</Text>
                        <Text style={s.abilVal}>{st[k] || '—'}{mod ? '  ' : ''}<Text style={s.abilMod}>{mod || ''}</Text></Text>
                      </View>
                    );
                  })}
                </View>
                {STAT_FIELDS.filter(([k]) => !STAT_ABIL.includes(k) && !['ac', 'hp', 'speed'].includes(k) && st[k]).map(([k, lbl]) => (
                  <View key={k} style={s.dosRow}>
                    <Text style={s.dosK}>{lbl}</Text>
                    <Text style={s.dosV}>{st[k]}</Text>
                  </View>
                ))}
              </View>
            )}
            {(card.sections || []).map((sec, i) => (
              <View key={i} style={s.section}>
                <Text style={s.secH}>{sec.h}</Text>
                <Text style={s.secT}>{sec.t}</Text>
              </View>
            ))}
            {(card.tags || []).length > 0 && (
              <Text style={s.tags}>{card.tags.map(t => '#' + t).join('  ')}</Text>
            )}
            {!!card.src && <Text style={s.src}>{card.src}</Text>}
          </ScrollView>
          <Pressable style={s.closeBtn} onPress={onClose}><Text style={s.closeTxt}>Закрыть</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Chip({ label, on, onPress, t, small }) {
  const c = chip(t, small);
  return (
    <Pressable onPress={onPress} style={[c.base, on && c.on]}>
      <Text style={[c.txt, on && c.txtOn]}>{label}</Text>
    </Pressable>
  );
}

const chip = (t, small) => StyleSheet.create({
  base: { borderColor: t.line2, borderWidth: 1, borderRadius: 999, paddingVertical: small ? 6 : 8, paddingHorizontal: small ? 11 : 14, backgroundColor: t.surface },
  on: { borderColor: t.accent, backgroundColor: t.surface2 },
  txt: { color: t.dim, fontSize: small ? 12 : 13 },
  txtOn: { color: t.accent, fontWeight: '700' },
});

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg },
  search: { margin: 12, marginBottom: 8, backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: t.txt },
  chips: { flexGrow: 0, marginBottom: 6 },
  card: { backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: 12 },
  kicker: { color: t.muted, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 },
  title: { color: t.txt, fontSize: 16, fontWeight: '700' },
  bodyPrev: { color: t.dim, marginTop: 4, fontSize: 13, lineHeight: 18 },
  empty: { color: t.muted, textAlign: 'center', marginTop: 40 },
  count: { color: t.muted, textAlign: 'center', paddingVertical: 6, fontSize: 12 },
  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBox: { maxHeight: '88%', backgroundColor: t.bg2, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderColor: t.line2, borderWidth: 1 },
  modalTitle: { color: t.txt, fontSize: 22, fontWeight: '800', marginBottom: 10 },
  modalBody: { color: t.dim, lineHeight: 21, marginTop: 10 },
  dosRow: { flexDirection: 'row', gap: 10, paddingVertical: 5, borderBottomColor: t.line, borderBottomWidth: 1 },
  dosK: { color: t.muted, fontSize: 12, width: 118, textTransform: 'uppercase', letterSpacing: 0.5, paddingTop: 2 },
  dosV: { color: t.txt, flex: 1, lineHeight: 19 },
  statWrap: { marginTop: 14, borderWidth: 1, borderColor: t.line2, borderRadius: 14, padding: 12 },
  statHead: { color: t.accent, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 },
  statTop: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  statCellWide: { flex: 1 },
  statLbl: { color: t.muted, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 },
  statVal: { color: t.txt, fontSize: 13 },
  abilGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  abilCell: { flexBasis: '31%', flexGrow: 1, borderWidth: 1, borderColor: t.line, borderRadius: 10, padding: 8, alignItems: 'center' },
  abilVal: { color: t.txt, fontWeight: '700', fontSize: 15 },
  abilMod: { color: t.accent, fontWeight: '600', fontSize: 12 },
  section: { marginTop: 10, borderLeftWidth: 2, borderLeftColor: t.accent, backgroundColor: t.surface, borderRadius: 10, padding: 11 },
  secH: { color: t.txt, fontWeight: '700', marginBottom: 4 },
  secT: { color: t.dim, lineHeight: 20 },
  tags: { color: t.muted, marginTop: 12, fontSize: 12 },
  src: { color: t.muted, marginTop: 8, fontSize: 11, fontStyle: 'italic' },
  closeBtn: { padding: 14, alignItems: 'center', borderTopColor: t.line2, borderTopWidth: 1 },
  closeTxt: { color: t.accent, fontWeight: '700' },
});
