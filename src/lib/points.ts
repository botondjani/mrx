import { supabase } from './supabase';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/**
 * Asks the server to pick power-up points. Public Overpass servers block cloud IPs, so on a
 * cache miss the server returns the query and the phone fetches the OSM data itself.
 */
export async function generatePoints(gameId: string): Promise<{ count: number; enough: boolean }> {
  let body: Record<string, unknown> = { game_id: gameId };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.functions.invoke('generate_points', { body });
    if (!error) return data;
    const payload = await (error as any).context?.json?.().catch(() => null);
    if (payload?.error !== 'need_overpass') throw new Error(payload?.error ?? error.message);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(payload.query),
    });
    if (!res.ok) throw new Error(`overpass_${res.status}`);
    body = { game_id: gameId, elements: (await res.json()).elements ?? [] };
  }
  throw new Error('overpass_failed');
}
