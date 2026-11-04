import { useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { C } from './ui';

// Leaflet in a WebView with OpenStreetMap tiles. (MapLibre Native rendered only a black
// surface on the target devices; a WebView map is the robust option.)

// The library's iOS/Android/Windows prop intersection collapses to `never` with the current
// React Native typings, so the few props used here are typed explicitly.
const Web = WebView as unknown as ComponentType<{
  ref: Ref<WebView>;
  style: StyleProp<ViewStyle>;
  originWhitelist: string[];
  source: { html: string; baseUrl: string };
  onMessage: (e: WebViewMessageEvent) => void;
}>;

export type MapPlayer = { id: string; name: string; lat: number; lng: number; isMe: boolean; stale?: boolean };
export type MapReveal = { lat: number; lng: number; heading: number | null };
export type MapPoint = { id: string; label: string; lat: number; lng: number };

type Props = {
  center: { lat: number; lng: number };
  radiusM?: number | null; // original area (power-ups stay here)
  zoneRadiusM?: number | null; // current, shrinking zone (defaults to radiusM)
  players?: MapPlayer[];
  reveals?: MapReveal[]; // oldest first; the last one pulses
  points?: MapPoint[];
  onPress?: (lngLat: [number, number]) => void;
  onPointMove?: (id: string, lat: number, lng: number) => void; // makes points draggable
  onCenterMove?: (lat: number, lng: number) => void; // shows a draggable center pin
  redrawKey?: number; // bump to force a redraw (e.g. snap a rejected drag back)
};

const HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<style>
  html,body,#map{margin:0;height:100%;background:${C.bg}}
  /* Noir look: inverted OSM tiles. */
  .leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9) saturate(.5)}
  .leaflet-control-attribution{background:rgba(14,15,19,.7)!important;color:${C.muted}}
  .leaflet-control-attribution a{color:${C.gold}}
  .lbl{background:transparent;border:0;box-shadow:none;color:${C.ink};font:12px monospace;
       text-shadow:0 0 3px ${C.bg},0 0 3px ${C.bg}}
  .lbl:before{display:none}
  .pulse{width:18px;height:18px;border-radius:50%;background:${C.crimson};border:2px solid ${C.ink};
         box-shadow:0 0 0 0 ${C.crimson};animation:p 1.4s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(200,50,60,.7)}100%{box-shadow:0 0 0 22px rgba(200,50,60,0)}}
</style></head><body><div id="map"></div><script>
  const map = L.map('map', { zoomControl: false, attributionControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let centered = false;
  const send = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
  map.on('click', (e) => send({ t: 'click', lat: e.latlng.lat, lng: e.latlng.lng }));
  const pin = (color, size) => L.divIcon({ className: '', iconSize: [size, size],
    html: '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + color +
      ';border:3px solid ${C.gold};box-shadow:0 0 0 6px rgba(212,167,60,.25)"></div>' });
  const label = (m, t) => t && m.bindTooltip(t, { permanent: true, direction: 'bottom', className: 'lbl', offset: [0, 6] });
  window.setState = (s) => {
    layer.clearLayers();
    const zone = s.zoneRadiusM || s.radiusM;
    const followers = []; // everything that moves with the circle while its center is dragged
    if (s.radiusM && zone < s.radiusM - 1) L.circle([s.center.lat, s.center.lng], { radius: s.radiusM, color: '${C.muted}',
      weight: 1, dashArray: '2 6', fill: false, interactive: false }).addTo(layer);
    if (zone) followers.push(L.circle([s.center.lat, s.center.lng], { radius: zone, color: '${C.gold}', weight: 2,
      dashArray: '6 4', fillColor: '${C.gold}', fillOpacity: 0.06, interactive: false }).addTo(layer));
    // First render: fit the whole area.
    if (!centered) {
      const dLat = (s.radiusM || 500) / 111320, dLng = dLat / Math.cos(s.center.lat * Math.PI / 180);
      map.fitBounds([[s.center.lat - dLat, s.center.lng - dLng], [s.center.lat + dLat, s.center.lng + dLng]]);
      centered = true;
    }
    for (const p of s.points) {
      if (s.dragPoints) {
        // Draggable (host, lobby): bigger touch target.
        const m = L.marker([p.lat, p.lng], { draggable: true, icon: pin('${C.ink}', 22) }).addTo(layer);
        m.on('dragend', () => { const ll = m.getLatLng(); send({ t: 'point', id: p.id, lat: ll.lat, lng: ll.lng }); });
        label(m, p.label);
        followers.push(m);
      } else {
        const m = L.circleMarker([p.lat, p.lng], { radius: 7, color: '${C.gold}', weight: 2,
          fillColor: '${C.ink}', fillOpacity: 1, interactive: false }).addTo(layer);
        label(m, p.label);
        followers.push(m);
      }
    }
    if (s.dragCenter) {
      const m = L.marker([s.center.lat, s.center.lng], { draggable: true, icon: pin('${C.gold}', 30) }).addTo(layer);
      // The whole circle (and its points) follows the pin while dragging.
      const start = followers.map((f) => f.getLatLng());
      m.on('drag', () => {
        const ll = m.getLatLng(), dLat = ll.lat - s.center.lat, dLng = ll.lng - s.center.lng;
        followers.forEach((f, i) => f.setLatLng([start[i].lat + dLat, start[i].lng + dLng]));
      });
      m.on('dragend', () => { const ll = m.getLatLng(); send({ t: 'center', lat: ll.lat, lng: ll.lng }); });
    }
    const r = s.reveals;
    if (r.length > 1) L.polyline(r.map((x) => [x.lat, x.lng]), { color: '${C.crimson}', opacity: .45, weight: 2,
      dashArray: '4 4', interactive: false }).addTo(layer);
    r.slice(0, -1).forEach((x, i, a) => L.circleMarker([x.lat, x.lng], { radius: 6, stroke: false,
      fillColor: '${C.crimson}', fillOpacity: .15 + .5 * (i + 1) / a.length, interactive: false }).addTo(layer));
    const last = r[r.length - 1];
    if (last) {
      if (last.heading != null) {
        const a = last.heading * Math.PI / 180, d = 80;
        L.polyline([[last.lat, last.lng], [last.lat + d * Math.cos(a) / 111320,
          last.lng + d * Math.sin(a) / (111320 * Math.cos(last.lat * Math.PI / 180))]],
          { color: '${C.crimson}', weight: 4, interactive: false }).addTo(layer);
      }
      L.marker([last.lat, last.lng], { interactive: false,
        icon: L.divIcon({ className: '', html: '<div class="pulse"></div>', iconSize: [22, 22] }) }).addTo(layer);
    }
    for (const p of s.players) label(L.circleMarker([p.lat, p.lng], { radius: 8, color: '${C.bg}', weight: 2,
      fillColor: p.isMe ? '${C.steel}' : '${C.gold}', fillOpacity: p.stale ? .5 : 1, interactive: false }).addTo(layer), p.name);
  };
  window.ReactNativeWebView.postMessage('ready');
</script></body></html>`;

export function GameMap({
  center, radiusM, zoneRadiusM, players = [], reveals = [], points = [], onPress, onPointMove, onCenterMove, redrawKey,
}: Props) {
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // Re-injected only when the serialized state actually changes.
  const state = JSON.stringify({
    center,
    radiusM: radiusM ?? null,
    zoneRadiusM: zoneRadiusM ? Math.round(zoneRadiusM / 10) * 10 : null, // 10 m steps: fewer redraws
    players,
    reveals,
    points,
    dragPoints: !!onPointMove,
    dragCenter: !!onCenterMove,
    redrawKey,
  });

  useEffect(() => {
    if (ready) web.current?.injectJavaScript(`window.setState(${state});true;`);
  }, [ready, state]);

  return (
    <Web
      ref={web}
      style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]}
      originWhitelist={['*']}
      // A real origin, so OSM tile requests carry a Referer as their usage policy asks.
      source={{ html: HTML, baseUrl: 'https://mrx.botondjani.app/' }}
      onMessage={(e) => {
        if (e.nativeEvent.data === 'ready') return setReady(true);
        const m = JSON.parse(e.nativeEvent.data);
        if (m.t === 'click') onPress?.([m.lng, m.lat]);
        if (m.t === 'point') onPointMove?.(m.id, m.lat, m.lng);
        if (m.t === 'center') onCenterMove?.(m.lat, m.lng);
      }}
    />
  );
}
