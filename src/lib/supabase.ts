import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { SUPABASE_KEY, SUPABASE_URL } from './env';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// Recommended for React Native: only auto-refresh while the app is in the foreground.
// The background task calls getSession(), which refreshes an expired token on demand.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

export async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: signIn, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return signIn.session!;
}

export type Game = {
  id: string;
  code: string;
  mode: string;
  status: 'lobby' | 'running' | 'finished';
  host_user_id: string;
  center_lat: number | null;
  center_lng: number | null;
  radius_m: number | null;
  config: Record<string, any>;
  started_at: string | null;
  ends_at: string | null;
  finished_at: string | null;
  winner: 'mrx' | 'detectives' | null;
  caught_by: string | null;
};

export type Player = {
  id: string;
  game_id: string;
  user_id: string;
  name: string;
  role: 'mrx' | 'detective' | null;
  is_host: boolean;
};

export type LivePosition = {
  player_id: string;
  game_id: string;
  role: string | null;
  lat: number;
  lng: number;
  heading: number | null;
  updated_at: string;
};

export type Reveal = { id: number; lat: number; lng: number; heading: number | null; kind: string; revealed_at: string };
export type DetectiveSnapshot = { id: number; player_id: string; lat: number; lng: number; taken_at: string };
export type PointRow = { id: string; name: string | null; kind: string | null; lat: number; lng: number; active_after: string | null };
export type ItemKind = 'radar' | 'tracker' | 'compass' | 'decoy' | 'fog' | 'hide' | 'jam';
export type Item = { id: string; kind: ItemKind; used_at: string | null };
export type PointPickup = { point_id: string; picked_at: string };
