// The game's "case file": types, Hungarian highlight lines and the share-card renderer script.
import { SITE_URL } from './env';

export type Story = {
  code: string;
  case_name: string;
  winner: 'mrx' | 'detectives';
  duration_min: number;
  mrx: string;
  caught_by: string | null;
  center: { lat: number; lng: number };
  radius_m: number;
  catch_point: { lat: number; lng: number } | null;
  closest: { name: string; meters: number; minute: number } | null;
  reveals: number;
  items_used: Record<string, number>;
  players: { name: string; role: 'mrx' | 'detective'; title: string; distance_m: number; items: number }[];
};

/** Track points for the card: [role, lat, lng] in time order. */
export type CardTrack = { role: 'mrx' | 'detective'; points: [number, number][] };

/** Hungarian definite article before a number: "az 1.", "az 5.", "az 50.", but "a 2.", "a 10." */
export const az = (n: number) => (/^(1|5\d*|1\d{3})$/.test(String(n)) ? 'az' : 'a');

const km = (m: number) => `${(m / 1000).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} km`;

export function storyLines(s: Story): string[] {
  const lines = [
    s.winner === 'mrx'
      ? `${s.mrx} (Mr. X) ${s.duration_min} percig bujkált – és megúszta.`
      : `${s.caught_by} elkapta Mr. X-et (${s.mrx}) ${az(s.duration_min)} ${s.duration_min}. percben.`,
  ];
  if (s.closest) {
    lines.push(
      s.winner === 'mrx'
        ? `Hajszálnyira: ${s.closest.name} ${s.closest.meters} méterre volt tőle ${az(s.closest.minute)} ${s.closest.minute}. percben.`
        : `Előtte ${s.closest.name} már ${s.closest.meters} méterre járt ${az(s.closest.minute)} ${s.closest.minute}. percben.`,
    );
  }
  const used = s.items_used;
  const tricks = [
    used.decoy && `${used.decoy}× csali`,
    used.fog && `${used.fog}× köd`,
    used.hide && `${used.hide}× rejtőzködés`,
    used.jam && `${used.jam}× zavarás`,
    used.radar && `${used.radar}× radar`,
    used.tracker && `${used.tracker}× nyomkövető`,
    used.compass && `${used.compass}× iránytű`,
  ].filter(Boolean);
  lines.push(`${s.reveals} felfedés${tricks.length ? ' · ' + tricks.join(' · ') : ''}`);
  const mrx = s.players.find((p) => p.role === 'mrx');
  if (mrx?.distance_m) lines.push(`Mr. X ${km(mrx.distance_m)}-t futott.`);
  return lines;
}

/** Plain-text share message (works in any chat app). */
export function storyText(s: Story, replayUrl?: string) {
  return [
    `🕵️ ${s.case_name.toUpperCase()}`,
    ...storyLines(s),
    s.players.map((p) => `${p.name}: ${p.title}`).join(' · '),
    replayUrl ? `Nézd vissza a hajszát: ${replayUrl}` : `Játszd te is: ${SITE_URL}`,
  ].join('\n');
}

/**
 * HTML page that draws the 1080×1350 share card on a canvas and posts back a PNG data URL.
 * Self-contained (no map tiles, so the canvas never gets tainted); font from Google Fonts.
 */
export const CARD_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Special+Elite&display=block" rel="stylesheet">
</head><body style="margin:0;background:#0e0f13"><canvas id="c" width="1080" height="1350"></canvas><script>
const C = { bg:'#0e0f13', panel:'#171920', line:'#2a2d36', ink:'#ece4d4', muted:'#9a927f', gold:'#d4a73c', crimson:'#c8323c' };
const F = (px) => px + 'px "Special Elite", monospace';
function wrap(ctx, text, x, y, maxW, lh) {
  const words = text.split(' '); let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = w; } else line = t;
  }
  if (line) { ctx.fillText(line, x, y); y += lh; }
  return y;
}
async function draw(d) {
  await document.fonts.load(F(40));
  const c = document.getElementById('c'), ctx = c.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, 1080, 1350);
  ctx.strokeStyle = C.gold; ctx.lineWidth = 3; ctx.strokeRect(28, 28, 1024, 1294);
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.gold; ctx.font = F(30); ctx.fillText('MR. X  ·  ÜGYIRAT #' + d.story.code, 70, 70);
  ctx.fillStyle = C.ink; ctx.font = F(62); let y = wrap(ctx, d.story.case_name, 70, 120, 940, 70);

  // Stamp
  ctx.save(); ctx.translate(800, y + 44); ctx.rotate(-0.16);
  const stamp = d.story.winner === 'mrx' ? 'MEGSZÖKÖTT' : 'ELFOGVA';
  ctx.font = F(52); const w = ctx.measureText(stamp).width + 40;
  ctx.strokeStyle = C.crimson; ctx.lineWidth = 6; ctx.strokeRect(-w / 2, -36, w, 76);
  ctx.fillStyle = C.crimson; ctx.textAlign = 'center'; ctx.fillText(stamp, 0, -26); ctx.restore();

  // Map: area circle, detective tracks (gold), Mr. X track (crimson), catch / last position (X)
  const top = y + 90, size = 600, left = (1080 - size) / 2, s = d.story;
  ctx.fillStyle = C.panel; ctx.fillRect(left, top, size, size);
  const k = Math.cos(s.center.lat * Math.PI / 180), span = s.radius_m * 1.08 / 111320;
  const px = (lat, lng) => [left + size / 2 + ((lng - s.center.lng) * k / span) * (size / 2),
                            top + size / 2 - ((lat - s.center.lat) / span) * (size / 2)];
  ctx.setLineDash([14, 10]); ctx.strokeStyle = C.gold; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(left + size / 2, top + size / 2, size / 2 / 1.08, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  for (const role of ['detective', 'mrx']) for (const t of d.tracks.filter((t) => t.role === role)) {
    if (t.points.length < 2) continue;
    ctx.strokeStyle = role === 'mrx' ? C.crimson : 'rgba(212,167,60,.75)'; ctx.lineWidth = role === 'mrx' ? 6 : 3;
    ctx.lineJoin = 'round'; ctx.beginPath();
    t.points.forEach(([la, ln], i) => { const [a, b] = px(la, ln); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.stroke();
  }
  if (s.catch_point) {
    const [a, b] = px(s.catch_point.lat, s.catch_point.lng);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(a - 18, b - 18); ctx.lineTo(a + 18, b + 18); ctx.moveTo(a + 18, b - 18); ctx.lineTo(a - 18, b + 18); ctx.stroke();
  }

  // Highlights and titles
  y = top + size + 40;
  ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.font = F(34);
  for (const l of d.lines) y = wrap(ctx, l, 70, y, 940, 44) + 6;
  ctx.fillStyle = C.gold; ctx.font = F(28);
  y = wrap(ctx, d.story.players.map((p) => p.name + ' – ' + p.title).join('   ·   '), 70, y + 8, 940, 38);
  ctx.fillStyle = C.muted; ctx.font = F(26); ctx.fillText(d.footer, 70, 1270);
  window.ReactNativeWebView.postMessage(c.toDataURL('image/png'));
}
window.ReactNativeWebView.postMessage('ready');
</script></body></html>`;
