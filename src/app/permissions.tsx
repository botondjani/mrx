import Constants from 'expo-constants';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState, Linking, ScrollView, Text, View } from 'react-native';
import { Btn, C, FONT, ui } from '../components/ui';
import { PERMISSION_STEPS, permissionStatus } from '../lib/permissions';

type Step = (typeof PERMISSION_STEPS)[number];

// Why each permission is needed, and exactly what to tap in the system dialog.
const INFO: Record<Step, { icon: string; title: string; why: string; tap: string; button: string }> = {
  foreground: {
    icon: '📍',
    title: 'Helyhozzáférés',
    why: 'Ebből tudja a játék, hol vagy a pályán.',
    tap: 'Válaszd: „Az alkalmazás használata közben”.',
    button: 'Hely engedélyezése',
  },
  background: {
    icon: '🔒',
    title: 'Hely a háttérben',
    why: 'Hogy zsebben, lezárt képernyővel is menjen a játék. Csak játék közben fut, ezt állandó értesítés jelzi.',
    tap: 'A megnyíló beállításokban válaszd: „Mindig engedélyezés”, majd lépj vissza.',
    button: 'Beállítás megnyitása',
  },
  notifications: {
    icon: '🔔',
    title: 'Értesítések',
    why: 'Lezárt telefonon is szól és rezeg: felfedés, közelség, pályaelhagyás, játék vége.',
    tap: 'Válaszd: „Engedélyezés”.',
    button: 'Értesítések engedélyezése',
  },
  battery: {
    icon: '🔋',
    title: 'Akkumulátor-kivétel',
    why: 'Különben az energiatakarékos mód lezárt képernyőn leállíthatja a játékot.',
    tap: 'Válaszd: „Engedélyezés”.',
    button: 'Kivétel engedélyezése',
  },
};

export default function Permissions() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [status, setStatus] = useState<Record<Step, boolean> | null>(null);
  const [blocked, setBlocked] = useState(false); // denied for good → only the app settings help

  const refresh = useCallback(async () => {
    const s = await permissionStatus();
    if (PERMISSION_STEPS.every((k) => s[k])) router.replace((next ?? '/') as any);
    else setStatus(s);
  }, [next]);

  // Re-check when returning from system settings.
  useFocusEffect(
    useCallback(() => {
      refresh();
      const sub = AppState.addEventListener('change', (st) => st === 'active' && refresh());
      return () => sub.remove();
    }, [refresh]),
  );

  const current = status ? PERMISSION_STEPS.find((k) => !status[k]) : undefined;

  async function request() {
    if (blocked) {
      setBlocked(false);
      return Linking.openSettings();
    }
    let res: { granted: boolean; canAskAgain?: boolean } | null = null;
    if (current === 'foreground') res = await Location.requestForegroundPermissionsAsync();
    if (current === 'background') res = await Location.requestBackgroundPermissionsAsync();
    if (current === 'notifications') res = await Notifications.requestPermissionsAsync();
    if (current === 'battery') {
      await IntentLauncher.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', {
        data: `package:${Constants.expoConfig?.android?.package ?? 'com.botondjani.mrx'}`,
      });
    }
    if (res && !res.granted && res.canAskAgain === false) setBlocked(true);
    await refresh();
  }

  if (!status || !current) return <View style={ui.screen} />;
  const done = PERMISSION_STEPS.filter((k) => status[k]).length;

  return (
    <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={[ui.screen, { flexGrow: 1 }]}>
      <Text style={[ui.stamp, { color: C.gold }]}>Felkészülés az ügyre · {done}/4</Text>
      <Text style={ui.muted}>A játékhoz 4 engedély kell. Mindegyik csak a játékhoz kell, máskor nem használjuk.</Text>
      {PERMISSION_STEPS.map((k) => {
        const i = INFO[k];
        const active = k === current;
        return (
          <View
            key={k}
            style={{
              flexDirection: 'row', gap: 12, padding: 12, borderRadius: 6,
              borderWidth: 1, borderColor: active ? C.gold : C.line, opacity: status[k] || active ? 1 : 0.55,
            }}
          >
            <Text style={{ fontSize: 26 }}>{status[k] ? '✅' : i.icon}</Text>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ fontFamily: FONT, fontSize: 17, color: C.ink }}>{i.title}</Text>
              <Text style={ui.muted}>{i.why}</Text>
              {active ? <Text style={[ui.p, { color: C.gold }]}>{blocked ? 'Itt korábban elutasítottad – kapcsold be a beállításokban.' : i.tap}</Text> : null}
            </View>
          </View>
        );
      })}
      <View style={{ flex: 1 }} />
      <Btn title={blocked ? 'App-beállítások megnyitása' : INFO[current].button} onPress={request} />
    </ScrollView>
  );
}
