// Verifies that clients only receive positions their role may see.
//   node --env-file=.env scripts/rls-test.mjs
// Creates a 4-player game (bot 0 = Mr. X), reports positions, then checks
// selects and Realtime events from each role's point of view.
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bot(name) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return { sb, name, userId: data.user.id };
}
const ok = ({ data, error }) => {
  if (error) throw error;
  return data;
};

const bots = [await bot("X"), await bot("D1"), await bot("D2"), await bot("D3")];
const [mrx, d1] = bots;
const game = ok(await mrx.sb.rpc("create_game", { p_name: mrx.name }));
ok(await mrx.sb.rpc("set_area", { p_game: game.id, p_lat: 47.4979, p_lng: 19.0402, p_radius_m: 1000 }));
for (const b of bots.slice(1)) ok(await b.sb.rpc("join_game", { p_code: game.code, p_name: b.name }));
const players = ok(await mrx.sb.from("players").select("id, user_id").eq("game_id", game.id));
const pid = (b) => players.find((p) => p.user_id === b.userId).id;
ok(await mrx.sb.rpc("assign_roles", { p_game: game.id, p_mrx_player: pid(mrx) }));
ok(await mrx.sb.rpc("start_game", { p_game: game.id }));

const report = (b, i) =>
  b.sb.functions.invoke("report_position", {
    body: { game_id: game.id, locations: [{ lat: 47.4979 + i * 0.001, lng: 19.0402, accuracy: 5, timestamp: Date.now() }] },
  }).then(ok);

// Detective subscribes to Realtime before the second round of reports.
const seen = [];
const channel = d1.sb
  .channel("rls-test")
  .on("postgres_changes", { event: "*", schema: "public", table: "live_positions", filter: `game_id=eq.${game.id}` },
    (e) => seen.push(e.new.player_id))
  .subscribe();
await Promise.all(bots.map(report));
await sleep(3000); // let the subscription settle
await Promise.all(bots.map(report));
await sleep(4000);
await d1.sb.removeChannel(channel);

const dLive = ok(await d1.sb.from("live_positions").select("player_id, role").eq("game_id", game.id));
assert.equal(dLive.length, 3, "detective sees the 3 detectives");
assert.ok(dLive.every((r) => r.role === "detective"), "detective never sees Mr. X live");

const xLive = ok(await mrx.sb.from("live_positions").select("player_id").eq("game_id", game.id));
assert.deepEqual(xLive.map((r) => r.player_id), [pid(mrx)], "Mr. X sees only himself");

const dHistory = ok(await d1.sb.from("positions").select("id").eq("game_id", game.id));
assert.equal(dHistory.length, 0, "position history is not readable");

assert.ok(seen.length > 0, "detective receives Realtime updates");
assert.ok(!seen.includes(pid(mrx)), "Realtime never delivers Mr. X to a detective");

console.log(`OK – game ${game.code}: detective saw ${dLive.length} live rows, ${seen.length} Realtime events, 0 of Mr. X`);
process.exit(0);
