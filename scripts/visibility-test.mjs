// Phase 2 privacy test: plays a short game with bots and records everything a detective
// client and Mr. X's client receive (all HTTP responses + Realtime payloads, i.e. everything
// the app subscribes to). Asserts:
//   - a detective never receives a Mr. X coordinate that is not a reveal,
//   - Mr. X never receives a detective coordinate that is not a periodic snapshot.
// Mr. X leaves the area for a while to also exercise the out-of-bounds penalty reveals.
//   node --env-file=.env scripts/visibility-test.mjs
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;
const C = { lat: 47.4979, lng: 19.0402 };
const RADIUS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = ({ data, error }) => {
  if (error) throw error;
  return data;
};
const key = (lat, lng) => `${lat.toFixed(7)},${lng.toFixed(7)}`;

// Collects every {lat, lng} pair found anywhere in a JSON value.
function collectCoords(value, out) {
  if (Array.isArray(value)) value.forEach((v) => collectCoords(v, out));
  else if (value && typeof value === "object") {
    if (typeof value.lat === "number" && typeof value.lng === "number") out.add(key(value.lat, value.lng));
    Object.values(value).forEach((v) => collectCoords(v, out));
  }
}

async function bot(name) {
  const received = new Set();
  const capturingFetch = async (...args) => {
    const res = await fetch(...args);
    const text = await res.clone().text();
    try { collectCoords(JSON.parse(text), received); } catch { /* not JSON */ }
    return res;
  };
  const sb = createClient(URL, KEY, { auth: { persistSession: false }, global: { fetch: capturingFetch } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return { sb, name, userId: data.user.id, received, sent: [] };
}

// Same subscriptions as the game screen.
function subscribeAll(b, gameId) {
  for (const table of ["games", "players", "live_positions", "reveals", "detective_snapshots", "points"]) {
    const filter = table === "games" ? `id=eq.${gameId}` : `game_id=eq.${gameId}`;
    b.sb.channel(`${b.name}:${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table, filter }, (e) => collectCoords(e, b.received))
      .subscribe();
  }
}

const bots = [await bot("X"), await bot("D1"), await bot("D2"), await bot("D3")];
const [mrx, d1] = bots;
const game = ok(await mrx.sb.rpc("create_game", { p_name: mrx.name }));
ok(await mrx.sb.rpc("set_area", { p_game: game.id, p_lat: C.lat, p_lng: C.lng, p_radius_m: RADIUS }));
ok(await mrx.sb.rpc("set_options", {
  p_game: game.id,
  p_options: { duration_min: 2, head_start_s: 20, reveal_interval_s: 20, reveal_interval_endgame_s: 20, mrx_sees_detectives_interval_s: 20 },
}));
for (const b of bots.slice(1)) ok(await b.sb.rpc("join_game", { p_code: game.code, p_name: b.name }));
const players = ok(await mrx.sb.from("players").select("id, user_id").eq("game_id", game.id));
ok(await mrx.sb.rpc("assign_roles", { p_game: game.id, p_mrx_player: players.find((p) => p.user_id === mrx.userId).id }));
subscribeAll(mrx, game.id);
subscribeAll(d1, game.id);
ok(await mrx.sb.rpc("start_game", { p_game: game.id }));
console.log(`game ${game.code} started`);

// Scripted paths: Mr. X walks east, leaves the area at ~40 s for ~65 s, comes back.
// Detectives jitter around the center. Small random noise keeps every coordinate unique.
const t0 = Date.now();
const noise = () => (Math.random() - 0.5) * 1e-5;
function positionOf(b) {
  const t = (Date.now() - t0) / 1000;
  if (b === mrx) {
    const outside = t > 40 && t < 105;
    const meters = outside ? RADIUS + 80 : Math.min(300, t * 5);
    return { lat: C.lat + noise(), lng: C.lng + meters / (111320 * Math.cos((C.lat * Math.PI) / 180)) + noise() };
  }
  return { lat: C.lat + (Math.random() - 0.5) * 0.002, lng: C.lng + (Math.random() - 0.5) * 0.002 };
}

const events = {};
let finished = false;
async function loop(b) {
  while (!finished) {
    const p = positionOf(b);
    b.sent.push(key(p.lat, p.lng));
    const res = ok(await b.sb.functions.invoke("report_position", {
      body: { game_id: game.id, locations: [{ ...p, accuracy: 5, speed: 1.4, heading: 90, timestamp: Date.now() }] },
    }));
    for (const e of res.events) (events[`${b.name}:${e.kind}`] ??= 0, events[`${b.name}:${e.kind}`]++);
    if (res.game_status === "finished") finished = true;
    await sleep(res.next_interval_ms);
  }
}
await Promise.all(bots.map(loop));
await sleep(2000);

// Allowed sets, read by each client itself (RLS applies).
const reveals = ok(await d1.sb.from("reveals").select("lat, lng, kind").eq("game_id", game.id));
const snapshots = ok(await mrx.sb.from("detective_snapshots").select("lat, lng").eq("game_id", game.id));
const revealed = new Set(reveals.map((r) => key(r.lat, r.lng)));
const snapshotted = new Set(snapshots.map((r) => key(r.lat, r.lng)));

const mrxSent = new Set(mrx.sent);
const detSent = new Set(bots.slice(1).flatMap((b) => b.sent));
const leakedToDetective = [...d1.received].filter((c) => mrxSent.has(c) && !revealed.has(c));
const mrxSeenByDetective = [...d1.received].filter((c) => mrxSent.has(c));
const leakedToMrx = [...mrx.received].filter((c) => detSent.has(c) && !snapshotted.has(c));

console.log("events:", events);
console.log(`Mr. X sent ${mrxSent.size} positions; reveals: ${reveals.length} (${reveals.filter((r) => r.kind === "penalty").length} penalty)`);
console.log(`detective received ${d1.received.size} coordinates, ${mrxSeenByDetective.length} of them Mr. X (all reveals: ${leakedToDetective.length === 0})`);
console.log(`Mr. X received ${mrx.received.size} coordinates, snapshots: ${snapshots.length}`);

assert.ok(reveals.some((r) => r.kind === "scheduled"), "scheduled reveals happened");
assert.ok(reveals.some((r) => r.kind === "penalty"), "out-of-bounds penalty reveals happened");
assert.ok(mrxSeenByDetective.length > 0, "detective did receive reveals");
assert.equal(leakedToDetective.length, 0, `detective received non-revealed Mr. X positions: ${leakedToDetective}`);
assert.ok(snapshots.length > 0, "Mr. X got detective snapshots");
assert.equal(leakedToMrx.length, 0, `Mr. X received live detective positions: ${leakedToMrx}`);
assert.ok(events["X:out_of_bounds"] && events["X:back_in_bounds"], "Mr. X got boundary warnings");
assert.ok(events["D1:mrx_exposed"], "detectives were told about the penalty");
assert.ok(events["D1:game_over"] && events["X:game_over"], "everyone got game_over");
console.log("OK – no position leaked");
process.exit(0);
