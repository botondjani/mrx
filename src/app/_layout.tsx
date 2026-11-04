import { SpecialElite_400Regular, useFonts } from '@expo-google-fonts/special-elite';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Btn, C, FONT, ui } from '../components/ui';
import { huError } from '../lib/errors';
import { setupNotifications } from '../lib/notifications';
import { ensureSession } from '../lib/supabase';

/** Shown instead of a blank screen when a screen throws. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={[ui.screen, { justifyContent: 'center' }]}>
      <Text style={[ui.stamp, { color: C.crimson }]}>Hiba történt</Text>
      <Text style={ui.p}>Valami elromlott ezen a képernyőn. Próbáld újra; ha ismétlődik, küldd el ezt az üzenetet:</Text>
      <Text selectable style={ui.muted}>{error.message}</Text>
      <Btn title="Újra" onPress={retry} />
    </View>
  );
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontsLoaded] = useFonts({ SpecialElite_400Regular });

  useEffect(() => {
    setupNotifications();
    ensureSession().then(() => setReady(true), (e) => setError(huError(e)));
  }, []);

  if (!ready || !fontsLoaded) {
    return (
      <View style={[ui.screen, { justifyContent: 'center', alignItems: 'center' }]}>
        {error ? <Text style={ui.error}>{error}</Text> : <ActivityIndicator size="large" color={C.gold} />}
      </View>
    );
  }

  return (
    <>
    <StatusBar style="light" />
    <Stack
      screenOptions={{
        headerBackTitle: 'Vissza',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.gold,
        headerTitleStyle: { fontFamily: FONT, color: C.ink },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: C.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="permissions" options={{ title: 'Engedélyek' }} />
      <Stack.Screen name="lobby/[id]" options={{ title: 'Váróterem' }} />
      <Stack.Screen name="area/[id]" options={{ title: 'Pálya kijelölése' }} />
      <Stack.Screen name="game/[id]" options={{ title: 'Játék', headerBackVisible: false }} />
      <Stack.Screen name="end/[id]" options={{ title: 'Játék vége', headerBackVisible: false }} />
      <Stack.Screen name="replay/[id]" options={{ title: 'Visszajátszás' }} />
      <Stack.Screen name="join/[code]" options={{ title: 'Meghívó' }} />
      <Stack.Screen name="log" options={{ title: 'Napló' }} />
    </Stack>
    </>
  );
}
