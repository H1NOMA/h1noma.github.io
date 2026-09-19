// КОМИК · приложение. Шапка с переключателем сеттинга (каждый — своим цветом),
// нижние вкладки, заставка входа, deep links (?g=… / komik://g/…).
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, Linking } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './src/theme.js';
import { SessionProvider } from './src/session.js';
import { themeFor } from '../native-core/index.js';
import Splash from './src/Splash.js';
import { deeplink, parseGameId } from './src/deeplink.js';
import NewsScreen from './src/screens/NewsScreen.js';
import ArchiveScreen from './src/screens/ArchiveScreen.js';
import CharactersScreen from './src/screens/CharactersScreen.js';
import BoardScreen from './src/screens/BoardScreen.js';
import ScheduleScreen from './src/screens/ScheduleScreen.js';
import ProfileScreen from './src/screens/ProfileScreen.js';

const TABS = [
  { key: 'news', label: 'Новости', screen: NewsScreen },
  { key: 'archive', label: 'Архив', screen: ArchiveScreen },
  { key: 'chars', label: 'Игроки', screen: CharactersScreen },
  { key: 'games', label: 'Игры', screen: ScheduleScreen },
  { key: 'board', label: 'Доска', screen: BoardScreen },
  { key: 'profile', label: 'Профиль', screen: ProfileScreen },
];

function Shell() {
  const { theme, setting, setSetting, settings, titles, ready } = useTheme();
  const [tab, setTab] = useState('news');
  const [menuOpen, setMenuOpen] = useState(false);
  const [splash, setSplash] = useState(true);
  const Screen = (TABS.find(t => t.key === tab) || TABS[0]).screen;
  const s = styles(theme);

  // deep links: холодный старт + ссылки в работающее приложение → вкладка «Игры»
  useEffect(() => {
    const handle = (url) => {
      const id = parseGameId(url);
      if (id) { deeplink.set(id); setTab('games'); }
    };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => sub.remove();
  }, []);

  // пока сеттинг не восстановлен с устройства — держим пустой фон (заставка стартует в верной теме)
  if (!ready) return <View style={{ flex: 1, backgroundColor: theme.bg }} />;

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      {splash && <Splash setting={setting} onDone={() => setSplash(false)} />}

      {/* шапка: тап по названию сеттинга открывает список */}
      <View style={s.header}>
        <Text style={s.brand}>КОМИК</Text>
        <Pressable onPress={() => setMenuOpen(true)} hitSlop={10}>
          <Text style={s.setting}>{stripTags(titles[setting])}</Text>
        </Pressable>
      </View>

      <View style={s.body}>
        <Screen />
      </View>

      {/* нижние вкладки */}
      <View style={s.tabs}>
        {TABS.map(t => (
          <Pressable key={t.key} style={s.tab} onPress={() => setTab(t.key)}>
            <Text style={[s.tabT, tab === t.key && s.tabTOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* выпадающий список сеттингов — каждый своим цветом */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={s.scrim} onPress={() => setMenuOpen(false)}>
          <View style={s.menu}>
            {settings.map(g => {
              const gt = themeFor(g);
              return (
                <Pressable key={g} style={s.menuItem} onPress={() => { setSetting(g); setMenuOpen(false); }}>
                  <Text style={[s.menuTxt, { color: gt.accent }, g === setting && s.menuTxtCur]}>
                    {stripTags(titles[g])}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }

const styles = (t) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: t.bg2, borderBottomColor: t.line2, borderBottomWidth: 1 },
  brand: { color: t.accent, fontWeight: '800', letterSpacing: 2 },
  setting: { color: t.txt, fontWeight: '700', letterSpacing: 3 },
  body: { flex: 1 },
  tabs: { flexDirection: 'row', borderTopColor: t.line2, borderTopWidth: 1, backgroundColor: t.bg2 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabT: { color: t.muted, fontWeight: '600' },
  tabTOn: { color: t.accent },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', paddingTop: 70 },
  menu: { backgroundColor: t.glass2, borderColor: t.line2, borderWidth: 1, borderRadius: 16, padding: 8, minWidth: 240 },
  menuItem: { paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  menuTxt: { fontWeight: '700', letterSpacing: 2, fontSize: 16 },
  menuTxtCur: { textDecorationLine: 'underline' },
});
