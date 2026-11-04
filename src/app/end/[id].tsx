import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Battery from 'expo-battery';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Btn, ui } from '../../components/ui';
import { useGame, usePlayers, useUserId } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';
import { BATTERY_START_KEY } from '../../lib/tracking';

type Stats = {
  duration_s: number;
  head_start_s: number;
  players: { name: string; role: 'mrx' | 'detective' | null; distance_m: number; items: number }[];
};

const minSec = (s: number) => `${Math.floor(s / 60)} perc ${s % 60} mp`;
const km = (m: number) => `${(m / 1000).toLocaleString('hu-HU', { maximumFractionDigits: 2 })} km`;

export default function End() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const userId = useUserId();
  const [stats, setStats] = useState<Stats | null>(null);
  const [battery, setBattery] = useState<string | null>(null);

  useEffect(() => {
    if (game?.status !== 'finished') return;
    supabase.rpc('game_stats', { p_game: id }).then(({ data }) => data && setStats(data as Stats));
  }, [game?.status, id]);

  // Battery used on this phone during the game (measured from tracking start).
  useEffect(() => {
    (async () => {
      const start = JSON.parse((await AsyncStorage.getItem(BATTERY_START_KEY)) ?? 'null');
      if (!start) return;
      const used = Math.round((start.level - (await Battery.getBatteryLevelAsync())) * 100);
      setBattery(`${used}% / ${Math.round((Date.now() - start.at) / 60000)} perc`);
    })();
  }, []);

  if (!game) return <View style={ui.screen} />;

  const me = players.find((p) => p.user_id === userId);
  const mrx = players.find((p) => p.role === 'mrx');
  const catcher = players.find((p) => p.id === game.caught_by);
  const iWon = me && (game.winner === 'mrx') === (me.role === 'mrx');

  return (
    <ScrollView style={{ backgroundColor: '#fff' }} contentContainerStyle={[ui.screen, { flexGrow: 1 }]}>
      <Text style={[ui.h1, { fontSize: 32, textAlign: 'center' }]}>{iWon ? 'Nyertél!' : 'Vesztettél'}</Text>
      <Text style={[ui.p, { textAlign: 'center' }]}>
        {game.winner === 'mrx'
          ? `${mrx?.name ?? 'Mr. X'} (Mr. X) kibírta a játékidő végéig.`
          : `${catcher?.name ?? 'Egy detektív'} elkapta Mr. X-et (${mrx?.name ?? '?'}).`}
      </Text>
      {stats ? (
        <>
          <Text style={ui.p}>Mr. X túlélési ideje: {minSec(stats.duration_s)}</Text>
          {stats.players.map((p) => (
            <Text key={p.name} style={ui.p}>
              {p.name} {p.role === 'mrx' ? '(Mr. X)' : ''}: {km(p.distance_m)}, {p.items} tárgy
            </Text>
          ))}
        </>
      ) : null}
      {battery ? <Text style={ui.p}>Akkumulátor ezen a telefonon: {battery}</Text> : null}
      <View style={{ flex: 1 }} />
      <Btn title="Visszajátszás" variant="secondary" onPress={() => router.push(`/replay/${id}`)} />
      <Btn title="Vissza a főoldalra" onPress={() => router.replace('/')} />
    </ScrollView>
  );
}
