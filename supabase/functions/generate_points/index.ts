// generate_points: host-only. Places points_max random "hideouts" inside the game area, at least
// point_min_spacing_m apart, replacing the game's points. The host can then drag them (move_point).
// (OSM/Overpass places were dropped: public Overpass servers were unreachable from cloud and phones.)
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type P = { lat: number; lng: number };

function distM(a: P, b: P) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const { data: claims } = await admin.auth.getClaims(token);
  const userId = claims?.claims?.sub;
  if (!userId) return json({ error: "unauthorized" }, 401);

  const { game_id } = await req.json().catch(() => ({}));
  const { data: game } = await admin.from("games").select("*").eq("id", game_id).maybeSingle();
  if (!game || game.host_user_id !== userId) return json({ error: "not_host" }, 403);
  if (game.status !== "lobby") return json({ error: "game_already_started" }, 409);
  if (game.center_lat == null || !game.radius_m) return json({ error: "area_not_set" }, 409);

  // Power-ups switched off → no points at all.
  const max = game.config.powerups_enabled === false ? 0 : (game.config.points_max ?? 12);
  const spacing = game.config.point_min_spacing_m ?? 150;
  const center = { lat: game.center_lat, lng: game.center_lng };

  // Uniform random candidates in the inner 90 % of the circle; greedy pick with minimum spacing.
  const picked: P[] = [];
  for (let i = 0; i < 2000 && picked.length < max; i++) {
    const r = game.radius_m * 0.9 * Math.sqrt(Math.random()), a = Math.random() * 2 * Math.PI;
    const c = {
      lat: center.lat + (r * Math.cos(a)) / 111320,
      lng: center.lng + (r * Math.sin(a)) / (111320 * Math.cos((center.lat * Math.PI) / 180)),
    };
    if (picked.every((p) => distM(p, c) >= spacing)) picked.push(c);
  }

  await admin.from("points").delete().eq("game_id", game_id);
  if (picked.length) {
    const rows = picked.map((p, i) => ({ ...p, game_id, name: `Rejtekhely ${i + 1}`, kind: "hideout" }));
    const { error } = await admin.from("points").insert(rows);
    if (error) return json({ error: error.message }, 500);
  }
  return json({ count: picked.length });
});
