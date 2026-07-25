// Экран листа персонажа — живой, считается ядром (deriveSheet). Плюс демо-бросок кубов.
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { deriveSheet, ABILITIES, fmtBonus, rollPool } from '../../../native-core/index.js';
import { useTheme } from '../theme.js';
import { SAMPLE_CHARACTER } from '../sampleData.js';

export default function SheetScreen() {
  const { theme } = useTheme();
  const c = SAMPLE_CHARACTER;
  const sheet = useMemo(() => deriveSheet(c), [c]);
  const [roll, setRoll] = useState(null);

  const s = styles(theme);
  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Text style={s.name}>{c.name}</Text>
      <Text style={s.role}>{c.role} · ХП {sheet.maxHp} · КД {c.ac} · мастерство {fmtBonus(sheet.pb)}</Text>

      <Text style={s.h}>Характеристики</Text>
      <View style={s.abilRow}>
        {ABILITIES.map(([k, label]) => (
          <View key={k} style={s.abilCard}>
            <Text style={s.abilLbl}>{label}</Text>
            <Text style={s.abilScore}>{c.abil[k]}</Text>
            <Text style={s.abilMod}>{sheet.modsStr[k]}</Text>
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

      <Text style={s.h}>Навыки</Text>
      <View style={s.grid}>
        {sheet.skills.filter(sk => sk.dots > 0).map(sk => (
          <View key={sk.name} style={[s.cell, s.cellOn]}>
            <Text style={s.cellL}>{sk.name}{sk.dots === 2 ? ' ★' : ''}</Text>
            <Text style={s.cellV}>{sk.text}</Text>
          </View>
        ))}
      </View>

      {sheet.spells && (
        <>
          <Text style={s.h}>Заклинания</Text>
          <Text style={s.p}>
            Заговоры: {sheet.spells.cantripMax} · известно: {sheet.spells.knownMax}
            {sheet.spells.prepMax ? ` · подготовлено ≤ ${sheet.spells.prepMax}` : ''}
          </Text>
        </>
      )}

      <Text style={s.h}>Бросок</Text>
      <View style={s.diceRow}>
        {[4, 6, 8, 10, 12, 20].map(n => (
          <Pressable key={n} style={s.die} onPress={() => setRoll(rollPool({ [n]: 1 }))}>
            <Text style={s.dieT}>d{n}</Text>
          </Pressable>
        ))}
      </View>
      {roll && (
        <Text style={[s.rollOut, roll.crit && s.rollCrit]}>
          {roll.total}{roll.crit ? '  · крит!' : ''}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = (t) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: t.bg },
  name: { color: t.txt, fontSize: 24, fontWeight: '700' },
  role: { color: t.dim, marginTop: 4, marginBottom: 8 },
  h: { color: t.accent, marginTop: 20, marginBottom: 8, fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' },
  p: { color: t.dim },
  abilRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  abilCard: { flexBasis: '31%', flexGrow: 1, backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 12, padding: 10, alignItems: 'center' },
  abilLbl: { color: t.muted, fontSize: 11, letterSpacing: 1 },
  abilScore: { color: t.txt, fontSize: 22, fontWeight: '700', marginVertical: 2 },
  abilMod: { color: t.accent, fontSize: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexBasis: '48%', flexGrow: 1, flexDirection: 'row', justifyContent: 'space-between', backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  cellOn: { borderColor: t.accent },
  cellL: { color: t.dim },
  cellV: { color: t.txt, fontWeight: '600' },
  diceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  die: { backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 },
  dieT: { color: t.txt, fontWeight: '700' },
  rollOut: { color: t.txt, fontSize: 32, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  rollCrit: { color: t.accent },
});
