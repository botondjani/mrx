import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { Btn, ui } from '../components/ui';
import { nextPermissionStep, type PermissionStep } from '../lib/permissions';

const STEPS: Record<Exclude<PermissionStep, 'done'>, { n: number; title: string; body: string; button: string }> = {
  foreground: {
    n: 1,
    title: 'Helyhozzáférés',
    body: 'A játék a telefonod GPS-ével követi, hol vagy a pályán. A következő ablakban válaszd: „Az alkalmazás használata közben”.',
    button: 'Tovább',
  },
  background: {
    n: 2,
    title: '„Mindig engedélyezés”',
    body: 'A játék zsebben, lezárt képernyővel is működik, ezért a helyzetedet a háttérben is el kell küldeni. A megnyíló beállításokban válaszd: „Mindig engedélyezés”. Játék közben ezt egy állandó értesítés jelzi, a játék végén a követés leáll.',
    button: 'Beállítások megnyitása',
  },
  notifications: {
    n: 3,
    title: 'Értesítések',
    body: 'Lezárt telefonon értesítés és rezgés jelzi a fontos eseményeket: Mr. X felfedését, ha közel vannak hozzád, ha kiléptél a pályáról, és a játék végét.',
    button: 'Értesítések engedélyezése',
  },
  battery: {
    n: 4,
    title: 'Akkumulátor-optimalizálás',
    body: 'Az Android energiatakarékossága lezárt képernyőn leállíthatja a játékot. Engedélyezd, hogy a Mr. X kivétel legyen az akkumulátor-optimalizálás alól.',
    button: 'Kivétel engedélyezése',
  },
};

export default function Permissions() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [step, setStep] = useState<PermissionStep | null>(null);

  const refresh = useCallback(async () => {
    const s = await nextPermissionStep();
    if (s === 'done') router.replace((next ?? '/') as any);
    else setStep(s);
  }, [next]);

  // Re-check when returning from system settings.
  useFocusEffect(
    useCallback(() => {
      refresh();
      const sub = AppState.addEventListener('change', (st) => st === 'active' && refresh());
      return () => sub.remove();
    }, [refresh]),
  );

  async function request() {
    if (step === 'foreground') await Location.requestForegroundPermissionsAsync();
    if (step === 'background') await Location.requestBackgroundPermissionsAsync();
    if (step === 'notifications') await Notifications.requestPermissionsAsync();
    if (step === 'battery') {
      const pkg = Constants.expoConfig?.android?.package ?? 'com.botondjani.mrx';
      await IntentLauncher.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', {
        data: `package:${pkg}`,
      });
    }
    await refresh();
  }

  if (!step || step === 'done') return <View style={ui.screen} />;
  const s = STEPS[step];
  return (
    <View style={ui.screen}>
      <Text style={ui.p}>{s.n}. lépés / 4</Text>
      <Text style={ui.h1}>{s.title}</Text>
      <Text style={ui.p}>{s.body}</Text>
      <View style={{ flex: 1 }} />
      <Btn title={s.button} onPress={request} />
    </View>
  );
}
