import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { GameMap, type MapPlayer } from '../../components/GameMap';
import { Btn, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, useLivePositions, usePlayers, useUserId } from '../../lib/hooks';
import { startTracking, stopTracking } from '../../lib/tracking';

export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const live = useLivePositions(id); // RLS: only what my role may see
  const userId = useUserId();
  const [error, setError] = useState<string | null>(null);
  const me = players.find((p) => p.user_id === userId);

  useEffect(() => {
    if (game?.status !== 'running') return;
    startTracking(id, (game.config.report_interval_s as number) * 1000).catch((e) => setError(huError(e)));
  }, [game?.status, game?.config, id]);

  if (!game || game.center_lat == null || game.center_lng == null) return <View style={ui.screen} />;

  const mapPlayers: MapPlayer[] = live.map((l) => {
    const p = players.find((x) => x.id === l.player_id);
    return { id: l.player_id, name: p?.name ?? '?', lat: l.lat, lng: l.lng, isMe: p?.user_id === userId };
  });

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <GameMap center={{ lat: game.center_lat, lng: game.center_lng }} radiusM={game.radius_m} players={mapPlayers} />
      </View>
      <View style={[ui.screen, { flex: 0 }]}>
        <Text style={ui.h1}>{me?.role === 'mrx' ? 'Te vagy Mr. X' : 'Detektív vagy'}</Text>
        <Text style={ui.p}>
          {game.status === 'running' ? `A térképen ${mapPlayers.length} játékos látszik.` : 'A játék véget ért.'}
        </Text>
        {error ? <Text style={ui.error}>{error}</Text> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn title="Napló" variant="secondary" onPress={() => router.push('/log')} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn
              title="Kilépés"
              variant="danger"
              onPress={async () => {
                await stopTracking();
                router.replace('/');
              }}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
