import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Btn, ui } from '../components/ui';
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
    <View style={ui.screen}>
      <Text style={ui.h1}>Városi bújócska</Text>
      <Text style={ui.p}>Neved</Text>
      <TextInput style={ui.input} value={name} onChangeText={setName} maxLength={24} placeholder="pl. Bence" />
      <Btn title="Új játék létrehozása" onPress={() => enter('create_game')} disabled={busy} />
      <View style={{ height: 16 }} />
      <Text style={ui.p}>Csatlakozás kóddal</Text>
      <TextInput
        style={ui.input}
        value={code}
        onChangeText={(t) => setCode(t.toUpperCase())}
        autoCapitalize="characters"
        maxLength={6}
        placeholder="ABC123"
      />
      <Btn title="Csatlakozás" variant="secondary" onPress={() => enter('join_game')} disabled={busy} />
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <View style={{ flex: 1 }} />
      <Btn title="Napló" variant="secondary" onPress={() => router.push('/log')} />
    </View>
  );
}
