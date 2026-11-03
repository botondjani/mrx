// Bot simulator: fake players that move inside the game area and report positions
// through the same report_position Edge Function as the app.
// Detective bots chase Mr. X's latest reveal; a Mr. X bot confirms the catch when a
// detective gets within proximity range. Runs until the game is over.
//
// Join an existing lobby (the human host assigns roles and starts):
//   npm run bots -- --code ABC123 --n 3 --speed 5
// Create a game run entirely by bots (optionally wait for humans to join first):
//   npm run bots -- --create --lat 47.4979 --lng 19.0402 --radius 1000 --n 4 --mrx 0 --start-after 60
// Shortened game (minutes / seconds):
//   npm run bots -- --create --lat 47.4979 --lng 19.0402 --n 4 --duration 10 --head-start 60 --reveal 60
//   --mrx <bot index> | random   (random also includes humans who joined during --start-after)
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values: opt } = parseArgs({
  options: {
    code: { type: "string" },
    create: { type: "boolean", default: false },
    lat: { type: "string" },
    lng: { type: "string" },
    radius: { type: "string", default: "1000" },
    n: { type: "string", default: "3" },
    mrx: { type: "string", default: "random" },
    speed: { type: "string", default: "5" }, // km/h, Mr. X
    "det-speed": { type: "string", default: "8" }, // km/h, detectives
    duration: { type: "string" }, // minutes
    "head-start": { type: "string" }, // seconds
    reveal: { type: "string" }, // seconds (endgame uses the same)
    "start-after": { type: "string", default: "0" },
  },
});

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;
if (!URL || !KEY) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY (use --env-file=.env)");
if (!opt.create && !opt.code) throw new Error("Use --code <CODE> or --create");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toRad = (d) => (d * Math.PI) / 180;
const distM = (a, b) => {
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const move = (p, bearingDeg, meters) => ({
  lat: p.lat + (meters * Math.cos(toRad(bearingDeg))) / 111320,
  lng: p.lng + (meters * Math.sin(toRad(bearingDeg))) / (111320 * Math.cos(toRad(p.lat))),
});
const bearing = (a, b) =>
  (Math.atan2(toRad(b.lng - a.lng) * Math.cos(toRad(a.lat)), toRad(b.lat - a.lat)) * 180) / Math.PI;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function newBot(name) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw new Error(`${name}: sign-in failed: ${error.message}`);
  return { sb, name, userId: data.user.id };
}

async function rpc(bot, fn, args) {
  const { data, error } = await bot.sb.rpc(fn, args);
  if (error) throw new Error(`${bot.name}: ${fn} failed: ${error.message}`);
  return data;
}

const bots = [];
let game;

if (opt.create) {
  if (!opt.lat || !opt.lng) throw new Error("--create needs --lat and --lng");
  const host = await newBot("Bot 1");
  bots.push(host);
  game = await rpc(host, "create_game", { p_name: host.name });
  await rpc(host, "set_area", {
    p_game: game.id, p_lat: Number(opt.lat), p_lng: Number(opt.lng), p_radius_m: Number(opt.radius),
  });
  const options = {};
  if (opt.duration) options.duration_min = Number(opt.duration);
  if (opt["head-start"]) options.head_start_s = Number(opt["head-start"]);
  if (opt.reveal) options.reveal_interval_s = options.reveal_interval_endgame_s = Number(opt.reveal);
  if (Object.keys(options).length) await rpc(host, "set_options", { p_game: game.id, p_options: options });
  log(`Game created: code ${game.code} (id ${game.id})`);
} else {
  game = { code: opt.code };
}

for (let i = bots.length; i < Number(opt.n); i++) {
  const bot = await newBot(`Bot ${i + 1}`);
  game = await rpc(bot, "join_game", { p_code: game.code, p_name: bot.name });
  bots.push(bot);
}
log(`${bots.length} bots in game ${game.code}`);

if (opt.create) {
  const waitS = Number(opt["start-after"]);
  if (waitS > 0) {
    log(`Waiting ${waitS}s for humans to join with code ${game.code}...`);
    await sleep(waitS * 1000);
  }
  const { data: players } = await bots[0].sb.from("players").select("id, user_id").eq("game_id", game.id);
  const mrxPlayer = /^\d+$/.test(opt.mrx) ? players.find((p) => p.user_id === bots[Number(opt.mrx)].userId).id : null;
  await rpc(bots[0], "assign_roles", { p_game: game.id, p_mrx_player: mrxPlayer });
  await rpc(bots[0], "start_game", { p_game: game.id });
  log("Game started");
}

// Wait until the game runs (a human host may start it later).
let g;
for (;;) {
  g = (await bots[0].sb.from("games").select("*").eq("code", game.code).single()).data;
  if (g.status === "running") break;
  if (g.status === "finished") process.exit(0);
  log(`Game status: ${g.status}, waiting for start...`);
  await sleep(5000);
}

const center = { lat: g.center_lat, lng: g.center_lng };
const headStartEnd = new Date(g.started_at).getTime() + g.config.head_start_s * 1000;
for (const bot of bots) {
  bot.role = (await bot.sb.from("players").select("role").eq("game_id", g.id).eq("user_id", bot.userId).single()).data.role;
  bot.pos = bot.role === "mrx" ? move(center, Math.random() * 360, Math.random() * 100) : { ...center };
  bot.heading = Math.random() * 360;
  bot.speed = Number(bot.role === "mrx" ? opt.speed : opt["det-speed"]) / 3.6; // m/s
}
log(bots.map((b) => `${b.name}=${b.role}`).join(", "));

let intervalMs = g.config.report_interval_s * 1000;
let lastTick = Date.now();
let over = false;

async function target(bot) {
  // Detectives head for the latest reveal (after the head start); otherwise wander.
  if (bot.role !== "detective" || Date.now() < headStartEnd) return null;
  const { data } = await bot.sb.from("reveals").select("lat, lng").eq("game_id", g.id)
    .order("revealed_at", { ascending: false }).limit(1).maybeSingle();
  return data && distM(bot.pos, data) > 15 ? data : null;
}

async function tick(bot, dt) {
  const t = await target(bot);
  if (t) bot.heading = bearing(bot.pos, t) + (Math.random() - 0.5) * 20;
  else if (bot.role === "detective" && Date.now() < headStartEnd) bot.heading = bearing(bot.pos, center);
  else bot.heading += (Math.random() - 0.5) * 60;
  const step = bot.role === "detective" && Date.now() < headStartEnd ? 0 : bot.speed * dt;
  let next = move(bot.pos, bot.heading, step);
  if (distM(center, next) > g.radius_m * 0.95) {
    bot.heading = bearing(bot.pos, center) + (Math.random() - 0.5) * 60;
    next = move(bot.pos, bot.heading, step);
  }
  bot.pos = next;
  const { data, error } = await bot.sb.functions.invoke("report_position", {
    body: {
      game_id: g.id,
      locations: [{ lat: bot.pos.lat, lng: bot.pos.lng, accuracy: 5, speed: bot.speed,
        heading: ((bot.heading % 360) + 360) % 360, timestamp: Date.now() }],
    },
  });
  if (error) return log(`${bot.name}: report failed: ${error.message}`);
  for (const e of data.events) log(`${bot.name} (${bot.role}) event: ${e.kind}`, JSON.stringify(e.payload));
  if (bot.role === "mrx" && data.events.some((e) => e.kind === "proximity")) {
    const cands = await rpc(bot, "catch_candidates", { p_game: g.id });
    if (cands[0]?.nearby) {
      log(`${bot.name}: caught by ${cands[0].name} – confirming`);
      await rpc(bot, "confirm_catch", { p_game: g.id, p_detective: cands[0].player_id });
    }
  }
  if (data.game_status === "finished") over = true;
  return data;
}

while (!over) {
  const t0 = Date.now();
  const dt = (t0 - lastTick) / 1000;
  lastTick = t0;
  const results = await Promise.all(bots.map((b) => tick(b, dt)));
  const next = results.find((r) => r?.next_interval_ms)?.next_interval_ms ?? intervalMs;
  if (next !== intervalMs) log(`report interval → ${next / 1000}s`);
  intervalMs = next;
  await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
}
// One more round so every bot receives the game_over event.
await Promise.all(bots.map((b) => tick(b, 0)));
const final = (await bots[0].sb.from("games").select("winner, caught_by, started_at, finished_at").eq("id", g.id).single()).data;
log(`Game over – winner: ${final.winner}`, JSON.stringify(final));
process.exit(0);
