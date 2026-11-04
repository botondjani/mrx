import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { Btn, C, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame } from '../../lib/hooks';
import { generatePoints } from '../../lib/points';
import { supabase } from '../../lib/supabase';

export default function Area() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redraw, setRedraw] = useState(0);

  useEffect(() => {
    if (!game || center) return;
    setRadius(game.radius_m ?? (game.config.radius_default_m as number));
    if (game.center_lat != null && game.center_lng != null) setCenter({ lat: game.center_lat, lng: game.center_lng });
    else {
      // Last known fix first (instant); fresh fix may take long indoors. Budapest as fallback.
      const fallback = setTimeout(() => setCenter((c) => c ?? { lat: 47.4979, lng: 19.0402 }), 5000);
      Location.getLastKnownPositionAsync()
        .then((p) => p ?? Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }))
        .then((p) => setCenter((c) => c ?? { lat: p.coords.latitude, lng: p.coords.longitude }))
        .catch(() => {});
      return () => clearTimeout(fallback);
    }
  }, [game, center]);

  async function save() {
    if (!center || !radius) return;
    const { error } = await supabase.rpc('set_area', {
      p_game: id, p_lat: center.lat, p_lng: center.lng, p_radius_m: Math.round(radius),
    });
    if (error) return setError(huError(error));
    // New area → fresh random points inside it (the host can drag them afterwards).
    setBusy(true);
    await generatePoints(id).catch(() => {});
    setBusy(false);
    router.back();
  }

  async function myLocation() {
    const p = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({}).catch(() => null));
    if (p) {
      setCenter({ lat: p.coords.latitude, lng: p.coords.longitude });
      setRedraw((n) => n + 1);
    } else setError('Nem sikerült lekérni a helyzetedet.');
  }

  if (!game || !center || !radius) return <View style={ui.screen} />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <GameMap
          center={center}
          radiusM={radius}
          onPress={([lng, lat]) => setCenter({ lat, lng })}
          onCenterMove={(lat, lng) => setCenter({ lat, lng })}
          redrawKey={redraw}
        />
      </View>
      <View style={[ui.screen, { flex: 0 }]}>
        <Text style={ui.muted}>Húzd az arany középpontot, vagy koppints oda, ahová a kör közepét szeretnéd.</Text>
        <Text style={ui.p}>Sugár: {(radius / 1000).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} km</Text>
        <Slider
          minimumValue={game.config.radius_min_m as number}
          maximumValue={game.config.radius_max_m as number}
          step={100}
          value={radius}
          onValueChange={setRadius}
          minimumTrackTintColor={C.gold}
          maximumTrackTintColor={C.line}
          thumbTintColor={C.gold}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn title="Saját helyemre" variant="secondary" onPress={myLocation} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn title={busy ? 'Pontok…' : 'Mentés'} onPress={save} disabled={busy} />
          </View>
        </View>
        {error ? <Text style={ui.error}>{error}</Text> : null}
      </View>
    </View>
  );
}
