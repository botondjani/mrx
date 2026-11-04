import Slider from '@react-native-community/slider';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { GameMap, type MapPlayer } from '../../components/GameMap';
import { Btn, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { zoneRadius } from '../../lib/geo';
import { useGame, usePlayers, useUserId } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';

type Replay = {
  started_at: string;
  finished_at: string;
  saved: boolean;
  tracks: [string, number, number, number][]; // player_id, t (epoch s), lat, lng – sorted by t
  reveals: [number, number, number][]; // t, lat, lng
};

const SPEED = 60; // 1 s of playback = 1 min of game

export default function ReplayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const userId = useUserId();
  const [replay, setReplay] = useState<Replay | null>(null);
  const [t, setT] = useState(0); // seconds since start
  const [playing, setPlaying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase.rpc('game_replay', { p_game: id }).then(({ data, error }) => {
      if (error) setMsg(huError(error));
      else setReplay(data as Replay);
    });
  }, [id]);

  const start = replay ? new Date(replay.started_at).getTime() / 1000 : 0;
  const total = replay ? new Date(replay.finished_at).getTime() / 1000 - start : 0;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setT((x) => Math.min(total, x + SPEED / 5)), 200);
    return () => clearInterval(timer);
  }, [playing, total]);
  useEffect(() => {
    if (t >= total) setPlaying(false);
  }, [t, total]);

  if (!game || game.center_lat == null || game.center_lng == null) return <View style={ui.screen} />;
  if (!replay) return <View style={ui.screen}><Text style={ui.p}>{msg ?? 'Betöltés…'}</Text></View>;

  // Latest position per player up to the current time.
  const now = start + t;
  const latest = new Map<string, [number, number]>();
  for (const [pid, ts, lat, lng] of replay.tracks) {
    if (ts > now) break;
    latest.set(pid, [lat, lng]);
  }
  const mapPlayers: MapPlayer[] = [...latest].map(([pid, [lat, lng]]) => {
    const p = players.find((x) => x.id === pid);
    return { id: pid, name: `${p?.name ?? '?'}${p?.role === 'mrx' ? ' (X)' : ''}`, lat, lng, isMe: p?.role === 'mrx' }; // highlight Mr. X
  });
  const reveals = replay.reveals.filter(([ts]) => ts <= now).map(([, lat, lng]) => ({ lat, lng, heading: null }));
  const isHost = game.host_user_id === userId;

  async function save() {
    const { error } = await supabase.rpc('save_replay', { p_game: id });
    if (error) setMsg(huError(error));
    else {
      setReplay((r) => (r ? { ...r, saved: true } : r));
      setMsg('Elmentve – nem törlődik 24 óra után.');
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <GameMap center={{ lat: game.center_lat, lng: game.center_lng }} radiusM={game.radius_m} zoneRadiusM={zoneRadius(game, now * 1000)} players={mapPlayers} reveals={reveals} />
      </View>
      <View style={[ui.screen, { flex: 0 }]}>
        <Text style={ui.p}>
          {Math.floor(t / 60)}:{String(Math.floor(t % 60)).padStart(2, '0')} / {Math.floor(total / 60)}:
          {String(Math.floor(total % 60)).padStart(2, '0')} (Mr. X: kék pont, felfedések: piros)
        </Text>
        <Slider minimumValue={0} maximumValue={total} value={t} onValueChange={(v) => { setPlaying(false); setT(v); }} />
        <Btn title={playing ? 'Szünet' : t >= total ? 'Újra' : 'Lejátszás (60×)'} onPress={() => {
          if (t >= total) setT(0);
          setPlaying((p) => !p);
        }} />
        {isHost && !replay.saved ? <Btn title="Visszajátszás mentése" variant="secondary" onPress={save} /> : null}
        {msg ? <Text style={ui.p}>{msg}</Text> : null}
      </View>
    </View>
  );
}
