import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { GameMap } from '../../components/GameMap';
import { Btn, ui } from '../../components/ui';
import { huError } from '../../lib/errors';
import { useGame } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';

export default function Area() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useGame(id);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!game || center) return;
    setRadius(game.radius_m ?? (game.config.radius_default_m as number));
    if (game.center_lat != null && game.center_lng != null) setCenter({ lat: game.center_lat, lng: game.center_lng });
    else
      Location.getCurrentPositionAsync({}).then(
        (p) => setCenter({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => setCenter({ lat: 47.4979, lng: 19.0402 }), // Budapest fallback
      );
  }, [game, center]);

  async function save() {
    if (!center || !radius) return;
    const { error } = await supabase.rpc('set_area', {
      p_game: id, p_lat: center.lat, p_lng: center.lng, p_radius_m: Math.round(radius),
    });
    if (error) setError(huError(error));
    else router.back();
  }

  if (!game || !center || !radius) return <View style={ui.screen} />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <GameMap center={center} radiusM={radius} onPress={([lng, lat]) => setCenter({ lat, lng })} />
      </View>
      <View style={[ui.screen, { flex: 0 }]}>
        <Text style={ui.p}>Koppints a térképre a középpont kijelöléséhez.</Text>
        <Text style={ui.p}>Sugár: {(radius / 1000).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} km</Text>
        <Slider
          minimumValue={game.config.radius_min_m as number}
          maximumValue={game.config.radius_max_m as number}
          step={100}
          value={radius}
          onValueChange={setRadius}
        />
        <Btn title="Mentés" onPress={save} />
        {error ? <Text style={ui.error}>{error}</Text> : null}
      </View>
    </View>
  );
}
