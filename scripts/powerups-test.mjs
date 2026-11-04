// Server test: power-ups, deterministic. Each game enables exactly one item kind per role (host
// option), so every pickup yields a known item:
//   A: radar + fog     – pickup rules, per-player cooldown, inventory limit, GPS filtering,
//                        radar still works under fog, fog skips the next scheduled reveal
//   B: tracker + decoy – tracker live reveals, decoy shows the fake point on the next reveal
//   C: compass + hide  – compass direction/band without coordinates, hide blocks the compass
//   D: compass + jam   – jam: detectives cannot see each other
// Game A also checks stats, replay and replay saving.
//   node --env-file=.env scripts/powerups-test.mjs
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;
const C = { lat: 47.4979, lng: 19.0402 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = ({ data, error }) => {
  if (error) throw new Error(error.message); // Error → stack trace with line number
  return data;
};
const fails = async (p, code) => {
  const { error } = await p;
  assert.ok(error?.message.includes(code), `expected ${code}, got ${error?.message}`);
};
const east = (m) => ({ lat: C.lat, lng: C.lng + m / (111320 * Math.cos((C.lat * Math.PI) / 180)) });
const line = (i) => east(160 * i - 880); // point i of 12 on a line through the center, 160 m apart

async function bot(name) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return { sb, name, userId: data.user.id, events: [], pos: C };
}

/** Lobby → running game with the given item pools; points dragged onto the line (move_point). */
async function setup(detItems, mrxItems, extra = {}) {
  const [x, d1, d2, d3] = [await bot("X"), await bot("D1"), await bot("D2"), await bot("D3")];
  const game = ok(await x.sb.rpc("create_game", { p_name: "X" }));
  ok(await x.sb.rpc("set_area", { p_game: game.id, p_lat: C.lat, p_lng: C.lng, p_radius_m: 2000 }));
  ok(await x.sb.rpc("set_options", { p_game: game.id, p_options: {
    head_start_s: 0, duration_min: 30, reveal_interval_s: 20, reveal_interval_endgame_s: 20,
    items: { detective: detItems, mrx: mrxItems }, ...extra } }));
  assert.equal(ok(await x.sb.functions.invoke("generate_points", { body: { game_id: game.id } })).count, 12);
  const pts = ok(await x.sb.from("points").select("id").eq("game_id", game.id));
  for (const [i, pt] of pts.entries()) ok(await x.sb.rpc("move_point", { p_point: pt.id, p_lat: line(i).lat, p_lng: line(i).lng }));
  await fails(x.sb.rpc("move_point", { p_point: pts[0].id, p_lat: C.lat + 0.1, p_lng: C.lng }), "point_outside_area");
  const points = ok(await x.sb.from("points").select("id, lat, lng").eq("game_id", game.id)).sort((a, b) => a.lng - b.lng);
  for (const b of [d1, d2, d3]) ok(await b.sb.rpc("join_game", { p_code: game.code, p_name: b.name }));
  const players = ok(await x.sb.from("players").select("id, user_id").eq("game_id", game.id));
  const pid = (b) => players.find((p) => p.user_id === b.userId).id;
  ok(await x.sb.rpc("assign_roles", { p_game: game.id, p_mrx_player: pid(x) }));
  ok(await x.sb.rpc("start_game", { p_game: game.id }));
  const g = { game, x, d1, d2, d3, points, pid };
  g.report = async (b, pos = b.pos, accuracy = 5) => {
    const res = ok(await b.sb.functions.invoke("report_position", {
      body: { game_id: game.id, locations: [{ ...pos, accuracy, speed: 1, heading: 90, timestamp: Date.now() }] } }));
    if (!res.gps_filtered) b.pos = { lat: pos.lat, lng: pos.lng };
    b.events.push(...res.events.map((e) => e.kind));
    return res;
  };
  // Walk in steps the GPS jump filter accepts (≤ 140 m every 4 s).
  g.walk = async (b, t) => {
    for (;;) {
      const d = Math.hypot((t.lat - b.pos.lat) * 111320, (t.lng - b.pos.lng) * 111320 * Math.cos((C.lat * Math.PI) / 180));
      const f = Math.min(1, 140 / Math.max(d, 1));
      await sleep(4000);
      await g.report(b, { lat: b.pos.lat + (t.lat - b.pos.lat) * f, lng: b.pos.lng + (t.lng - b.pos.lng) * f });
      if (f === 1) return;
    }
  };
  g.pickup = async (b, i) => {
    await g.walk(b, points[i]);
    return ok(await b.sb.rpc("pickup_point", { p_point: points[i].id }));
  };
  g.use = async (b, args = {}) => {
    const [it] = ok(await b.sb.from("items").select("id").eq("game_id", game.id).is("used_at", null).order("picked_at"));
    return ok(await b.sb.rpc("activate_item", { p_item: it.id, ...args }));
  };
  g.reveals = async () => ok(await d1.sb.from("reveals").select("lat, lng, kind").eq("game_id", game.id).order("revealed_at"));
  g.scheduled = async () => (await g.reveals()).filter((r) => r.kind === "scheduled" || r.kind === "radar");
  // Wait for the next scheduled reveal (or a fogged one); detectives + Mr. X keep reporting.
  g.nextReveal = async () => {
    const before = (await g.scheduled()).length;
    d1.events.length = 0;
    for (let n = 0; n < 15; n++) {
      await sleep(4000);
      await g.report(d1);
      await g.report(x);
      if (d1.events.includes("reveal_fogged")) return { fogged: true, added: (await g.scheduled()).length - before };
      const r = await g.scheduled();
      if (r.length > before) return { fogged: false, last: r.at(-1) };
    }
    throw new Error("no reveal within 60 s");
  };
  for (const b of [x, d1, d2, d3]) await g.report(b);
  return g;
}

// ---------------- A: radar + fog, pickup rules, GPS filter, stats ----------------
{
  const g = await setup(["radar"], ["fog"]);
  const { x, d1, d2, points } = g;
  await fails(x.sb.rpc("set_options", { p_game: g.game.id, p_options: { points_max: 6 } }), "game_already_started");

  // GPS filtering
  assert.equal((await g.report(d2, east(5), 200)).gps_filtered, true, "inaccurate fix dropped");
  assert.equal((await g.report(d2, east(30000))).gps_filtered, true, "30 km jump dropped");
  assert.equal((await g.report(d2, east(10))).gps_filtered, false, "normal fix accepted");

  // Pickup rules
  await fails(d1.sb.rpc("pickup_point", { p_point: points[5].id }), "too_far");
  assert.equal(await g.pickup(d1, 5), "radar", "host item pool respected");
  await fails(d1.sb.rpc("pickup_point", { p_point: points[5].id }), "point_cooldown");
  assert.equal(ok(await d1.sb.from("point_pickups").select("id").eq("game_id", g.game.id)).length, 1, "only own pickups visible");
  assert.equal(await g.pickup(d2, 6), "radar", "same point area, other player: no shared cooldown");
  await g.pickup(d2, 7);
  await fails(d2.sb.rpc("pickup_point", { p_point: points[8].id }), "inventory_full");

  // Mr. X uses fog; a detective radar still reveals; the next scheduled reveal is skipped.
  assert.equal(await g.pickup(x, 4), "fog");
  ok(await x.sb.rpc("activate_item", { p_item: ok(await x.sb.from("items").select("id").eq("game_id", g.game.id).single()).id }));
  const before = (await g.reveals()).length;
  assert.deepEqual(await g.use(d1), { ok: true });
  const after = await g.reveals();
  assert.equal(after.length, before + 1, "radar works under fog");
  assert.equal(after.at(-1).kind, "radar");
  const fogged = await g.nextReveal();
  assert.ok(fogged.fogged && fogged.added === 0, "fog skipped the scheduled reveal");

  // End, stats, replay
  ok(await x.sb.rpc("confirm_catch", { p_game: g.game.id, p_detective: g.pid(d1) }));
  const stats = ok(await d1.sb.rpc("game_stats", { p_game: g.game.id }));
  assert.ok(stats.players.find((p) => p.name === "D1").distance_m > 50 && stats.players.find((p) => p.name === "D2").items === 2);
  const replay = ok(await d2.sb.rpc("game_replay", { p_game: g.game.id }));
  assert.ok(replay.tracks.length > 10 && replay.reveals.length >= 1);
  await fails(d1.sb.rpc("save_replay", { p_game: g.game.id }), "not_host");
  ok(await x.sb.rpc("save_replay", { p_game: g.game.id }));
  console.log(`A ok (${g.game.code}): pickup rules, GPS filter, radar under fog, fog, stats, replay`);
}

// ---------------- B: tracker + decoy ----------------
{
  const g = await setup(["tracker"], ["decoy"]);
  const { x, d1 } = g;
  assert.equal(await g.pickup(x, 6), "decoy");
  await fails(x.sb.rpc("activate_item", { p_item: ok(await x.sb.from("items").select("id").eq("game_id", g.game.id).single()).id,
    p_lat: C.lat, p_lng: C.lng + 0.02 }), "decoy_too_far");
  const fake = { lat: g.points[6].lat + 0.001, lng: g.points[6].lng };
  await g.use(x, { p_lat: fake.lat, p_lng: fake.lng });
  const r = await g.nextReveal();
  assert.ok(!r.fogged && Math.abs(r.last.lat - fake.lat) < 1e-9 && r.last.kind === "scheduled", "decoy shows the fake point as a normal reveal");

  assert.equal(await g.pickup(d1, 5), "tracker");
  await g.use(d1);
  await g.report(x);
  await g.report(x);
  assert.ok((await g.reveals()).filter((v) => v.kind === "tracker").length >= 2, "tracker: live reveals on Mr. X reports");
  await g.report(d1);
  assert.ok(d1.events.includes("tracker_started"));
  console.log(`B ok (${g.game.code}): decoy, tracker`);
}

// ---------------- C: compass + hide ----------------
{
  const g = await setup(["compass"], ["hide"]);
  const { x, d1 } = g;
  // Mr. X at the center; D1 at point 6 (80 m east) → Mr. X is west, within 150 m.
  assert.equal(await g.pickup(d1, 6), "compass");
  const compass = await g.use(d1);
  assert.deepEqual(compass, { direction: "Ny", distance: "150 m-en belül" }, "compass: direction + band, no coordinates");
  assert.equal(await g.pickup(x, 5), "hide");
  await g.use(x);
  assert.equal(await g.pickup(d1, 7), "compass");
  assert.deepEqual(await g.use(d1), { blocked: true }, "hide blocks the compass");
  console.log(`C ok (${g.game.code}): compass, hide`);
}

// ---------------- D: jam ----------------
{
  const g = await setup(["compass"], ["jam"]);
  const { x, d2 } = g;
  assert.equal((ok(await d2.sb.from("live_positions").select("player_id").eq("game_id", g.game.id))).length, 3, "detectives see each other");
  assert.equal(await g.pickup(x, 5), "jam");
  await g.use(x);
  assert.equal((ok(await d2.sb.from("live_positions").select("player_id").eq("game_id", g.game.id))).length, 1, "jammed: only itself");
  await g.report(d2);
  assert.ok(d2.events.includes("jammed"));
  console.log(`D ok (${g.game.code}): jam`);
}

// ---------------- E: power-ups switched off ----------------
{
  const host = await bot("H");
  const game = ok(await host.sb.rpc("create_game", { p_name: "H" }));
  ok(await host.sb.rpc("set_area", { p_game: game.id, p_lat: C.lat, p_lng: C.lng, p_radius_m: 1000 }));
  await fails(host.sb.rpc("set_options", { p_game: game.id, p_options: { items: { mrx: ["nuke"] } } }), "invalid_option");
  ok(await host.sb.rpc("set_options", { p_game: game.id, p_options: { powerups_enabled: false } }));
  assert.equal(ok(await host.sb.functions.invoke("generate_points", { body: { game_id: game.id } })).count, 0);
  console.log("E ok: unknown item rejected, power-ups off → no points");
}

console.log("OK – all power-up checks passed");
process.exit(0);
