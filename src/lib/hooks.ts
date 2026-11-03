import { useEffect, useState } from 'react';
import { supabase, type Game, type LivePosition, type Player } from './supabase';

export function useUserId() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setId(data.session?.user.id ?? null));
  }, []);
  return id;
}

/** Fetches rows and refetches on every Realtime change (RLS applies to both). */
function useLiveQuery<T>(table: string, filterCol: string, value: string, single: boolean) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const q = supabase.from(table).select('*').eq(filterCol, value);
      const { data: rows } = single ? await q.maybeSingle() : await q;
      if (alive) setData(rows as T);
    };
    load();
    const channel = supabase
      .channel(`${table}:${value}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `${filterCol}=eq.${value}` }, load)
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [table, filterCol, value, single]);
  return data;
}

export const useGame = (id: string) => useLiveQuery<Game>('games', 'id', id, true);
export const usePlayers = (gameId: string) => useLiveQuery<Player[]>('players', 'game_id', gameId, false) ?? [];
export const useLivePositions = (gameId: string) =>
  useLiveQuery<LivePosition[]>('live_positions', 'game_id', gameId, false) ?? [];
