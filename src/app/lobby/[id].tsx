import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { Btn, C, FONT, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, usePlayers, usePoints, useUserId } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';

const ROLE_LABEL = { mrx: 'Mr. X', detective: 'detektív' } as const;

export default function Lobby() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const points = usePoints(id);
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

  const chip = (label: string, active: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      onPress={onPress}
      style={{ padding: 8, borderRadius: 6, borderWidth: 1, borderColor: C.gold, backgroundColor: active ? C.gold : 'transparent' }}
    >
      <Text style={{ color: active ? C.bg : C.gold, fontFamily: FONT }}>{label}</Text>
    </Pressable>
  );
  const zonePct = (game.config.zone_final_pct as number | undefined) ?? 100;

  return (
    <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={ui.screen}>
      <Text style={[ui.stamp, { color: C.muted }]}>Ügyszám – ezzel csatlakoznak a többiek</Text>
      <Text selectable style={{ fontSize: 44, fontFamily: FONT, letterSpacing: 8, color: C.gold }}>{game.code}</Text>
      <Text style={ui.p}>
        Játékosok ({players.length}/{game.config.max_players as number})
        {isHost ? ' – koppints valakire, hogy ő legyen Mr. X' : ''}
      </Text>
      {players.map((item) => (
          <Pressable
            key={item.id}
            disabled={!isHost}
            onPress={() => call('assign_roles', { p_game: id, p_mrx_player: item.id })}
            style={ui.row}
          >
            <Text style={[ui.p, { flex: 1, fontWeight: item.user_id === userId ? '700' : '400' }]}>
              {item.name}
              {item.is_host ? ' (házigazda)' : ''}
            </Text>
            <Text style={[ui.stamp, { color: item.role === 'mrx' ? C.crimson : C.gold }]}>
              {item.role ? ROLE_LABEL[item.role] : '–'}
            </Text>
          </Pressable>
      ))}
      {game.center_lat != null && game.center_lng != null ? (
        <Pressable
          disabled={!isHost}
          onPress={() => router.push(`/area/${id}`)}
          style={{ height: 220, borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderColor: C.line }}
        >
          <View pointerEvents="none" style={{ flex: 1 }}>
            <GameMap
              center={{ lat: game.center_lat, lng: game.center_lng }}
              radiusM={game.radius_m}
              zoneRadiusM={game.radius_m ? (game.radius_m * zonePct) / 100 : null}
              points={points.map((p) => ({ id: p.id, label: '', lat: p.lat, lng: p.lng }))}
            />
          </View>
        </Pressable>
      ) : null}
      {isHost ? (
        <>
          <Text style={ui.p}>
            Pálya: {game.center_lat ? `${((game.radius_m ?? 0) / 1000).toLocaleString('hu-HU')} km sugarú kör` : 'nincs kijelölve'}
          </Text>
          <Btn title="Pálya kijelölése" variant="secondary" onPress={() => router.push(`/area/${id}`)} />
          <Btn title={`Power-up pontok (${points.length})`} variant="secondary" onPress={() => router.push(`/points/${id}`)} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={ui.p}>Játékidő:</Text>
            {(game.config.duration_options_min as number[]).map((m) =>
              chip(`${m} perc`, game.config.duration_min === m, () => call('set_options', { p_game: id, p_options: { duration_min: m } })),
            )}
          </View>
          <View style={{ gap: 6 }}>
            <Text style={ui.p}>Kör szűkülése a játék végéig:</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[100, 75, 50, 25].map((pct) =>
                chip(pct === 100 ? 'Nincs' : `${pct}%-ra`, zonePct === pct, () =>
                  call('set_options', { p_game: id, p_options: { zone_final_pct: pct } }),
                ),
              )}
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={ui.p}>Tömegközlekedés engedélyezve</Text>
            <Switch
              value={game.config.transit_allowed as boolean}
              onValueChange={(v) => call('set_options', { p_game: id, p_options: { transit_allowed: v } })}
              trackColor={{ true: C.gold, false: C.line }}
              thumbColor={C.ink}
            />
          </View>
          <Btn title="Mr. X sorsolása" variant="secondary" onPress={() => call('assign_roles', { p_game: id, p_mrx_player: null })} />
          <Btn
            title={players.length < minPlayers ? `Indítás (min. ${minPlayers} játékos)` : 'Játék indítása'}
            onPress={() => call('start_game', { p_game: id })}
          />
        </>
      ) : (
        <Text style={ui.p}>
          Játékidő: {game.config.duration_min as number} perc · Tömegközlekedés: {game.config.transit_allowed ? 'engedélyezve' : 'tilos'}
          {zonePct < 100 ? ` · a kör ${zonePct}%-ra szűkül` : ''}
          {'\n'}Várakozás a házigazdára…
        </Text>
      )}
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </ScrollView>
  );
}
