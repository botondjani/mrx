import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { Btn, C, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame, usePoints } from '../../lib/hooks';
import { generatePoints } from '../../lib/points';
import { supabase } from '../../lib/supabase';

type LatLng = { lat: number; lng: number };

/**
 * Area editor (host, lobby). Every change is saved immediately: moving the circle shifts its
 * power-up points with it (server-side), resizing re-draws random points; points are draggable.
 */
export default function Area() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const points = usePoints(id);
  const [center, setCenter] = useState<LatLng | null>(null);
  const [radius, setRadius] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redraw, setRedraw] = useState(0);
  const powerups = game?.config.powerups_enabled !== false;

  async function save(c: LatLng, r: number, regenerate: boolean) {
    setCenter(c);
    setError(null);
    setBusy(true);
    const { error } = await supabase.rpc('set_area', { p_game: id, p_lat: c.lat, p_lng: c.lng, p_radius_m: Math.round(r) });
    if (error) setError(huError(error));
    else if (regenerate && powerups) await generatePoints(id).catch((e) => setError(huError(e)));
    setBusy(false);
    setRedraw((n) => n + 1);
  }

  // First open: start from the saved area, or from my location (Budapest as fallback) and save it.
  useEffect(() => {
    if (!game || center) return;
    const r = game.radius_m ?? (game.config.radius_default_m as number);
    setRadius(r);
    if (game.center_lat != null && game.center_lng != null) return setCenter({ lat: game.center_lat, lng: game.center_lng });
    let done = false;
    const start = (c: LatLng) => {
      if (done) return;
      done = true;
      save(c, r, true);
    };
    const fallback = setTimeout(() => start({ lat: 47.4979, lng: 19.0402 }), 5000);
    Location.getLastKnownPositionAsync()
      .then((p) => p ?? Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }))
      .then((p) => start({ lat: p.coords.latitude, lng: p.coords.longitude }))
      .catch(() => {});
    return () => clearTimeout(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, center]);

  async function myLocation() {
    const p = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({}).catch(() => null));
    if (p && radius) save({ lat: p.coords.latitude, lng: p.coords.longitude }, radius, false);
    else setError('Nem sikerült lekérni a helyzetedet.');
  }

  async function movePoint(pointId: string, lat: number, lng: number) {
    const { error } = await supabase.rpc('move_point', { p_point: pointId, p_lat: lat, p_lng: lng });
    if (error) {
      setError(huError(error));
      setRedraw((n) => n + 1); // snap back
    }
  }

  if (!game || !center || !radius) return <View style={ui.screen}><Text style={ui.muted}>Pálya betöltése…</Text></View>;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1 }}>
        <GameMap
          center={center}
          radiusM={radius}
          points={powerups ? points.map((p, i) => ({ id: p.id, label: String(i + 1), lat: p.lat, lng: p.lng })) : []}
          onPress={([lng, lat]) => save({ lat, lng }, radius, false)}
          onCenterMove={(lat, lng) => save({ lat, lng }, radius, false)}
          onPointMove={powerups ? movePoint : undefined}
          redrawKey={redraw}
        />
      </View>
      <View style={[ui.screen, { flex: 0, gap: 8 }]}>
        <Text style={ui.muted}>
          Húzd az arany középpontot – a kör a pontokkal együtt mozog.{powerups ? ' A pontok egyenként is húzhatók.' : ''}
        </Text>
        <Text style={ui.p}>Sugár: {(radius / 1000).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} km</Text>
        <Slider
          minimumValue={game.config.radius_min_m as number}
          maximumValue={game.config.radius_max_m as number}
          step={100}
          value={radius}
          onValueChange={setRadius}
          onSlidingComplete={(r) => save(center, r, true)}
          minimumTrackTintColor={C.gold}
          maximumTrackTintColor={C.line}
          thumbTintColor={C.gold}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn title="Saját helyemre" variant="secondary" onPress={myLocation} disabled={busy} />
          </View>
          {powerups ? (
            <View style={{ flex: 1 }}>
              <Btn title="Újrasorsolás" variant="secondary" onPress={() => save(center, radius, true)} disabled={busy} />
            </View>
          ) : null}
        </View>
        <Btn title={busy ? 'Mentés…' : 'Kész'} onPress={() => router.back()} disabled={busy} />
        {error ? <Text style={ui.error}>{error}</Text> : null}
      </View>
    </View>
  );
}
