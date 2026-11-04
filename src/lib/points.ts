import { supabase } from './supabase';

/** Places random power-up points ("hideouts") in the area; the host can drag them afterwards. */
export async function generatePoints(gameId: string): Promise<{ count: number }> {
  const { data, error } = await supabase.functions.invoke('generate_points', { body: { game_id: gameId } });
  if (error) throw new Error((await (error as any).context?.json?.().catch(() => null))?.error ?? error.message);
  return data;
}
