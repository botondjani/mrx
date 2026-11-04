import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { Btn, C, FONT, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, usePoints } from '../../lib/hooks';
import { generatePoints } from '../../lib/points';
import { supabase } from '../../lib/supabase';

export default function Points() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const points = usePoints(id);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [redraw, setRedraw] = useState(0);

  async function generate() {
    setBusy(true);
    try {
      const { count } = await generatePoints(id);
      setMsg(`${count} rejtekhely a pályán. Húzd őket a térképen, ahová szeretnéd.`);
    } catch (e) {
      setMsg(huError(e));
    } finally {
      setBusy(false);
    }
  }

  async function move(pointId: string, lat: number, lng: number) {
    const { error } = await supabase.rpc('move_point', { p_point: pointId, p_lat: lat, p_lng: lng });
    if (error) {
      setMsg(huError(error));
      setRedraw((n) => n + 1); // snap the marker back
    } else setMsg(null);
  }

  async function remove(pointId: string) {
    const { error } = await supabase.rpc('delete_point', { p_point: pointId });
    if (error) setMsg(huError(error));
  }

  if (!game || game.center_lat == null || game.center_lng == null) {
    return <View style={ui.screen}><Text style={ui.p}>Előbb jelöld ki a pályát.</Text></View>;
  }
  const labelled = points.map((p, i) => ({ ...p, label: String(i + 1) }));
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 3 }}>
        <GameMap
          center={{ lat: game.center_lat, lng: game.center_lng }}
          radiusM={game.radius_m}
          points={labelled}
          onPointMove={move}
          redrawKey={redraw}
        />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[ui.screen, { flex: 0, gap: 8 }]}>
        <Text style={ui.muted}>{msg ?? 'Tartsd lenyomva és húzd a pontot az új helyére (a körön belül bárhová).'}</Text>
        <Btn title={points.length ? 'Újrasorsolás' : 'Pontok sorsolása'} variant="secondary" onPress={generate} disabled={busy} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {labelled.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => remove(p.id)}
              style={{ paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: C.line }}
            >
              <Text style={{ color: C.ink, fontFamily: FONT }}>{p.label} ✕</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
