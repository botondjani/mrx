import { Camera, GeoJSONSource, Layer, Map, type PressEvent } from '@maplibre/maplibre-react-native';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { useEffect, useState } from 'react';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';
import { MAP_STYLE_URL } from '../lib/env';
import { circlePolygon } from '../lib/geo';

export type MapPlayer = { id: string; name: string; lat: number; lng: number; isMe: boolean; stale?: boolean };
export type MapReveal = { lat: number; lng: number; heading: number | null };
export type MapPoint = { id: string; label: string; lat: number; lng: number };

type Props = {
  center: { lat: number; lng: number };
  radiusM?: number | null;
  players?: MapPlayer[];
  reveals?: MapReveal[]; // oldest first; the last one pulses
  points?: MapPoint[];
  onPress?: (lngLat: [number, number]) => void;
};

const pointFeature = (lng: number, lat: number, properties: Record<string, unknown> = {}): Feature<Point> => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates: [lng, lat] },
});

/** Short line from the reveal point in the movement direction (~80 m). */
function headingLine(r: MapReveal): Feature<LineString> | null {
  if (r.heading == null) return null;
  const a = (r.heading * Math.PI) / 180;
  const dLat = (80 * Math.cos(a)) / 111320;
  const dLng = (80 * Math.sin(a)) / (111320 * Math.cos((r.lat * Math.PI) / 180));
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[r.lng, r.lat], [r.lng + dLng, r.lat + dLat]] } };
}

export function GameMap({ center, radiusM, players = [], reveals = [], points = [], onPress }: Props) {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (!reveals.length) return;
    const t = setInterval(() => setPulse((p) => !p), 700);
    return () => clearInterval(t);
  }, [reveals.length]);

  const playerFc: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: players.map((p) => pointFeature(p.lng, p.lat, { name: p.name, me: p.isMe, stale: !!p.stale })),
  };
  // Older reveals fade out: opacity grows with index.
  const trailFc: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: reveals.slice(0, -1).map((r, i, arr) => pointFeature(r.lng, r.lat, { o: 0.15 + (0.5 * (i + 1)) / arr.length })),
  };
  const last = reveals[reveals.length - 1];
  const lastLine = last ? headingLine(last) : null;
  const pointFc: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: points.map((p) => pointFeature(p.lng, p.lat, { label: p.label })),
  };

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={MAP_STYLE_URL}
      onPress={onPress ? (e: NativeSyntheticEvent<PressEvent>) => onPress(e.nativeEvent.lngLat) : undefined}
    >
      <Camera initialViewState={{ center: [center.lng, center.lat], zoom: 14 }} />
      {radiusM ? (
        <GeoJSONSource id="area" data={circlePolygon(center.lat, center.lng, radiusM)}>
          <Layer id="area-fill" type="fill" paint={{ 'fill-color': '#1e6bd6', 'fill-opacity': 0.08 }} />
          <Layer id="area-line" type="line" paint={{ 'line-color': '#1e6bd6', 'line-width': 2 }} />
        </GeoJSONSource>
      ) : null}
      <GeoJSONSource id="points" data={pointFc}>
        <Layer id="points-dot" type="circle" paint={{ 'circle-radius': 7, 'circle-color': '#f2b705', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' }} />
        <Layer
          id="points-label"
          type="symbol"
          layout={{ 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top' }}
          paint={{ 'text-halo-color': '#fff', 'text-halo-width': 1.5 }}
        />
      </GeoJSONSource>
      {reveals.length > 1 ? (
        <GeoJSONSource
          id="reveal-trail-line"
          data={{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: reveals.map((r) => [r.lng, r.lat]) } }}
        >
          <Layer id="reveal-trail-line" type="line" paint={{ 'line-color': '#c0392b', 'line-opacity': 0.35, 'line-width': 2, 'line-dasharray': [2, 2] }} />
        </GeoJSONSource>
      ) : null}
      <GeoJSONSource id="reveal-trail" data={trailFc}>
        <Layer id="reveal-trail-dot" type="circle" paint={{ 'circle-radius': 6, 'circle-color': '#c0392b', 'circle-opacity': ['get', 'o'] }} />
      </GeoJSONSource>
      {lastLine ? (
        <GeoJSONSource id="reveal-heading" data={lastLine}>
          <Layer id="reveal-heading" type="line" paint={{ 'line-color': '#c0392b', 'line-width': 4 }} />
        </GeoJSONSource>
      ) : null}
      {last ? (
        <GeoJSONSource id="reveal-last" data={pointFeature(last.lng, last.lat)}>
          <Layer id="reveal-halo" type="circle" paint={{ 'circle-radius': pulse ? 26 : 14, 'circle-color': '#c0392b', 'circle-opacity': 0.25 }} />
          <Layer id="reveal-dot" type="circle" paint={{ 'circle-radius': 9, 'circle-color': '#c0392b', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' }} />
        </GeoJSONSource>
      ) : null}
      <GeoJSONSource id="players" data={playerFc}>
        <Layer
          id="players-dot"
          type="circle"
          paint={{
            'circle-radius': 8,
            'circle-color': ['case', ['get', 'me'], '#1e6bd6', '#2a9d58'],
            'circle-opacity': ['case', ['get', 'stale'], 0.5, 1],
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
