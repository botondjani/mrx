/** Great-circle distance in meters. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Current zone radius; mirrors public.zone_radius() on the server. */
export function zoneRadius(
  game: { radius_m: number | null; started_at: string | null; ends_at: string | null; config: Record<string, any> },
  atMs: number,
): number | null {
  if (!game.radius_m) return null;
  if (!game.started_at || !game.ends_at) return game.radius_m;
  const hsEnd = new Date(game.started_at).getTime() + (game.config.head_start_s ?? 300) * 1000;
  const progress = Math.min(1, Math.max(0, (atMs - hsEnd) / Math.max(1000, new Date(game.ends_at).getTime() - hsEnd)));
  return game.radius_m * (1 - (1 - (game.config.zone_final_pct ?? 100) / 100) * progress);
}
