import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Btn, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, usePlayers, useUserId } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';

const ROLE_LABEL = { mrx: 'Mr. X', detective: 'detektív' } as const;

export default function Lobby() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const userId = useUserId();
  const [error, setError] = useState<string | null>(null);
  const isHost = !!game && game.host_user_id === userId;

  useEffect(() => {
    if (game?.status === 'running') router.replace(`/game/${id}`);
  }, [game?.status, id]);

  async function call(fn: string, args: Record<string, unknown>) {
    setError(null);
    const { error } = await supabase.rpc(fn, args);
    if (error) setError(huError(error));
  }

  if (!game) return <View style={ui.screen} />;
  const minPlayers = game.config.min_players as number;

  return (
    <View style={ui.screen}>
      <Text style={ui.p}>Csatlakozási kód</Text>
      <Text selectable style={{ fontSize: 40, fontWeight: '800', letterSpacing: 6 }}>{game.code}</Text>
      <Text style={ui.p}>
        Játékosok ({players.length}/{game.config.max_players as number})
        {isHost ? ' – koppints valakire, hogy ő legyen Mr. X' : ''}
      </Text>
      <FlatList
        data={players}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <Pressable
            disabled={!isHost}
            onPress={() => call('assign_roles', { p_game: id, p_mrx_player: item.id })}
            style={{ paddingVertical: 10, borderBottomWidth: 1, borderColor: '#eee', flexDirection: 'row' }}
          >
            <Text style={[ui.p, { flex: 1, fontWeight: item.user_id === userId ? '700' : '400' }]}>
              {item.name}
              {item.is_host ? ' (házigazda)' : ''}
            </Text>
            <Text style={[ui.p, item.role === 'mrx' && { color: '#c0392b', fontWeight: '700' }]}>
              {item.role ? ROLE_LABEL[item.role] : '–'}
            </Text>
          </Pressable>
        )}
      />
      {isHost ? (
        <>
          <Text style={ui.p}>
            Pálya: {game.center_lat ? `${((game.radius_m ?? 0) / 1000).toLocaleString('hu-HU')} km sugarú kör` : 'nincs kijelölve'}
          </Text>
          <Btn title="Pálya kijelölése" variant="secondary" onPress={() => router.push(`/area/${id}`)} />
          <Btn title="Mr. X sorsolása" variant="secondary" onPress={() => call('assign_roles', { p_game: id, p_mrx_player: null })} />
          <Btn
            title={players.length < minPlayers ? `Indítás (min. ${minPlayers} játékos)` : 'Játék indítása'}
            onPress={() => call('start_game', { p_game: id })}
          />
        </>
      ) : (
        <Text style={ui.p}>Várakozás a házigazdára…</Text>
      )}
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </View>
  );
}
