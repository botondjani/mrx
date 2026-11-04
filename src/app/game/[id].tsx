import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { GameMap, type MapPlayer } from '../../components/GameMap';
import { Btn, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, useItems, useLivePositions, usePlayers, usePoints, useReveals, useSnapshots, useUserId } from '../../lib/hooks';
import { distanceM } from '../../lib/geo';
import { supabase } from '../../lib/supabase';
import { getLastOkAt, startTracking, stopTracking } from '../../lib/tracking';

type Candidate = { player_id: string; name: string; nearby: boolean };

const ITEM_LABEL = { radar: 'Radar', tracker: 'Nyomkövető', decoy: 'Csali', fog: 'Köd' } as const;
const ITEM_HELP = {
  radar: 'Mr. X azonnal felfedődik.',
  tracker: 'Mr. X 60 másodpercig élőben látszik.',
  decoy: 'A következő felfedés egy általad kijelölt hamis pontot mutat (300 m-en belül).',
  fog: 'A következő felfedés kimarad.',
} as const;

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const players = usePlayers(id);
  const live = useLivePositions(id); // RLS: only what my role may see
  const reveals = useReveals(id);
  const snapshots = useSnapshots(id); // RLS: Mr. X's periodic view of the detectives
  const points = usePoints(id);
  const items = useItems(id).filter((i) => !i.used_at);
  const [decoyItem, setDecoyItem] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const userId = useUserId();
  const [now, setNow] = useState(Date.now());
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = players.find((p) => p.user_id === userId);
  const isMrx = me?.role === 'mrx';

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const status = game?.status;
  const cfg = game?.config;
  useEffect(() => {
    if (status === 'running' && cfg) {
      startTracking(id, cfg.fast_report_interval_s * 1000, cfg.report_interval_s * 1000).catch((e) => setError(huError(e)));
    }
    if (status === 'finished') {
      stopTracking().finally(() => router.replace(`/end/${id}`));
    }
  }, [status, cfg, id]);

  if (!game || !cfg || game.center_lat == null || game.center_lng == null || !game.started_at || !game.ends_at) {
    return <View style={ui.screen} />;
  }

  const headStartEnd = new Date(game.started_at).getTime() + cfg.head_start_s * 1000;
  const inHeadStart = now < headStartEnd;
  const remaining = new Date(game.ends_at).getTime() - now;

  const myLive = live.find((l) => l.player_id === me?.id);
  const pickupRadius = cfg.pickup_radius_m as number;
  const nearPoint = myLive
    ? points.find((p) => (!p.active_after || new Date(p.active_after).getTime() <= now) && distanceM(myLive, p) <= pickupRadius)
    : undefined;
  const offlineFor = getLastOkAt() ? now - getLastOkAt() : 0;

  const nameOf = (playerId: string) => players.find((x) => x.id === playerId)?.name ?? '?';
  const mapPlayers: MapPlayer[] = live.map((l) => ({
    id: l.player_id, name: nameOf(l.player_id), lat: l.lat, lng: l.lng, isMe: l.player_id === me?.id,
  }));
  if (isMrx) {
    // Latest snapshot per detective, drawn faded.
    const latest = new Map<string, (typeof snapshots)[number]>();
    for (const s of snapshots) latest.set(s.player_id, s);
    for (const s of latest.values()) {
      mapPlayers.push({ id: s.player_id, name: `${nameOf(s.player_id)} (${mmss(now - new Date(s.taken_at).getTime())})`, lat: s.lat, lng: s.lng, isMe: false, stale: true });
    }
  }

  async function caught() {
    Alert.alert('Elkaptak?', 'Csak akkor nyomd meg, ha egy detektív tényleg megérintett. A játék ezzel véget ér.', [
      { text: 'Mégse', style: 'cancel' },
      {
        text: 'Igen, elkaptak',
        style: 'destructive',
        onPress: async () => {
          const { data, error } = await supabase.rpc('catch_candidates', { p_game: id });
          if (error) setError(huError(error));
          else setCandidates(data as Candidate[]);
        },
      },
    ]);
  }

  async function pickup(pointId: string) {
    setError(null);
    const { data, error } = await supabase.rpc('pickup_point', { p_point: pointId });
    if (error) setError(huError(error));
    else setInfo(`Felvetted: ${ITEM_LABEL[data as keyof typeof ITEM_LABEL]}`);
  }

  async function applyItem(itemId: string, kind: keyof typeof ITEM_LABEL, lngLat?: [number, number]) {
    if (kind === 'decoy' && !lngLat) {
      setDecoyItem(itemId);
      setInfo('Koppints a térképre, ahová a csalit teszed (300 m-en belül).');
      return;
    }
    setError(null);
    const { error } = await supabase.rpc('use_item', { p_item: itemId, p_lat: lngLat?.[1] ?? null, p_lng: lngLat?.[0] ?? null });
    setDecoyItem(null);
    if (error) setError(huError(error));
    else setInfo(`${ITEM_LABEL[kind]} használva. ${ITEM_HELP[kind]}`);
  }

  function confirmUse(itemId: string, kind: keyof typeof ITEM_LABEL) {
    Alert.alert(ITEM_LABEL[kind], ITEM_HELP[kind], [
      { text: 'Mégse', style: 'cancel' },
      { text: 'Használom', onPress: () => applyItem(itemId, kind) },
    ]);
  }

  async function confirmCatch(c: Candidate) {
    const { error } = await supabase.rpc('confirm_catch', { p_game: id, p_detective: c.player_id });
    if (error) setError(huError(error));
    setCandidates(null);
  }

  let banner: string;
  if (inHeadStart) banner = isMrx ? `Előny: ${mmss(headStartEnd - now)} – tűnj el!` : `Várj a kezdőpontnál: ${mmss(headStartEnd - now)}`;
  else banner = `Hátralévő idő: ${mmss(remaining)}`;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <GameMap
          center={{ lat: game.center_lat, lng: game.center_lng }}
          radiusM={game.radius_m}
          players={mapPlayers}
          reveals={reveals}
          points={points.map((p) => {
            const cooldown = p.active_after ? new Date(p.active_after).getTime() - now : 0;
            return { id: p.id, label: cooldown > 0 ? mmss(cooldown) : (p.name ?? ''), lat: p.lat, lng: p.lng };
          })}
          onPress={decoyItem ? (lngLat) => applyItem(decoyItem, 'decoy', lngLat) : undefined}
        />
      </View>
      <View style={[ui.screen, { flex: 0 }]}>
        <Text style={ui.h1}>{isMrx ? 'Te vagy Mr. X' : 'Detektív vagy'}</Text>
        <Text style={[ui.p, { fontWeight: '700' }]}>{banner}</Text>
        {!isMrx && reveals.length ? (
          <Text style={ui.p}>Utolsó felfedés: {mmss(now - new Date(reveals[reveals.length - 1].revealed_at).getTime())} perce</Text>
        ) : null}
        {offlineFor > 30_000 ? (
          <Text style={[ui.error, { fontWeight: '700' }]}>Nincs kapcsolat – utolsó küldés {mmss(offlineFor)} perce</Text>
        ) : null}
        {error ? <Text style={ui.error}>{error}</Text> : null}
        {info ? <Text style={ui.p}>{info}</Text> : null}
        {nearPoint && !candidates ? (
          <Btn title={`Felvétel: ${nearPoint.name ?? 'power-up'}`} onPress={() => pickup(nearPoint.id)} />
        ) : null}
        {items.length && !candidates ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {items.map((i) => (
              <View key={i.id} style={{ flex: 1 }}>
                <Btn
                  title={decoyItem === i.id ? 'Csali: koppints…' : ITEM_LABEL[i.kind]}
                  variant="secondary"
                  onPress={() => (decoyItem === i.id ? setDecoyItem(null) : confirmUse(i.id, i.kind))}
                />
              </View>
            ))}
          </View>
        ) : null}
        {candidates ? (
          <View style={{ maxHeight: 220 }}>
            <Text style={ui.p}>Ki kapott el?</Text>
            <FlatList
              data={candidates}
              keyExtractor={(c) => c.player_id}
              renderItem={({ item }) => (
                <Pressable onPress={() => confirmCatch(item)} style={{ paddingVertical: 10, borderBottomWidth: 1, borderColor: '#eee' }}>
                  <Text style={[ui.p, item.nearby && { fontWeight: '700' }]}>
                    {item.name}
                    {item.nearby ? ' (közel)' : ''}
                  </Text>
                </Pressable>
              )}
            />
            <Btn title="Mégse" variant="secondary" onPress={() => setCandidates(null)} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Btn title="Napló" variant="secondary" onPress={() => router.push('/log')} />
            </View>
            {isMrx ? (
              <View style={{ flex: 1 }}>
                <Btn title="Elkaptak" variant="danger" onPress={caught} />
              </View>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}
