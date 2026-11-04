import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Btn, C, FONT, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { nextPermissionStep } from '../../lib/permissions';
import { supabase, type Game } from '../../lib/supabase';

/** Opened from an invite link (mrx://join/CODE): only the name is asked, then straight to the lobby. */
export default function Join() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('player.name').then((n) => n && setName(n));
  }, []);

  async function join() {
    if (!name.trim()) return setError('Add meg a neved.');
    setBusy(true);
    setError(null);
    try {
      await AsyncStorage.setItem('player.name', name.trim());
      const { data, error } = await supabase.rpc('join_game', { p_code: code, p_name: name.trim() });
      if (error) throw error;
      const game = data as Game;
      const target = game.status === 'lobby' ? `/lobby/${game.id}` : `/game/${game.id}`;
      if ((await nextPermissionStep()) !== 'done') router.replace({ pathname: '/permissions', params: { next: target } });
      else router.replace(target as any);
    } catch (e) {
      setError(huError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[ui.screen, { justifyContent: 'center' }]}>
      <Text style={[ui.stamp, { color: C.gold, textAlign: 'center' }]}>Meghívtak egy ügybe</Text>
      <Text style={{ fontFamily: FONT, fontSize: 44, letterSpacing: 8, color: C.gold, textAlign: 'center' }}>
        {String(code).toUpperCase()}
      </Text>
      <Text style={ui.muted}>Fedőneved</Text>
      <TextInput style={ui.input} value={name} onChangeText={setName} maxLength={24} placeholder="pl. Bence" placeholderTextColor={C.muted} />
      <Btn title="Csatlakozás" onPress={join} disabled={busy} />
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <Btn title="Mégse" variant="secondary" onPress={() => router.replace('/')} />
    </View>
  );
}
