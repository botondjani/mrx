// report_position: called by the background location task (and the bot simulator).
// Stores positions, updates the player's live position and returns role-filtered events.
import { createClient } from "npm:@supabase/supabase-js@2";

type Loc = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  timestamp: number; // ms since epoch (device time)
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const { data: claims, error: authError } = await admin.auth.getClaims(token);
  const userId = claims?.claims?.sub;
  if (authError || !userId) return json({ error: "unauthorized" }, 401);

  let body: { game_id?: string; locations?: Loc[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const locations = (body.locations ?? []).filter(
    (l) => Number.isFinite(l?.lat) && Number.isFinite(l?.lng) && Number.isFinite(l?.timestamp),
  );
  if (!body.game_id || locations.length === 0) return json({ error: "invalid_body" }, 400);

  const { data: player } = await admin
    .from("players")
    .select("id, role, games!inner(status, config)")
    .eq("game_id", body.game_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!player) return json({ error: "not_in_game" }, 403);

  // deno-lint-ignore no-explicit-any
  const game = (player as any).games as { status: string; config: Record<string, unknown> };
  const nextIntervalMs = Number(game.config.report_interval_s) * 1000;
  if (game.status !== "running") {
    return json({ game_status: game.status, events: [], next_interval_ms: nextIntervalMs });
  }

  const rows = locations.map((l) => ({
    game_id: body.game_id,
    player_id: player.id,
    lat: l.lat,
    lng: l.lng,
    accuracy_m: l.accuracy ?? null,
    speed_mps: l.speed ?? null,
    heading: l.heading ?? null,
    recorded_at: new Date(l.timestamp).toISOString(),
  }));
  const { error: insertError } = await admin.from("positions").insert(rows);
  if (insertError) return json({ error: insertError.message }, 500);

  const last = rows.reduce((a, b) => (a.recorded_at > b.recorded_at ? a : b));
  const { error: upsertError } = await admin.from("live_positions").upsert({
    player_id: player.id,
    game_id: body.game_id,
    role: player.role,
    lat: last.lat,
    lng: last.lng,
    accuracy_m: last.accuracy_m,
    heading: last.heading,
    speed_mps: last.speed_mps,
    updated_at: new Date().toISOString(),
  });
  if (upsertError) return json({ error: upsertError.message }, 500);

  // Phase 2 adds events: reveal, proximity, game_over, out_of_bounds, power-up.
  return json({ game_status: game.status, events: [], next_interval_ms: nextIntervalMs });
});
