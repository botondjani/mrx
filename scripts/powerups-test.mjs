// Phase 3 server test: power-ups (pickup rules, radar, tracker, decoy, fog), GPS filtering,
// stats, replay and replay saving.
//   node --env-file=.env scripts/powerups-test.mjs
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;
const C = { lat: 47.4979, lng: 19.0402 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = ({ data, error }) => {
  if (error) throw error;
  return data;
};
const fails = async (p, code) => {
  const { error } = await p;
  assert.ok(error?.message.includes(code), `expected ${code}, got ${error?.message}`);
};
const east = (m) => ({ lat: C.lat, lng: C.lng + m / (111320 * Math.cos((C.lat * Math.PI) / 180)) });

async function bot(name) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return { sb, name, userId: data.user.id, events: [] };
}
// Walk in steps the GPS jump filter accepts (<= 150 m every 4 s).
async function walkTo(b, target) {
  for (;;) {
    const d = Math.hypot((target.lat - b.pos.lat) * 111320, (target.lng - b.pos.lng) * 111320 * Math.cos((C.lat * Math.PI) / 180));
    const f = Math.min(1, 140 / Math.max(d, 1));
    await sleep(4000);
    await report(b, { lat: b.pos.lat + (target.lat - b.pos.lat) * f, lng: b.pos.lng + (target.lng - b.pos.lng) * f });
    if (f === 1) return;
  }
}
async function report(b, pos, accuracy = 5) {
  if (accuracy <= 50) b.pos = { lat: pos.lat, lng: pos.lng };
  const res = ok(await b.sb.functions.invoke("report_position", {
    body: { game_id: game.id, locations: [{ ...pos, accuracy, speed: 1, heading: 90, timestamp: Date.now() }] },
  }));
  b.events.push(...res.events.map((e) => e.kind));
  return res;
}

const [mrx, d1, d2, d3] = [await bot("X"), await bot("D1"), await bot("D2"), await bot("D3")];
const game = ok(await mrx.sb.rpc("create_game", { p_name: "X" }));
ok(await mrx.sb.rpc("set_area", { p_game: game.id, p_lat: C.lat, p_lng: C.lng, p_radius_m: 2000 }));
ok(await mrx.sb.rpc("set_options", { p_game: game.id, p_options: { head_start_s: 0, duration_min: 30, reveal_interval_s: 20, reveal_interval_endgame_s: 20 } }));
for (const b of [d1, d2, d3]) ok(await b.sb.rpc("join_game", { p_code: game.code, p_name: b.name }));

// 12 synthetic OSM nodes on a line through the center, 160 m apart (Overpass is not reachable from CI/cloud).
const elements = Array.from({ length: 12 }, (_, i) => ({
  type: "node", id: i + 1, ...(({ lat, lng }) => ({ lat, lon: lng }))(east(160 * i - 880)), tags: { name: `P${i + 1}`, highway: "bus_stop" },
}));
const gen = ok(await mrx.sb.functions.invoke("generate_points", { body: { game_id: game.id, elements } }));
assert.equal(gen.count, 12);
const points = ok(await mrx.sb.from("points").select("id, name, lat, lng").eq("game_id", game.id)).sort((a, b) => a.lng - b.lng);

const players = ok(await mrx.sb.from("players").select("id, user_id").eq("game_id", game.id));
const pid = (b) => players.find((p) => p.user_id === b.userId).id;
ok(await mrx.sb.rpc("assign_roles", { p_game: game.id, p_mrx_player: pid(mrx) }));
ok(await mrx.sb.rpc("start_game", { p_game: game.id }));

const mrxPos = east(1000);
for (const b of [mrx, d1, d2, d3]) await report(b, b === mrx ? mrxPos : C);


// GPS filtering
assert.equal((await report(d2, east(5), 200)).gps_filtered, true, "inaccurate fix dropped");
assert.equal((await report(d2, east(30000))).gps_filtered, true, "30 km jump dropped");
d2.pos = east(5);
assert.equal((await report(d2, east(10))).gps_filtered, false, "normal fix accepted");

// Pickup rules
// d1 uses points 5..2, Mr. X 11..7, d2 0..1; point 6 stays unused.
await fails(d1.sb.rpc("pickup_point", { p_point: points[5].id }), "too_far");
await walkTo(d1, points[5]);
const k1 = ok(await d1.sb.rpc("pickup_point", { p_point: points[5].id }));
assert.ok(["radar", "tracker"].includes(k1), "detective gets a detective item");
await fails(d1.sb.rpc("pickup_point", { p_point: points[5].id }), "point_cooldown");

const reveals = async () => ok(await d1.sb.from("reveals").select("lat, lng, kind").eq("game_id", game.id).order("revealed_at"));
const useAll = async (b) => {
  for (const it of ok(await b.sb.from("items").select("id, kind").eq("game_id", game.id).is("used_at", null))) {
    ok(await b.sb.rpc("use_item", { p_item: it.id }));
  }
};

// Detective items: walk point to point until both radar and tracker have been used.
const used = new Set();
for (let i = 0; used.size < 2 && i < 4; i++) {
  if (i > 0) {
    await walkTo(d1, points[5 - i]);
    ok(await d1.sb.rpc("pickup_point", { p_point: points[5 - i].id }));
  }
  const [it] = ok(await d1.sb.from("items").select("id, kind").eq("game_id", game.id).is("used_at", null));
  const before = (await reveals()).length;
  ok(await d1.sb.rpc("use_item", { p_item: it.id }));
  if (it.kind === "radar") {
    const r = await reveals();
    assert.equal(r.length, before + 1, "radar reveals immediately");
    assert.equal(r.at(-1).kind, "radar");
    await report(d1, d1.pos);
    assert.ok(d1.events.includes("reveal"), "detective notified of radar reveal");
  } else {
    await report(mrx, mrx.pos);
    assert.ok((await reveals()).filter((x) => x.kind === "tracker").length >= 2, "tracker: live reveals on Mr. X reports");
    await report(d1, d1.pos);
    assert.ok(d1.events.includes("tracker_started"));
  }
  used.add(it.kind);
}
assert.equal(used.size, 2, "both detective items exercised");

// Mr. X items: pick up points 11, 10, ... until decoy and fog have both been used (item kinds are
// random, 5 tries). Their effect is checked on the next scheduled reveal (every 20 s here).
const mrxUsed = new Set();
// Only scheduled/radar reveals count (a still-running tracker adds live 'tracker' reveals).
const scheduled = async () => (await reveals()).filter((r) => r.kind === "scheduled" || r.kind === "radar");
const waitForReveal = async () => {
  const before = (await scheduled()).length;
  for (let n = 0; n < 15; n++) {
    await sleep(4000);
    await report(d3, d3.pos);
    await report(mrx, mrx.pos);
    if (d3.events.includes("reveal_fogged")) return { fogged: true, added: (await scheduled()).length - before };
    const r = await scheduled();
    if (r.length > before) return { fogged: false, last: r.at(-1) };
  }
  throw new Error("no reveal within 60 s");
};
for (let i = 11; mrxUsed.size < 2 && i > 6; i--) {
  await walkTo(mrx, points[i]);
  const kind = ok(await mrx.sb.rpc("pickup_point", { p_point: points[i].id }));
  assert.ok(["decoy", "fog"].includes(kind), "Mr. X gets a Mr. X item");
  const [it] = ok(await mrx.sb.from("items").select("id").eq("game_id", game.id).is("used_at", null));
  d3.events.length = 0;
  if (kind === "decoy") {
    await fails(mrx.sb.rpc("use_item", { p_item: it.id, p_lat: C.lat, p_lng: C.lng + 0.02 }), "decoy_too_far");
    const fake = { lat: points[i].lat + 0.001, lng: points[i].lng };
    ok(await mrx.sb.rpc("use_item", { p_item: it.id, p_lat: fake.lat, p_lng: fake.lng }));
    const res = await waitForReveal();
    assert.ok(!res.fogged && Math.abs(res.last.lat - fake.lat) < 1e-9 && res.last.kind === "scheduled", "decoy reveal shows the fake point as a normal reveal");
  } else {
    ok(await mrx.sb.rpc("use_item", { p_item: it.id }));
    const res = await waitForReveal();
    assert.ok(res.fogged && res.added === 0, "fog skipped the reveal");
  }
  mrxUsed.add(kind);
}
assert.equal(mrxUsed.size, 2, "both Mr. X items exercised");

// Inventory limit
await useAll(d2);
for (const i of [1, 0]) {
  await walkTo(d2, points[i]);
  ok(await d2.sb.rpc("pickup_point", { p_point: points[i].id }));
}
await fails(d2.sb.rpc("pickup_point", { p_point: points[6].id }), "inventory_full");

// End, stats, replay
ok(await mrx.sb.rpc("confirm_catch", { p_game: game.id, p_detective: pid(d1) }));
const stats = ok(await d1.sb.rpc("game_stats", { p_game: game.id }));
assert.equal(stats.players.length, 4);
assert.ok(stats.players.find((p) => p.role === "detective" && p.name === "D1").distance_m > 50, "distance counted");
assert.ok(stats.players.find((p) => p.name === "D1").items >= 2, "items counted");
const replay = ok(await d2.sb.rpc("game_replay", { p_game: game.id }));
assert.ok(replay.tracks.length > 10 && replay.reveals.length > 2);
await fails(d1.sb.rpc("save_replay", { p_game: game.id }), "not_host");
ok(await mrx.sb.rpc("save_replay", { p_game: game.id }));

console.log(`OK – game ${game.code}: items used ${[...used, ...mrxUsed].join(", ")}; stats`, JSON.stringify(stats.players));
process.exit(0);
