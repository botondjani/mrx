import { useEffect, useState } from 'react';
import { supabase, type DetectiveSnapshot, type Game, type LivePosition, type Player, type Item, type PointRow, type Reveal } from './supabase';

export function useUserId() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setId(data.session?.user.id ?? null));
  }, []);
  return id;
}

// Realtime returns the existing channel for a reused name, and adding callbacks to an already
// subscribed channel throws. Every hook instance (e.g. lobby + area screen) needs its own name.
let channelSeq = 0;

/** Fetches rows and refetches on every Realtime change (RLS applies to both). */
function useLiveQuery<T>(table: string, filterCol: string, value: string, single: boolean, orderCol?: string) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      let q = supabase.from(table).select('*').eq(filterCol, value);
      if (orderCol) q = q.order(orderCol);
      const { data: rows } = single ? await q.maybeSingle() : await q;
      if (alive) setData(rows as T);
    };
    load();
    const channel = supabase
      .channel(`${table}:${value}:${++channelSeq}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `${filterCol}=eq.${value}` }, load)
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [table, filterCol, value, single, orderCol]);
  return data;
}

export const useGame = (id: string) => useLiveQuery<Game>('games', 'id', id, true);
export const usePlayers = (gameId: string) => useLiveQuery<Player[]>('players', 'game_id', gameId, false) ?? [];
export const useLivePositions = (gameId: string) =>
  useLiveQuery<LivePosition[]>('live_positions', 'game_id', gameId, false) ?? [];
export const useReveals = (gameId: string) =>
  useLiveQuery<Reveal[]>('reveals', 'game_id', gameId, false, 'revealed_at') ?? [];
export const useSnapshots = (gameId: string) =>
  useLiveQuery<DetectiveSnapshot[]>('detective_snapshots', 'game_id', gameId, false, 'taken_at') ?? [];
export const usePoints = (gameId: string) => useLiveQuery<PointRow[]>('points', 'game_id', gameId, false) ?? [];
// RLS: only my own items.
export const useItems = (gameId: string) => useLiveQuery<Item[]>('items', 'game_id', gameId, false, 'picked_at') ?? [];
