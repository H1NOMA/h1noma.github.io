// Заставка входа — своя анимация на каждый сеттинг (как на сайте):
//  classic — золотой d20 выкатывается и замирает за названием;
//  legacy — луна разгорается в тумане; neverland — золото проступает из камня;
//  terra — название «выжигается» с мерцанием ламп; assimilation — глитч-сборка.
// Всё на встроенном Animated + react-native-svg (работает в Expo Go, без нативных сборок).
import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet, Dimensions } from 'react-native';
import Svg, { Polygon, Path } from 'react-native-svg';
import { themeFor } from '../../native-core/index.js';

const DUR = 2300;   // общая длительность, как в вебе (2.3s)

export default function Splash({ setting, onDone }) {
  const t = themeFor(setting);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const id = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 450, useNativeDriver: true })
        .start(() => onDone && onDone());
    }, DUR);
    return () => clearTimeout(id);
  }, [fade, onDone]);

  const Inner = { classic: ClassicFx, legacy: LegacyFx, neverland: NeverlandFx, terra: TerraFx, assimilation: AssimFx }[setting] || ClassicFx;

  return (
    <Animated.View pointerEvents="none" style={[st.wrap, { backgroundColor: t.bg, opacity: fade }]}>
      <Inner t={t} />
    </Animated.View>
  );
}

/* Логотип-подпись под эффектом */
function Brand({ t, color, style }) {
  return <Animated.Text style={[st.brand, { color: color || t.accent }, style]}>КОМИК</Animated.Text>;
}

/* — КЛАССИКА: d20 катится из-за края, замирает; название загорается золотом — */
function ClassicFx({ t }) {
  const roll = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(roll, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(glow, { toValue: 1, duration: 1800, delay: 300, useNativeDriver: true }),
    ]).start();
  }, [roll, glow]);
  const W = Dimensions.get('window').width;
  return (
    <View style={st.center}>
      <Animated.View style={{
        opacity: roll.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.5, 0.45] }),
        transform: [
          { translateX: roll.interpolate({ inputRange: [0, 1], outputRange: [-W, 0] }) },
          { rotate: roll.interpolate({ inputRange: [0, 1], outputRange: ['-320deg', '0deg'] }) },
        ],
      }}>
        <D20 size={Math.min(W * 0.58, 300)} color="#c9a94e" />
      </Animated.View>
      <Brand t={t} style={{ position: 'absolute', opacity: glow, textShadowColor: 'rgba(211,168,74,0.5)', textShadowRadius: 18 }} />
    </View>
  );
}

/* каркас d20 — те же линии, что в веб-заставке */
function D20({ size, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Polygon points="50,3 93,27 93,73 50,97 7,73 7,27" fill="rgba(201,169,78,0.06)" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <Polygon points="50,19 73,32 73,61 50,75 27,61 27,32" fill="rgba(201,169,78,0.10)" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <Path d="M50,3 50,19 M93,27 73,32 M93,73 73,61 M50,97 50,75 M7,73 27,61 M7,27 27,32" stroke={color} strokeWidth="1.8" opacity="0.75" />
      <Path d="M27,32 73,32 M27,32 50,75 M73,32 50,75" stroke={color} strokeWidth="1.8" opacity="0.55" />
      <Path d="M27,61 50,19 M73,61 50,19" stroke={color} strokeWidth="1.8" opacity="0.3" />
    </Svg>
  );
}

/* — LEGACY: луна разгорается, название поднимается из тумана — */
function LegacyFx({ t }) {
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(rise, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [rise]);
  return (
    <View style={st.center}>
      <Animated.View style={{
        position: 'absolute', width: 230, height: 230, borderRadius: 115,
        backgroundColor: 'rgba(167,139,250,0.16)',
        opacity: rise, transform: [{ scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
      }} />
      <View style={{ position: 'absolute', width: 130, height: 130, borderRadius: 65, backgroundColor: 'rgba(190,180,255,0.13)' }} />
      <Brand t={t} color="#bcacff" style={{
        opacity: rise,
        transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) }],
        textShadowColor: 'rgba(167,139,250,0.6)', textShadowRadius: 22,
      }} />
    </View>
  );
}

/* — NEVERLAND: золото проступает из тёмного камня — */
function NeverlandFx({ t }) {
  const heat = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(heat, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
  }, [heat]);
  return (
    <View style={st.center}>
      {/* тёмная «каменная» версия всегда снизу, золотая — проявляется поверх */}
      <Brand t={t} color="#4a3c1c" />
      <Brand t={t} color="#f0c869" style={{
        position: 'absolute', opacity: heat.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0.35, 1] }),
        textShadowColor: 'rgba(255,217,112,0.55)', textShadowRadius: 20,
      }} />
    </View>
  );
}

/* — TERRA: название проявляется сепией под мерцание газовых ламп — */
function TerraFx({ t }) {
  const flick = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const steps = [0.85, 0.6, 0.9, 0.7, 0.95, 0.75, 1];
    Animated.sequence(steps.map(v =>
      Animated.timing(flick, { toValue: v, duration: DUR / steps.length, useNativeDriver: true })
    )).start();
  }, [flick]);
  return (
    <View style={st.center}>
      <Brand t={t} color="#ddd2b4" style={{ opacity: flick, textShadowColor: 'rgba(232,220,191,0.3)', textShadowRadius: 12 }} />
    </View>
  );
}

/* — ASSIMILATION: глитч — красный/циановый дубли дёргаются и сходятся в единое — */
function AssimFx({ t }) {
  const jx = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const jolt = (v, d) => Animated.timing(jx, { toValue: v, duration: d, useNativeDriver: true });
    Animated.sequence([
      jolt(1, 90), jolt(-1, 70), jolt(0.6, 90), jolt(-0.4, 110), jolt(0.8, 80), jolt(0, 160),
      Animated.delay(500),
      jolt(0.5, 60), jolt(0, 90),
    ]).start();
  }, [jx]);
  const off = (m) => jx.interpolate({ inputRange: [-1, 1], outputRange: [-6 * m, 6 * m] });
  return (
    <View style={st.center}>
      <Brand t={t} color="#5ad0ff" style={{ position: 'absolute', opacity: 0.55, transform: [{ translateX: off(-1) }] }} />
      <Brand t={t} color={t.accent} style={{ position: 'absolute', opacity: 0.6, transform: [{ translateX: off(1) }] }} />
      <Brand t={t} color={t.txt} style={{ transform: [{ translateX: off(0.15) }] }} />
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject, zIndex: 100, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' },
  brand: { fontSize: 52, fontWeight: '900', letterSpacing: 10 },
});
