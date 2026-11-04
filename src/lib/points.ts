import { supabase } from './supabase';

// Public Overpass instances, tried in order. The main one rejects some clients (406), so the
// phone tries mirrors too and, if none answers, falls back to random hideouts in the area.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function fetchOverpass(query: string): Promise<unknown[] | null> {
  for (const url of OVERPASS_URLS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'mrx-game/0.2 (+https://github.com/botondjani/mrx)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (res.ok) return (await res.json()).elements ?? [];
    } catch {
      // try the next instance
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function invoke(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('generate_points', { body });
  if (!error) return { data };
  return { payload: await (error as any).context?.json?.().catch(() => null), error };
}

/**
 * Asks the server to pick power-up points. On a cache miss the server returns the Overpass
 * query, the phone fetches OSM places itself (cloud IPs are blocked); if that fails too,
 * the server places random hideouts. `source` tells which one happened.
 */
export async function generatePoints(gameId: string): Promise<{ count: number; enough: boolean; source: 'osm' | 'random' }> {
  let res = await invoke({ game_id: gameId });
  if (res.data) return { ...res.data, source: 'osm' };
  if (res.payload?.error !== 'need_overpass') throw new Error(res.payload?.error ?? res.error?.message);

  const elements = await fetchOverpass(res.payload.query);
  if (elements) {
    res = await invoke({ game_id: gameId, elements });
    if (res.data && res.data.enough) return { ...res.data, source: 'osm' };
  }
  res = await invoke({ game_id: gameId, random: true });
  if (res.data) return { ...res.data, source: 'random' };
  throw new Error(res.payload?.error ?? res.error?.message);
}
