// Bot simulator: fake players that walk around inside the game area and report
// positions through the same report_position Edge Function as the app.
//
// Join an existing lobby (the human host assigns roles and starts):
//   node --env-file=.env scripts/bots.mjs --code ABC123 --n 3 --speed 5
// Create a game run entirely by bots (optionally wait for humans to join first):
//   node --env-file=.env scripts/bots.mjs --create --lat 47.4979 --lng 19.0402 --radius 1000 \
//     --n 4 --mrx 0 --speed 5 --start-after 60
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
    speed: { type: "string", default: "5" }, // km/h
    interval: { type: "string" }, // seconds; default: game config report_interval_s
    "start-after": { type: "string", default: "0" },
  },
});

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY;
if (!URL || !KEY) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY (use --env-file=.env)");
if (!opt.create && !opt.code) throw new Error("Use --code <CODE> or --create");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const distM = (a, b) => {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const move = (p, bearingDeg, meters) => ({
  lat: p.lat + (meters * Math.cos(toRad(bearingDeg))) / 111320,
  lng: p.lng + (meters * Math.sin(toRad(bearingDeg))) / (111320 * Math.cos(toRad(p.lat))),
});
const bearing = (a, b) =>
  (Math.atan2(toRad(b.lng - a.lng) * Math.cos(toRad(a.lat)), toRad(b.lat - a.lat)) * 180) / Math.PI;

async function newBot(name) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: true } });
  const { error } = await sb.auth.signInAnonymously();
  if (error) throw new Error(`${name}: sign-in failed: ${error.message}`);
  return { sb, name };
}

async function rpc(bot, fn, args) {
  const { data, error } = await bot.sb.rpc(fn, args);
  if (error) throw new Error(`${bot.name}: ${fn} failed: ${error.message}`);
  return data;
}

const n = Number(opt.n);
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
  console.log(`Game created: code ${game.code} (id ${game.id})`);
} else {
  game = { code: opt.code };
}

for (let i = bots.length; i < n; i++) {
  const bot = await newBot(`Bot ${i + 1}`);
  game = await rpc(bot, "join_game", { p_code: game.code, p_name: bot.name });
  bots.push(bot);
}
console.log(`${bots.length} bots in game ${game.code}`);

if (opt.create) {
  const waitS = Number(opt["start-after"]);
  if (waitS > 0) {
    console.log(`Waiting ${waitS}s for humans to join with code ${game.code}...`);
    await sleep(waitS * 1000);
  }
  const { data: players } = await bots[0].sb.from("players").select("id, user_id").eq("game_id", game.id);
  let mrxPlayer = null; // random draw
  if (/^\d+$/.test(opt.mrx)) {
    const { data: u } = await bots[Number(opt.mrx)].sb.auth.getUser();
    mrxPlayer = players.find((p) => p.user_id === u.user.id).id;
  }
  await rpc(bots[0], "assign_roles", { p_game: game.id, p_mrx_player: mrxPlayer });
  await rpc(bots[0], "start_game", { p_game: game.id });
  console.log("Game started");
}

// Wait until the game runs (human host may start it later), then read area + roles.
let g;
for (;;) {
  const { data } = await bots[0].sb.from("games").select("*").eq("code", game.code).single();
  g = data;
  if (g.status === "running") break;
  if (g.status === "finished") process.exit(0);
  console.log(`Game status: ${g.status}, waiting for start...`);
  await sleep(5000);
}

const center = { lat: g.center_lat, lng: g.center_lng };
const intervalS = Number(opt.interval ?? g.config.report_interval_s);
const stepM = (Number(opt.speed) / 3.6) * intervalS;

for (const bot of bots) {
  const { data: u } = await bot.sb.auth.getUser();
  const { data: me } = await bot.sb.from("players").select("role").eq("game_id", g.id).eq("user_id", u.user.id).single();
  bot.role = me.role;
  // Detectives start at the center, Mr. X somewhere random inside the area.
  bot.pos = bot.role === "mrx" ? move(center, Math.random() * 360, Math.random() * g.radius_m * 0.8) : { ...center };
  bot.heading = Math.random() * 360;
}
console.log(bots.map((b) => `${b.name}=${b.role}`).join(", "));

async function tick(bot) {
  bot.heading += (Math.random() - 0.5) * 60;
  let next = move(bot.pos, bot.heading, stepM);
  if (distM(center, next) > g.radius_m * 0.95) {
    bot.heading = bearing(bot.pos, center) + (Math.random() - 0.5) * 60;
    next = move(bot.pos, bot.heading, stepM);
  }
  bot.pos = next;
  const { data, error } = await bot.sb.functions.invoke("report_position", {
    body: {
      game_id: g.id,
      locations: [{
        lat: bot.pos.lat, lng: bot.pos.lng, accuracy: 5, speed: stepM / intervalS,
        heading: ((bot.heading % 360) + 360) % 360, timestamp: Date.now(),
      }],
    },
  });
  if (error) console.error(`${bot.name}: report failed: ${error.message}`);
  return data;
}

for (;;) {
  const results = await Promise.all(bots.map(tick));
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} reported ${bots.length} positions`, results[0]?.events?.length ? results[0].events : "");
  if (results.some((r) => r?.game_status === "finished")) break;
  await sleep(intervalS * 1000);
}
