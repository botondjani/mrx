// Sharing features test: a scripted ~2 min game (D2 gets within ~30 m but does not catch,
// D1 catches Mr. X), then checks the story (case name, closest call, titles), rematch (roles
// swap, players + points copied, idempotent, host-only) and the opt-in public replay.
//   node --env-file=.env scripts/story-test.mjs
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;
const C = { lat: 47.4979, lng: 19.0402 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
const fails = async (p, code) => {
  const { error } = await p;
  assert.ok(error?.message.includes(code), `expected ${code}, got ${error?.message}`);
};
const east = (m) => ({ lat: C.lat, lng: C.lng + m / (111320 * Math.cos((C.lat * Math.PI) / 180)) });
const lerp = (a, b, f) => a + (b - a) * Math.min(1, Math.max(0, f));

async function bot(name) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return { sb, name, userId: data.user.id };
}

const [x, d1, d2, d3] = [await bot("X"), await bot("D1"), await bot("D2"), await bot("D3")];
const game = ok(await x.sb.rpc("create_game", { p_name: "X" }));
ok(await x.sb.rpc("set_area", { p_game: game.id, p_lat: C.lat, p_lng: C.lng, p_radius_m: 1500 }));
ok(await x.sb.rpc("set_options", { p_game: game.id, p_options: { head_start_s: 0, duration_min: 5 } }));
ok(await x.sb.functions.invoke("generate_points", { body: { game_id: game.id } }));
for (const b of [d1, d2, d3]) ok(await b.sb.rpc("join_game", { p_code: game.code, p_name: b.name }));
const players = ok(await x.sb.from("players").select("id, user_id").eq("game_id", game.id));
const pid = (b) => players.find((p) => p.user_id === b.userId).id;
ok(await x.sb.rpc("assign_roles", { p_game: game.id, p_mrx_player: pid(x) }));
ok(await x.sb.rpc("start_game", { p_game: game.id }));
console.log(`game ${game.code} started`);

// Scripted meters east of the center, by elapsed seconds (≤ 140 m per 4 s report: passes the jump filter).
const script = {
  X: () => 600,
  D1: (t) => (t < 16 ? lerp(0, 520, t / 16) : t < 40 ? lerp(520, 300, (t - 24) / 16) : t < 100 ? 300 : lerp(300, 590, (t - 100) / 20)),
  D2: (t) => (t < 40 ? 0 : t < 64 ? lerp(0, 570, (t - 40) / 16) : lerp(570, 200, (t - 64) / 16)),
  D3: () => 0,
};
const t0 = Date.now();
for (;;) {
  const t = (Date.now() - t0) / 1000;
  for (const b of [x, d1, d2, d3]) {
    ok(await b.sb.functions.invoke("report_position", {
      body: { game_id: game.id, locations: [{ ...east(script[b.name](t)), accuracy: 5, timestamp: Date.now() }] },
    }));
  }
  if (t > 124) break;
  await sleep(4000);
}
ok(await x.sb.rpc("confirm_catch", { p_game: game.id, p_detective: pid(d1) }));

// Story
const outsider = await bot("Outsider");
await fails(outsider.sb.rpc("game_story", { p_game: game.id }), "game_not_found");
const story = ok(await d3.sb.rpc("game_story", { p_game: game.id }));
console.log(JSON.stringify(story, null, 1));
assert.match(story.case_name, /^A \S+ \S+ ügye$/);
assert.equal(story.winner, "detectives");
assert.equal(story.caught_by, "D1");
assert.equal(story.closest.name, "D2", "closest call (outside the last minute) was D2");
assert.ok(story.closest.meters >= 20 && story.closest.meters <= 45, `closest ~30 m, got ${story.closest.meters}`);
const title = (n) => story.players.find((p) => p.name === n).title;
assert.equal(title("X"), "Lebukott");
assert.equal(title("D1"), "Vérszag");
assert.equal(title("D2"), "Hajszálnyira");
assert.ok(story.catch_point && story.players.find((p) => p.name === "D1").distance_m > 500);

// Rematch
await fails(d1.sb.rpc("rematch", { p_game: game.id }), "not_host");
const newId = ok(await x.sb.rpc("rematch", { p_game: game.id }));
assert.equal(ok(await x.sb.rpc("rematch", { p_game: game.id })), newId, "rematch is idempotent");
const g2 = ok(await d2.sb.from("games").select("*").eq("id", newId).single()); // d2 is a member of the new game
assert.equal(g2.status, "lobby");
assert.equal(g2.center_lat, C.lat);
const p2 = ok(await d2.sb.from("players").select("name, role").eq("game_id", newId));
assert.equal(p2.length, 4);
assert.equal(p2.find((p) => p.role === "mrx").name, "D1", "the catcher becomes Mr. X");
assert.equal(ok(await d2.sb.from("points").select("id").eq("game_id", newId)).length,
  ok(await d2.sb.from("points").select("id").eq("game_id", game.id)).length, "points copied");
const oldGame = ok(await d3.sb.from("games").select("rematch_game_id").eq("id", game.id).single());
assert.equal(oldGame.rematch_game_id, newId, "clients can follow the rematch");

// Public replay (anon client, no sign-in)
const anon = createClient(URL, KEY, { auth: { persistSession: false } });
await fails(anon.rpc("public_replay", { p_code: game.code }), "replay_not_found");
await fails(d1.sb.rpc("set_replay_public", { p_game: game.id, p_public: true }), "not_host");
ok(await x.sb.rpc("set_replay_public", { p_game: game.id, p_public: true }));
const pub = ok(await anon.rpc("public_replay", { p_code: game.code.toLowerCase() }));
assert.equal(pub.case_name, story.case_name);
assert.ok(pub.tracks.length > 20 && Object.keys(pub.roles).length === 4);
if (!process.env.KEEP_PUBLIC) { // KEEP_PUBLIC=1 leaves the replay public (to try the web page)
  ok(await x.sb.rpc("set_replay_public", { p_game: game.id, p_public: false }));
  await fails(anon.rpc("public_replay", { p_code: game.code }), "replay_not_found");
}

console.log(`OK – ${story.case_name} (${game.code}); rematch ${g2.code}; public replay on/off`);
process.exit(0);
