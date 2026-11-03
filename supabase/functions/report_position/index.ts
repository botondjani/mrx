// report_position: called by the background location task (and the bot simulator).
// Authenticates the caller; all game logic runs in public.process_report() (one transaction).
// Response: { game_status, events: [{ kind, payload }], next_interval_ms } – events are
// already filtered per recipient, so a client only ever gets what its role may know.
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
  const locations = (body.locations ?? [])
    .filter((l) => Number.isFinite(l?.lat) && Number.isFinite(l?.lng) && Number.isFinite(l?.timestamp))
    .map(({ lat, lng, accuracy, speed, heading, timestamp }) => ({ lat, lng, accuracy, speed, heading, timestamp }));
  if (!body.game_id || locations.length === 0) return json({ error: "invalid_body" }, 400);

  const { data, error } = await admin.rpc("process_report", {
    p_user: userId,
    p_game: body.game_id,
    p_locations: locations,
  });
  if (error) {
    const status = /not_in_game|game_not_found/.test(error.message) ? 403 : 500;
    return json({ error: error.message }, status);
  }
  return json(data);
});
