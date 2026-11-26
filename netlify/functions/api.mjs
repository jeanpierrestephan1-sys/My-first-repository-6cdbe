// Turkey Bowl Pool API — Netlify Function (v2) + Netlify Blobs for shared storage.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

export const config = { path: "/api/*" };

const MAX_PLAYERS = 12;
const ENTRY_PER_GAME = 1;
const ADMIN_CODE = (globalThis.Netlify?.env?.get?.("ADMIN_CODE")) || process.env.ADMIN_CODE || ""; // set in Netlify, never in the repo
const LINES_AS_OF = "Wed, Nov 25 at 6:50 PM ET";

// spread = HOME team's spread (negative = home favored). total = over/under.
// espnA / espnH = ESPN "location" names used to auto-match final scores.
export const GAMES = [
  { id: "nfl0", lg: "NFL", day: "Wednesday", ko: "2026-11-26T01:00:00Z", lock: "2026-11-26T01:20:00Z", away: "Packers", home: "Rams", spread: -2.5, total: 43.5, tv: "Netflix", espnA: "Green Bay", espnH: "Los Angeles" },
  { id: "nfl1", lg: "NFL", day: "Thanksgiving", ko: "2026-11-26T18:00:00Z", away: "Bears", home: "Lions", spread: 1.5, total: 55.5, tv: "CBS", espnA: "Chicago", espnH: "Detroit" },
  { id: "nfl2", lg: "NFL", day: "Thanksgiving", ko: "2026-11-26T21:30:00Z", away: "Eagles", home: "Cowboys", spread: -8.5, total: 47.5, tv: "FOX", espnA: "Philadelphia", espnH: "Dallas" },
  { id: "nfl3", lg: "NFL", day: "Thanksgiving", ko: "2026-11-27T01:20:00Z", away: "Chiefs", home: "Bills", spread: -3, total: 46.5, tv: "NBC", espnA: "Kansas City", espnH: "Buffalo", tb: "tb1" },
  { id: "cfb1", lg: "CFB", day: "Friday", ko: "2026-11-27T17:00:00Z", away: "Nebraska", home: "Iowa", spread: -4.5, total: 40.5, espnA: "Nebraska", espnH: "Iowa" },
  { id: "nfl4", lg: "NFL", day: "Friday", ko: "2026-11-27T20:00:00Z", away: "Broncos", home: "Steelers", spread: 3.5, total: 36.5, tv: "Prime", espnA: "Denver", espnH: "Pittsburgh" },
  { id: "cfb2", lg: "CFB", day: "Friday", ko: "2026-11-27T20:30:00Z", away: "Florida", home: "Florida State", spread: 6.5, total: 53.5, espnA: "Florida", espnH: "Florida State" },
  { id: "cfb3", lg: "CFB", day: "Friday", ko: "2026-11-28T00:30:00Z", away: "Texas", home: "Texas A&M", spread: 11, total: 40.5, espnA: "Texas", espnH: "Texas A&M" },
  { id: "cfb9", lg: "CFB", day: "Saturday", ko: "2026-11-28T17:00:00Z", away: "Notre Dame", home: "Syracuse", spread: 25.5, total: 52.5, espnA: "Notre Dame", espnH: "Syracuse" },
  { id: "cfb4", lg: "CFB", day: "Saturday", ko: "2026-11-28T17:00:00Z", away: "Michigan", home: "Ohio State", spread: -10.5, total: 37.5, espnA: "Michigan", espnH: "Ohio State" },
  { id: "cfb5", lg: "CFB", day: "Saturday", ko: "2026-11-28T20:00:00Z", away: "South Carolina", home: "Clemson", spread: 6, total: 41.5, espnA: "South Carolina", espnH: "Clemson" },
  { id: "cfb6", lg: "CFB", day: "Saturday", ko: "2026-11-28T20:30:00Z", away: "Penn State", home: "Maryland", spread: 7, total: 48.5, espnA: "Penn State", espnH: "Maryland" },
  { id: "cfb7", lg: "CFB", day: "Saturday", ko: "2026-11-29T00:30:00Z", away: "Pitt", home: "Cal", spread: 9.5, total: 47.5, espnA: "Pittsburgh", espnH: "California" },
  { id: "cfb10", lg: "CFB", day: "Saturday", ko: "2026-11-29T00:30:00Z", away: "Washington", home: "Oregon", spread: -14, total: 50.5, espnA: "Washington", espnH: "Oregon" },
  { id: "cfb8", lg: "CFB", day: "Saturday", ko: "2026-11-29T00:30:00Z", away: "Auburn", home: "Alabama", spread: -15, total: 49.5, espnA: "Auburn", espnH: "Alabama", tb: "tb2" },
];
const GAME = Object.fromEntries(GAMES.map((g) => [g.id, g]));
const TB_GAME = { tb1: "nfl3", tb2: "cfb8" };

const db = () => globalThis.__MOCK_STORE || getStore({ name: "turkey-pool", consistency: "strong" });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (msg, status = 400) => json({ error: msg }, status);
const hash = (id, pin) => createHash("sha256").update(`${id}:${pin}:turkey`).digest("hex");
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const locked = (gid, now) => now >= Date.parse(GAME[gid].lock || GAME[gid].ko);

async function allPlayers(store) {
  const { blobs } = await store.list({ prefix: "player/" });
  const rows = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return rows.filter(Boolean).sort((a, b) => a.joined - b.joined);
}

async function auth(store, name, pin) {
  const id = slug(String(name || ""));
  if (!id) return null;
  const p = await store.get(`player/${id}`, { type: "json" });
  if (!p || p.pinHash !== hash(id, String(pin || ""))) return null;
  return p;
}

// Pull finals from ESPN's public scoreboard. Only writes a result when BOTH teams
// match the expected home/away slots and the game is marked completed.
async function refreshResults(store, results, now) {
  const due = GAMES.some((g) => now > Date.parse(g.ko) + 2.5 * 3600e3 && !results.games[g.id]?.final);
  if (!due || now - (results.checkedAt || 0) < 120e3) return results;
  results.checkedAt = now;
  const feeds = {
    NFL: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261125-20261128",
    CFB: "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=20261125-20261128&groups=80&limit=300",
  };
  for (const [lg, url] of Object.entries(feeds)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4500) });
      if (!r.ok) continue;
      const data = await r.json();
      for (const ev of data.events || []) {
        const comp = ev.competitions?.[0];
        if (!comp || !comp.status?.type?.completed) continue;
        const h = comp.competitors.find((c) => c.homeAway === "home");
        const a = comp.competitors.find((c) => c.homeAway === "away");
        if (!h || !a) continue;
        const g = GAMES.find((x) => x.lg === lg && x.espnH === h.team.location && x.espnA === a.team.location);
        if (!g || results.games[g.id]?.manual) continue;
        const hs = Number(h.score), as = Number(a.score);
        if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
        results.games[g.id] = { away: as, home: hs, final: true, manual: false };
      }
    } catch { /* scoreboard unreachable — commissioner can enter scores by hand */ }
  }
  await store.setJSON("results", results);
  return results;
}

function publicView(p, me, now) {
  const mine = me && me.id === p.id;
  const picks = {};
  for (const [gid, side] of Object.entries(p.picks || {})) if (mine || locked(gid, now)) picks[gid] = side;
  const tb = {};
  for (const k of ["tb1", "tb2"]) if (p.tb?.[k] != null && (mine || locked(TB_GAME[k], now))) tb[k] = p.tb[k];
  return { id: p.id, name: p.name, paid: !!p.paid, picks, tb, made: Object.keys(p.picks || {}).length };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const store = db();
  const now = Date.now();
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return err("Bad request"); } }

  if (route === "state" && req.method === "GET") {
    const me = await auth(store, url.searchParams.get("name"), url.searchParams.get("pin"));
    let results = (await store.get("results", { type: "json" })) || { games: {}, checkedAt: 0 };
    results = await refreshResults(store, results, now);
    const players = await allPlayers(store);
    return json({
      now, max: MAX_PLAYERS, perGame: ENTRY_PER_GAME, linesAsOf: LINES_AS_OF,
      games: GAMES.map(({ espnA, espnH, ...g }) => g),
      results: results.games,
      players: players.map((p) => publicView(p, me, now)),
      me: me ? me.id : null,
    });
  }

  if (route === "join" && req.method === "POST") {
    const name = String(body.name || "").trim().slice(0, 18);
    const pin = String(body.pin || "");
    const id = slug(name);
    if (!id) return err("Enter a name.");
    if (!/^\d{4}$/.test(pin)) return err("PIN must be 4 digits.");
    const existing = await store.get(`player/${id}`, { type: "json" });
    if (existing) {
      if (existing.pinHash !== hash(id, pin)) return err("That name is taken — wrong PIN.", 401);
      return json({ ok: true, id, name: existing.name });
    }
    const players = await allPlayers(store);
    if (players.length >= MAX_PLAYERS) return err(`Pool is full (${MAX_PLAYERS} players).`, 403);
    await store.setJSON(`player/${id}`, { id, name, pinHash: hash(id, pin), picks: {}, tb: {}, paid: false, joined: now });
    return json({ ok: true, id, name });
  }

  if (route === "picks" && req.method === "POST") {
    const me = await auth(store, body.name, body.pin);
    if (!me) return err("Sign in again.", 401);
    const rejected = [];
    for (const [gid, side] of Object.entries(body.picks || {})) {
      if (!GAME[gid] || !["away", "home"].includes(side)) continue;
      if (locked(gid, now)) { if (me.picks[gid] !== side) rejected.push(gid); continue; }
      me.picks[gid] = side;
    }
    for (const k of ["tb1", "tb2"]) {
      const v = body.tb?.[k];
      if (v == null || v === "") continue;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > 200) continue;
      if (locked(TB_GAME[k], now)) { if (me.tb[k] !== n) rejected.push(k); continue; }
      me.tb[k] = n;
    }
    await store.setJSON(`player/${me.id}`, me);
    return json({ ok: true, rejected });
  }

  if (route === "admin" && req.method === "POST") {
    if (!ADMIN_CODE) return err("Commissioner code isn't set up yet (ADMIN_CODE in Netlify).", 401);
    if (String(body.code || "") !== ADMIN_CODE) return err("Wrong commissioner code.", 401);
    const a = body.action;
    if (a === "check") return json({ ok: true });
    if (a === "setResult" || a === "clearResult") {
      if (!GAME[body.gid]) return err("Unknown game.");
      const results = (await store.get("results", { type: "json" })) || { games: {}, checkedAt: 0 };
      if (a === "clearResult") delete results.games[body.gid];
      else {
        const away = Number(body.away), home = Number(body.home);
        if (![away, home].every((n) => Number.isInteger(n) && n >= 0 && n < 200)) return err("Scores must be whole numbers.");
        results.games[body.gid] = { away, home, final: true, manual: true };
      }
      await store.setJSON("results", results);
      return json({ ok: true });
    }
    const id = slug(String(body.id || ""));
    const p = id && (await store.get(`player/${id}`, { type: "json" }));
    if (!p) return err("Unknown player.");
    if (a === "setPaid") { p.paid = !!body.paid; await store.setJSON(`player/${id}`, p); return json({ ok: true }); }
    if (a === "resetPin") {
      if (!/^\d{4}$/.test(String(body.pin || ""))) return err("PIN must be 4 digits.");
      p.pinHash = hash(id, String(body.pin)); await store.setJSON(`player/${id}`, p); return json({ ok: true });
    }
    if (a === "removePlayer") { await store.delete(`player/${id}`); return json({ ok: true }); }
    return err("Unknown action.");
  }

  return err("Not found", 404);
}
