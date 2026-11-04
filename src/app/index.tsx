import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Btn, C, FONT, ui } from '../components/ui';
import { huError } from '../lib/errors';
import { nextPermissionStep } from '../lib/permissions';
import { supabase, type Game } from '../lib/supabase';

export default function Home() {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('player.name').then((n) => n && setName(n));
  }, []);

  async function enter(fn: 'create_game' | 'join_game') {
    setError(null);
    if (!name.trim()) return setError('Add meg a neved.');
    if (fn === 'join_game' && code.trim().length !== 6) return setError('A kód 6 karakteres.');
    setBusy(true);
    try {
      await AsyncStorage.setItem('player.name', name.trim());
      const args = fn === 'create_game' ? { p_name: name.trim() } : { p_code: code.trim(), p_name: name.trim() };
      const { data, error } = await supabase.rpc(fn, args);
      if (error) throw error;
      const game = data as Game;
      const target = game.status === 'lobby' ? `/lobby/${game.id}` : `/game/${game.id}`;
      // Permissions are needed before the game starts; ask for them right away.
      if ((await nextPermissionStep()) !== 'done') router.push({ pathname: '/permissions', params: { next: target } });
      else router.push(target as any);
    } catch (e) {
      setError(huError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[ui.screen, { paddingTop: 72 }]}>
      <View style={{ alignItems: 'center', marginBottom: 24 }}>
        <Text style={{ fontSize: 64 }}>🕵️</Text>
        <Text style={{ fontFamily: FONT, fontSize: 56, color: C.ink, letterSpacing: 4 }}>
          MR. <Text style={{ color: C.crimson }}>X</Text>
        </Text>
        <Text style={[ui.stamp, { color: C.gold }]}>Városi hajsza · szigorúan titkos</Text>
      </View>
      <Text style={ui.muted}>Fedőneved</Text>
      <TextInput
        style={ui.input}
        value={name}
        onChangeText={setName}
        maxLength={24}
        placeholder="pl. Bence"
        placeholderTextColor={C.muted}
      />
      <Btn title="Új ügy nyitása" onPress={() => enter('create_game')} disabled={busy} />
      <View style={{ height: 16 }} />
      <Text style={ui.muted}>Ügyszám (csatlakozási kód)</Text>
      <TextInput
        style={ui.input}
        value={code}
        onChangeText={(t) => setCode(t.toUpperCase())}
        autoCapitalize="characters"
        maxLength={6}
        placeholder="ABC123"
        placeholderTextColor={C.muted}
      />
      <Btn title="Csatlakozás" variant="secondary" onPress={() => enter('join_game')} disabled={busy} />
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <View style={{ flex: 1 }} />
      <Btn title="Napló" variant="secondary" onPress={() => router.push('/log')} />
    </View>
  );
}
