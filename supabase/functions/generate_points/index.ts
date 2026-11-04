// generate_points: host-only. Picks power-up points inside the game area from OSM data,
// at least point_min_spacing_m apart, and replaces the game's points.
// Public Overpass servers reject cloud IPs (406/timeouts from Supabase Edge), so the host's
// phone runs the Overpass query: on a cache miss this returns { error: "need_overpass", query }
// and the client retries with { elements }. Results are cached per area for CACHE_DAYS.
// If no Overpass server answers the phone either, the client sends { random: true } and the
// points are random "hideouts" inside the area (same spacing rules).
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const CACHE_DAYS = 7;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Candidate = { osm_id: string | null; name: string | null; kind: string; lat: number; lng: number };

function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function kindOf(t: Record<string, string>): string {
  if (t.place === "square") return "square";
  if (t.leisure === "park") return "park";
  if (t.highway === "bus_stop" || t.railway === "tram_stop" || t.public_transport) return "stop";
  return "statue";
}

function overpassQuery(lat: number, lng: number, radius: number) {
  const a = `(around:${radius},${lat},${lng})`;
  return `[out:json][timeout:25];(
    nwr["place"="square"]${a};
    nwr["leisure"="park"]${a};
    node["historic"~"^(memorial|monument|statue)$"]${a};
    node["tourism"~"^(artwork|attraction)$"]${a};
    node["highway"="bus_stop"]${a};
    node["railway"="tram_stop"]${a};
  );out center tags;`;
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  const { data: claims } = await admin.auth.getClaims(token);
  const userId = claims?.claims?.sub;
  if (!userId) return json({ error: "unauthorized" }, 401);

  const { game_id, elements: supplied, random } = await req.json().catch(() => ({}));
  const { data: game } = await admin.from("games").select("*").eq("id", game_id).maybeSingle();
  if (!game || game.host_user_id !== userId) return json({ error: "not_host" }, 403);
  if (game.status !== "lobby") return json({ error: "game_already_started" }, 409);
  if (game.center_lat == null || !game.radius_m) return json({ error: "area_not_set" }, 409);

  const cfg = game.config;
  const center = { lat: game.center_lat, lng: game.center_lng };
  const key = `${center.lat.toFixed(4)},${center.lng.toFixed(4)},${game.radius_m}`;
  let elements = supplied;
  if (random) {
    // Uniform random points in the inner 90 % of the circle.
    elements = Array.from({ length: 400 }, (_, i) => {
      const r = game.radius_m * 0.9 * Math.sqrt(Math.random()), a = Math.random() * 2 * Math.PI;
      return {
        type: "random", id: i, tags: {},
        lat: center.lat + (r * Math.cos(a)) / 111320,
        lon: center.lng + (r * Math.sin(a)) / (111320 * Math.cos((center.lat * Math.PI) / 180)),
      };
    });
  } else if (Array.isArray(elements)) {
    if (elements.length > 5000) return json({ error: "too_many_elements" }, 413);
    await admin.from("overpass_cache").upsert({ key, elements, fetched_at: new Date().toISOString() });
  } else {
    const { data: cached } = await admin.from("overpass_cache").select("elements, fetched_at").eq("key", key).maybeSingle();
    if (!cached || Date.now() - new Date(cached.fetched_at).getTime() > CACHE_DAYS * 86400e3) {
      return json({ error: "need_overpass", query: overpassQuery(center.lat, center.lng, game.radius_m) }, 409);
    }
    elements = cached.elements;
  }

  // deno-lint-ignore no-explicit-any
  const candidates: Candidate[] = elements.map((e: any) => ({
    osm_id: random ? null : `${e.type}/${e.id}`,
    name: e.tags?.name ?? null,
    kind: random ? "hideout" : kindOf(e.tags ?? {}),
    lat: e.lat ?? e.center?.lat,
    lng: e.lon ?? e.center?.lon,
  })).filter((c: Candidate) => Number.isFinite(c.lat) && distM(center, c) <= game.radius_m * 0.9);

  // Random order, named places first; greedy pick with minimum spacing.
  candidates.sort(() => Math.random() - 0.5);
  candidates.sort((a, b) => Number(!!b.name) - Number(!!a.name));
  const picked: Candidate[] = [];
  for (const c of candidates) {
    if (picked.length >= cfg.points_max) break;
    if (picked.every((p) => distM(p, c) >= cfg.point_min_spacing_m)) picked.push(c);
  }

  if (random) picked.forEach((p, i) => (p.name = `Rejtekhely ${i + 1}`));

  await admin.from("points").delete().eq("game_id", game_id);
  if (picked.length) {
    const { error } = await admin.from("points").insert(picked.map((p) => ({ ...p, game_id })));
    if (error) return json({ error: error.message }, 500);
  }
  return json({ count: picked.length, enough: picked.length >= cfg.points_min });
});
