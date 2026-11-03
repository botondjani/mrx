import { Camera, GeoJSONSource, Layer, Map, type PressEvent } from '@maplibre/maplibre-react-native';
import type { FeatureCollection, Point } from 'geojson';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';
import { MAP_STYLE_URL } from '../lib/env';
import { circlePolygon } from '../lib/geo';

export type MapPlayer = { id: string; name: string; lat: number; lng: number; isMe: boolean };

type Props = {
  center: { lat: number; lng: number };
  radiusM?: number | null;
  showArea?: boolean;
  players?: MapPlayer[];
  onPress?: (lngLat: [number, number]) => void;
};

export function GameMap({ center, radiusM, showArea = true, players = [], onPress }: Props) {
  const playerFeatures: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: players.map((p) => ({
      type: 'Feature',
      id: p.id,
      properties: { name: p.name, me: p.isMe },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
  };

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={MAP_STYLE_URL}
      onPress={onPress ? (e: NativeSyntheticEvent<PressEvent>) => onPress(e.nativeEvent.lngLat) : undefined}
    >
      <Camera initialViewState={{ center: [center.lng, center.lat], zoom: 14 }} />
      {showArea && radiusM ? (
        <GeoJSONSource id="area" data={circlePolygon(center.lat, center.lng, radiusM)}>
          <Layer id="area-fill" type="fill" paint={{ 'fill-color': '#1e6bd6', 'fill-opacity': 0.08 }} />
          <Layer id="area-line" type="line" paint={{ 'line-color': '#1e6bd6', 'line-width': 2 }} />
        </GeoJSONSource>
      ) : null}
      <GeoJSONSource id="players" data={playerFeatures}>
        <Layer
          id="players-dot"
          type="circle"
          paint={{
            'circle-radius': 8,
            'circle-color': ['case', ['get', 'me'], '#1e6bd6', '#2a9d58'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          }}
        />
        <Layer
          id="players-label"
          type="symbol"
          layout={{ 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top' }}
          paint={{ 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }}
        />
      </GeoJSONSource>
    </Map>
  );
}
