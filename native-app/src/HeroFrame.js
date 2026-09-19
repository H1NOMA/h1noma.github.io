// Рамки приветствий «в духе эпохи» — упрощённые версии веб-рамок, чистыми View:
//  legacy — гравированная лунная скрижаль; neverland — свиток с золотыми стержнями;
//  terra — письмо с обгоревшими углами; classic — фолиант с золотой рамкой и заклёпками;
//  assimilation — терминал со срезанным углом.
import React from 'react';
import { View, StyleSheet } from 'react-native';

export default function HeroFrame({ setting, theme, children }) {
  const t = theme;
  switch (setting) {
    case 'legacy':
      return (
        <View style={[f.base, { backgroundColor: '#181528', borderColor: 'rgba(168,158,235,0.28)', borderWidth: 1 }]}>
          <View style={[f.inset, { borderColor: 'rgba(168,158,235,0.22)' }]} />
          {corners('rgba(190,182,255,0.55)').map((c, i) => <View key={i} style={c} />)}
          {children}
        </View>
      );
    case 'neverland':
      return (
        <View style={{ marginVertical: 8 }}>
          <View style={f.rod} />
          <View style={[f.base, { backgroundColor: '#342a15', borderColor: 'rgba(255,220,140,0.25)', borderWidth: 1, borderRadius: 4, marginVertical: -2 }]}>
            {children}
          </View>
          <View style={f.rod} />
        </View>
      );
    case 'terra':
      return (
        <View style={[f.base, { backgroundColor: '#221d13', borderColor: 'rgba(150,128,88,0.4)', borderWidth: 1, borderRadius: 3, overflow: 'hidden' }]}>
          <View style={[f.burn, { top: -22, right: -22 }]} />
          <View style={[f.burn, { bottom: -20, left: -20, width: 40, height: 40 }]} />
          {children}
        </View>
      );
    case 'classic':
      return (
        <View style={[f.base, { backgroundColor: '#171f14', borderColor: 'rgba(211,168,74,0.42)', borderWidth: 1 }]}>
          <View style={[f.inset, { borderColor: 'rgba(211,168,74,0.18)' }]} />
          {studs('#f0ce78').map((c, i) => <View key={i} style={c} />)}
          {children}
        </View>
      );
    default: // assimilation — срез угла как на сайте
      return (
        <View style={[f.base, { backgroundColor: t.surface, borderColor: t.line2, borderWidth: 1, overflow: 'hidden' }]}>
          <View style={[f.cut, { borderBottomColor: t.bg, borderRightColor: 'transparent' }]} />
          {children}
        </View>
      );
  }
}

/* засечки-руны по углам (legacy) */
function corners(color) {
  const m = 7, len = 14, th = 1.5;
  const pos = [
    { top: m, left: m }, { top: m, right: m }, { bottom: m, left: m }, { bottom: m, right: m },
  ];
  const out = [];
  pos.forEach(p => {
    out.push({ position: 'absolute', ...p, width: len, height: th, backgroundColor: color });
    out.push({ position: 'absolute', ...p, width: th, height: len, backgroundColor: color });
  });
  return out;
}

/* золотые заклёпки по углам (classic) */
function studs(color) {
  const m = 9, d = 5;
  return [
    { top: m, left: m }, { top: m, right: m }, { bottom: m, left: m }, { bottom: m, right: m },
  ].map(p => ({ position: 'absolute', ...p, width: d, height: d, borderRadius: d / 2, backgroundColor: color }));
}

const f = StyleSheet.create({
  base: { borderRadius: 14, padding: 18, marginBottom: 6, position: 'relative' },
  inset: { position: 'absolute', top: 6, left: 6, right: 6, bottom: 6, borderWidth: 1, borderRadius: 8 },
  rod: { height: 9, borderRadius: 5, backgroundColor: '#e0b452', marginHorizontal: -6, zIndex: 2 },
  burn: { position: 'absolute', width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(10,6,2,0.85)' },
  cut: { position: 'absolute', top: 0, right: 0, width: 0, height: 0, borderBottomWidth: 22, borderRightWidth: 22, transform: [{ rotate: '90deg' }] },
});
