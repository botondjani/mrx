import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { Btn, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, usePoints } from '../../lib/hooks';
import { generatePoints } from '../../lib/points';
import { supabase } from '../../lib/supabase';

const KIND = { square: 'tér', park: 'park', stop: 'megálló', statue: 'szobor/emlékmű' } as Record<string, string>;

export default function Points() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const points = usePoints(id);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setMsg('Pontok keresése az OpenStreetMap-ben…');
    try {
      const data = await generatePoints(id);
      setMsg(data.enough ? `${data.count} pont generálva.` : `Csak ${data.count} pontot találtam – próbálj nagyobb pályát.`);
    } catch (e) {
      setMsg(huError(e));
    } finally {
      setBusy(false);
    }
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
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <GameMap center={{ lat: game.center_lat, lng: game.center_lng }} radiusM={game.radius_m} points={labelled} />
      </View>
      <View style={[ui.screen, { flex: 1 }]}>
        <Btn title={points.length ? 'Újragenerálás' : 'Pontok generálása'} onPress={generate} disabled={busy} />
        {msg ? <Text style={ui.p}>{msg}</Text> : null}
        <FlatList
          data={labelled}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 }}>
              <Text style={[ui.p, { flex: 1 }]}>
                {item.label}. {item.name ?? 'névtelen'} ({KIND[item.kind ?? ''] ?? item.kind})
              </Text>
              <Btn title="Törlés" variant="secondary" onPress={() => remove(item.id)} />
            </View>
          )}
        />
      </View>
    </View>
  );
}
