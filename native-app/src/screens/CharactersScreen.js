// Экран «Игроки» — полный цикл персонажа: список моих листов сеттинга (из того же
// облачного ключа, что у сайта) → создание/правка с автоподсчётом → полный лист → удаление.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, FlatList, Modal, StyleSheet, Alert } from 'react-native';
import { deriveSheet, ABILITIES, fmtBonus, proficiencyBonus, rollPool } from '../../../native-core/index.js';
import { useTheme } from '../theme.js';
import { useSession } from '../session.js';
import { loadMyChars, saveMyChar, deleteMyChar, uid } from '../chars.js';

export default function CharactersScreen() {
  const { theme, setting } = useTheme();
  const { session, tag } = useSession();
  const [chars, setChars] = useState([]);
  const [editing, setEditing] = useState(null);   // объект персонажа в форме
  const [viewing, setViewing] = useState(null);   // объект персонажа в листе

  const reload = useCallback(async () => {
    if (!tag) { setChars([]); return; }
    setChars(await loadMyChars(setting, tag));
  }, [setting, tag]);

  useEffect(() => { reload(); }, [reload]);

  const s = styles(theme);

  if (!session) {
    return <View style={s.wrap}><Text style={s.empty}>Войди во вкладке «Профиль», чтобы создавать персонажей.</Text></View>;
  }

  return (
    <View style={s.wrap}>
      <FlatList
        data={chars}
        keyExtractor={c => c.id}
        contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 90 }}
        ListEmptyComponent={<Text style={s.empty}>Пока нет персонажей в этом сеттинге. Создай первого!</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.card} onPress={() => setViewing(item)}>
            <Text style={s.name}>{item.name}</Text>
            <Text style={s.meta}>{item.role || 'Без класса'} · ур. {item.level || 1} · ХП {item.hp || '—'} · КД {item.ac || '—'}</Text>
          </Pressable>
        )}
      />
      <Pressable style={s.fab} onPress={() => setEditing(newChar(setting))}>
        <Text style={s.fabTxt}>＋ Создать персонажа</Text>
      </Pressable>

      {editing && (
        <EditorModal
          char={editing}
          theme={theme}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            await saveMyChar(setting, tag, c);
            setEditing(null);
            reload();
          }}
        />
      )}
      {viewing && (
        <SheetModal
          char={viewing}
          theme={theme}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing); setViewing(null); }}
          onDelete={() => {
            Alert.alert('Удалить персонажа?', viewing.name, [
              { text: 'Отмена' },
              { text: 'Удалить', style: 'destructive', onPress: async () => {
                await deleteMyChar(setting, tag, viewing.id);
                setViewing(null);
                reload();
              } },
            ]);
          }}
        />
      )}
    </View>
  );
}

function newChar(setting) {
  return { id: uid(), name: '', role: '', level: 1, hp: '', ac: '',
    abil: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, saves: {}, skills: {}, game: setting };
}

/* Форма создания/правки: имя, класс/роль, уровень, шесть характеристик, ХП, КД. */
function EditorModal({ char, theme, onClose, onSave }) {
  const [c, setC] = useState({ ...char, abil: { ...(char.abil || {}) } });
  const s = styles(theme);
  const set = (k, v) => setC(prev => ({ ...prev, [k]: v }));
  const setAb = (k, v) => setC(prev => ({ ...prev, abil: { ...prev.abil, [k]: v } }));
  const pb = proficiencyBonus(c.level || 1);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.modalScrim}>
        <View style={s.modalBox}>
          <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
            <Text style={s.modalTitle}>{char.name ? 'Персонаж' : 'Новый персонаж'}</Text>
            <Field t={theme} label="Имя *" value={c.name} onChange={v => set('name', v)} />
            <Field t={theme} label="Класс и раса (напр. Бард · Полуэльф)" value={c.role} onChange={v => set('role', v)} />
            <View style={s.row2}>
              <Field t={theme} label="Уровень" value={String(c.level || '')} onChange={v => set('level', parseInt(v, 10) || 1)} numeric flex />
              <Field t={theme} label={'Мастерство ' + fmtBonus(pb)} value={fmtBonus(pb)} editable={false} flex />
            </View>
            <Text style={s.h}>Характеристики</Text>
            <View style={s.abilGrid}>
              {ABILITIES.map(([k, lbl]) => (
                <View key={k} style={s.abilEdit}>
                  <Text style={s.abilLbl}>{lbl}</Text>
                  <TextInput
                    style={s.abilInput}
                    keyboardType="number-pad"
                    value={String(c.abil[k] ?? '')}
                    onChangeText={v => setAb(k, v.replace(/[^0-9]/g, ''))}
                    maxLength={2}
                  />
                </View>
              ))}
            </View>
            <View style={s.row2}>
              <Field t={theme} label="Хиты" value={String(c.hp || '')} onChange={v => set('hp', v)} numeric flex />
              <Field t={theme} label="КД" value={String(c.ac || '')} onChange={v => set('ac', v)} numeric flex />
            </View>
          </ScrollView>
          <View style={s.modalActs}>
            <Pressable style={s.btnGhost} onPress={onClose}><Text style={s.btnGhostTxt}>Отмена</Text></Pressable>
            <Pressable
              style={[s.btnPrimary, !c.name.trim() && { opacity: 0.4 }]}
              disabled={!c.name.trim()}
              onPress={() => onSave(c)}
            ><Text style={s.btnPrimaryTxt}>Сохранить</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/* Полный лист: всё считает ядро (deriveSheet) + бросок кубов. */
function SheetModal({ char, theme, onClose, onEdit, onDelete }) {
  const sheet = useMemo(() => deriveSheet(char), [char]);
  const [roll, setRoll] = useState(null);
  const s = styles(theme);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.modalScrim}>
        <View style={s.modalBox}>
          <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 24 }}>
            <Text style={s.modalTitle}>{char.name}</Text>
            <Text style={s.meta}>{char.role || ''} · ур. {char.level || 1} · ХП {sheet.maxHp || char.hp || '—'} · КД {char.ac || '—'} · мастерство {fmtBonus(sheet.pb)}</Text>
            <Text style={s.h}>Характеристики</Text>
            <View style={s.abilGrid}>
              {ABILITIES.map(([k, lbl]) => (
                <View key={k} style={s.abilCell}>
                  <Text style={s.abilLbl}>{lbl}</Text>
                  <Text style={s.abilScore}>{(char.abil || {})[k] ?? '—'}</Text>
                  <Text style={s.abilModTxt}>{sheet.modsStr[k]}</Text>
                </View>
              ))}
            </View>
            <Text style={s.h}>Спасброски</Text>
            <View style={s.grid}>
              {sheet.saves.map(sv => (
                <View key={sv.key} style={[s.cell, sv.proficient && s.cellOn]}>
                  <Text style={s.cellL}>{sv.label}</Text>
                  <Text style={s.cellV}>{sv.text}</Text>
                </View>
              ))}
            </View>
            <Text style={s.h}>Бросок</Text>
            <View style={s.diceRow}>
              {[4, 6, 8, 10, 12, 20].map(n => (
                <Pressable key={n} style={s.die} onPress={() => setRoll(rollPool({ [n]: 1 }))}>
                  <Text style={s.dieT}>d{n}</Text>
                </Pressable>
              ))}
            </View>
            {roll && <Text style={[s.rollOut, roll.crit && { color: theme.accent }]}>{roll.total}{roll.crit ? ' · крит!' : ''}</Text>}
          </ScrollView>
          <View style={s.modalActs}>
            <Pressable style={s.btnGhost} onPress={onDelete}><Text style={s.btnGhostTxt}>Удалить</Text></Pressable>
            <Pressable style={s.btnGhost} onPress={onEdit}><Text style={s.btnGhostTxt}>Править</Text></Pressable>
            <Pressable style={s.btnPrimary} onPress={onClose}><Text style={s.btnPrimaryTxt}>Закрыть</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({ t, label, value, onChange, numeric, editable = true, flex }) {
  const s = styles(t);
  return (
    <View style={[{ marginBottom: 10 }, flex && { flex: 1 }]}>
      <Text style={s.fieldLbl}>{label}</Text>
      <TextInput
        style={[s.input, !editable && { opacity: 0.6 }]}
        value={value}
        editable={editable}
        keyboardType={numeric ? 'number-pad' : 'default'}
        onChangeText={onChange}
        placeholderTextColor={t.muted}
      />
    </View>
  );
}

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg },
  empty: { color: t.muted, textAlign: 'center', marginTop: 40, paddingHorizontal: 24, lineHeight: 20 },
  card: { backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 12, padding: 14 },
  name: { color: t.txt, fontSize: 17, fontWeight: '700' },
  meta: { color: t.dim, marginTop: 4, fontSize: 13 },
  fab: { position: 'absolute', left: 14, right: 14, bottom: 14, backgroundColor: t.accent, borderRadius: 14, padding: 15, alignItems: 'center' },
  fabTxt: { color: t.bg, fontWeight: '800' },
  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBox: { maxHeight: '90%', backgroundColor: t.bg2, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderColor: t.line2, borderWidth: 1 },
  modalTitle: { color: t.txt, fontSize: 22, fontWeight: '800', marginBottom: 8 },
  modalActs: { flexDirection: 'row', gap: 8, padding: 12, borderTopColor: t.line2, borderTopWidth: 1 },
  btnPrimary: { flex: 1, backgroundColor: t.accent, borderRadius: 12, padding: 13, alignItems: 'center' },
  btnPrimaryTxt: { color: t.bg, fontWeight: '800' },
  btnGhost: { flex: 1, borderWidth: 1, borderColor: t.line2, borderRadius: 12, padding: 13, alignItems: 'center', backgroundColor: t.surface },
  btnGhostTxt: { color: t.dim, fontWeight: '600' },
  h: { color: t.accent, marginTop: 16, marginBottom: 8, fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' },
  fieldLbl: { color: t.muted, fontSize: 12, marginBottom: 4 },
  input: { backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: t.txt },
  row2: { flexDirection: 'row', gap: 10 },
  abilGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  abilEdit: { flexBasis: '31%', flexGrow: 1, backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, padding: 8, alignItems: 'center' },
  abilCell: { flexBasis: '31%', flexGrow: 1, backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, padding: 10, alignItems: 'center' },
  abilLbl: { color: t.muted, fontSize: 11, letterSpacing: 1 },
  abilInput: { color: t.txt, fontSize: 20, fontWeight: '700', paddingVertical: 2, minWidth: 44, textAlign: 'center' },
  abilScore: { color: t.txt, fontSize: 22, fontWeight: '700', marginVertical: 2 },
  abilModTxt: { color: t.accent, fontSize: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexBasis: '48%', flexGrow: 1, flexDirection: 'row', justifyContent: 'space-between', backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  cellOn: { borderColor: t.accent },
  cellL: { color: t.dim },
  cellV: { color: t.txt, fontWeight: '600' },
  diceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  die: { backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 },
  dieT: { color: t.txt, fontWeight: '700' },
  rollOut: { color: t.txt, fontSize: 30, fontWeight: '800', marginTop: 12, textAlign: 'center' },
});
