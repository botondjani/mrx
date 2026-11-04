import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { ui } from '../components/ui';
import { huError } from '../lib/errors';
import { setupNotifications } from '../lib/notifications';
import { ensureSession } from '../lib/supabase';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setupNotifications();
    ensureSession().then(() => setReady(true), (e) => setError(huError(e)));
  }, []);

  if (!ready) {
    return (
      <View style={[ui.screen, { justifyContent: 'center', alignItems: 'center' }]}>
        {error ? <Text style={ui.error}>{error}</Text> : <ActivityIndicator size="large" />}
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerBackTitle: 'Vissza' }}>
      <Stack.Screen name="index" options={{ title: 'Mr. X' }} />
      <Stack.Screen name="permissions" options={{ title: 'Engedélyek' }} />
      <Stack.Screen name="lobby/[id]" options={{ title: 'Váróterem' }} />
      <Stack.Screen name="area/[id]" options={{ title: 'Pálya kijelölése' }} />
      <Stack.Screen name="game/[id]" options={{ title: 'Játék', headerBackVisible: false }} />
      <Stack.Screen name="points/[id]" options={{ title: 'Power-up pontok' }} />
      <Stack.Screen name="end/[id]" options={{ title: 'Játék vége', headerBackVisible: false }} />
      <Stack.Screen name="replay/[id]" options={{ title: 'Visszajátszás' }} />
      <Stack.Screen name="log" options={{ title: 'Napló' }} />
    </Stack>
  );
}
