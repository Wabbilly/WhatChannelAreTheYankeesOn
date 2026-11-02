#!/usr/bin/env node
/**
 * update-snapshot.mjs
 * ------------------------------------------------------------------
 * Bakes a crawler-visible answer for "what channel are the Yankees on
 * tonight?" directly into index.html, so search engines and no-JS
 * visitors get a real answer instead of "Live schedule requires
 * JavaScript." Run daily (see .github/workflows/refresh-snapshot.yml).
 *
 * It rewrites three regions of index.html, each delimited so re-runs are
 * idempotent:
 *   1. The <!-- SNAPSHOT:START --> ... <!-- SNAPSHOT:END --> block
 *   2. The <script id="next-game-schema"> JSON-LD SportsEvent
 *   3. The footer "UPDATED:" timestamp (#last-updated)
 *
 * No dependencies — Node 18+ (global fetch). Never throws on network
 * failure; it leaves the existing file untouched and exits 0 so a flaky
 * MLB API call can't break a deploy.
 */

import { readFile, writeFile } from 'node:fs/promises';

const YANKEES_ID = 147;
const INDEX_URL = new URL('../index.html', import.meta.url);
const TZ = 'America/New_York';

// ---- Broadcast resolution — kept in lockstep with resolveYankeesTV() in index.html ----
const NATIONAL_NAME_HINTS = ['ESPN','FOX','FS1','TBS','PEACOCK','APPLE','NETFLIX','ROKU','TNT','MAX','MLB NETWORK'];
const OPP_RSN = ['NESN','SNY','MASN','BALLY','FANDUEL','ROOT','MARQUEE','SPACE CITY','MARINERS','SPORTSNET','SPECTRUM SPORTSNET','NBCS','NBC SPORTS','MSG','CHSN','CHICAGO SPORTS','RANGERS SPORTS','.TV'];

const isTvEntry = (b) => {
  const t = (b.type || '').toUpperCase();
  if (!(t === 'TV' || t === 'NATIONAL' || t === 'WEB' || t === 'STREAMING' || t === 'OTT')) return false;
  const u = (b.name || '').toUpperCase();
  if (u.includes('WFAN') || u.includes('WADO') || t === 'AM' || t === 'FM') return false;
  return true;
};
const nameLooksNational = (u) => {
  if (/NBCS/.test(u) || /NBC\s*SPORTS/.test(u)) return false; // regional NBC Sports RSNs
  if (/(^|[^A-Z])NBC([^A-Z]|$)/.test(u)) return true;         // national NBC
  return NATIONAL_NAME_HINTS.some((k) => u.includes(k));
};
const isNational = (b) => {
  if (b.isNational === true) return true;
  if ((b.homeAway || '').toLowerCase() === 'national') return true;
  return nameLooksNational((b.name || '').toUpperCase());
};
const isExclusiveNational = (b) => {
  const u = (b.name || '').toUpperCase();
  if (u.includes('MLB NETWORK') || u === 'MLBN') return false;
  return isNational(b);
};
// Postponed/suspended/cancelled games come back as abstractGameState "Final" with
// no scores — never treat them as a real final.
const isPostponedLike = (g) => {
  const d = (g.status?.detailedState || '').toLowerCase();
  const c = g.status?.codedGameState || '';
  return d.includes('postpone') || d.includes('suspend') || d.includes('cancel') || c === 'D' || c === 'C' || c === 'U';
};
const isRealFinal = (g) => g.status?.abstractGameState === 'Final' && !isPostponedLike(g);
function resolveYankeesTV(broadcasts, yankeesAreHome) {
  const tv = (broadcasts || []).filter(isTvEntry);
  const oppSide = yankeesAreHome ? 'away' : 'home';
  const relevant = tv.filter((b) => {
    const u = (b.name || '').toUpperCase();
    if (OPP_RSN.some((k) => u.includes(k)) && !isNational(b)) return false;
    if ((b.homeAway || '').toLowerCase() === oppSide && !isNational(b)) return false;
    return true;
  });
  const dedupe = (arr) => { const seen = new Set(), out = []; for (const b of arr) { const k = (b.name || '').toUpperCase(); if (!seen.has(k)) { seen.add(k); out.push(b); } } return out; };
  const exclusives = dedupe(relevant.filter(isExclusiveNational));
  const yes = relevant.find((b) => (b.name || '').toUpperCase().includes('YES'));
  if (exclusives.length) return { primary: exclusives[0], secondary: exclusives.slice(1, 3), national: true, unknown: false, all: exclusives };
  if (yes) { const others = dedupe(relevant.filter((b) => b !== yes)); return { primary: yes, secondary: others.slice(0, 2), national: false, unknown: false, all: dedupe([yes, ...others]) }; }
  const rel = dedupe(relevant);
  if (rel.length) return { primary: rel[0], secondary: rel.slice(1, 3), national: isNational(rel[0]), unknown: false, all: rel };
  return { primary: null, secondary: [], national: false, unknown: true, all: [] };
}

// ---- date/format helpers (all in ET) ----
const etParts = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD
const fmtDay = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
const fmtTime = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Friendlier display names for the terse call signs the MLB feed sometimes returns.
const NET_DISPLAY = { 'YES': 'YES Network', 'MLBN': 'MLB Network' };
const netName = (n) => NET_DISPLAY[(n || '').toUpperCase()] || n;

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'whatchannelaretheyankeeson.com snapshot bot' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function pickGame(games, nowMs) {
  // Prefer a game today that is live or upcoming; otherwise the next scheduled game;
  // otherwise the most recent REAL final so the answer is never empty and never a
  // postponed 0-0 ghost.
  const sorted = games.slice().sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
  const upcoming = sorted.find((g) => {
    const state = (g.status?.abstractGameState || '').toLowerCase();
    if (isPostponedLike(g)) return false;
    return state !== 'final' && new Date(g.gameDate).getTime() >= nowMs - 4 * 3600e3; // include in-progress
  });
  if (upcoming) return upcoming;
  const finals = sorted.filter(isRealFinal);
  return finals.length ? finals[finals.length - 1] : sorted.find((g) => !isPostponedLike(g)) || null;
}

function buildSnapshot(game, nowMs) {
  if (!game) {
    const html = `<p style="font-family:'Oswald',sans-serif;font-size:1rem;line-height:1.5;color:var(--cream);margin:0;">No Yankees game is scheduled right now. See the <a href="https://www.mlb.com/yankees/schedule" style="color:var(--gold-bright);">full Yankees schedule</a>.</p>`;
    return { html, schema: null };
  }
  const home = game.teams.home.team;
  const away = game.teams.away.team;
  const yankHome = home.id === YANKEES_ID;
  const opp = yankHome ? away : home;
  const r = resolveYankeesTV(game.broadcasts, yankHome);
  const state = (game.status?.abstractGameState || '').toLowerCase();
  const isLive = state === 'live' || (game.status?.detailedState || '').toLowerCase().includes('in progress');
  const isFinal = isRealFinal(game);
  const dhNote = (game.doubleHeader && game.doubleHeader !== 'N') ? ` (doubleheader — Game ${game.gameNumber || ''})`.replace(' )', ')') : '';
  const todayStr = etParts(new Date(nowMs));
  const gameStr = etParts(new Date(game.gameDate));
  const isToday = todayStr === gameStr;

  const primaryName = r.primary ? netName(r.primary.name) : 'YES Network';
  const channelHtml = r.unknown
    ? `<strong style="color:var(--gold-bright);">YES Network</strong> <span style="color:var(--cream-dim);font-size:0.85rem;">(likely — confirm on the YES / Gotham Sports app)</span>`
    : `<strong style="color:var(--gold-bright);">${esc(primaryName)}</strong>${r.national ? ` <span style="color:var(--cream-dim);font-size:0.85rem;">(national broadcast — blacked out on YES)</span>` : ''}`;
  const vs = yankHome ? `vs. the ${esc(opp.name)}` : `at the ${esc(opp.name)}`;

  let lead;
  if (isLive) lead = `The Yankees are playing ${vs} right now`;
  else if (isFinal) lead = `The Yankees' last game ${vs} (${fmtDay(game.gameDate)}) has finished`;
  else if (isToday) lead = `Today the Yankees play ${vs}, first pitch ${fmtTime(game.gameDate)} ET`;
  else lead = `The next Yankees game is ${fmtDay(game.gameDate)} ${vs}, first pitch ${fmtTime(game.gameDate)} ET`;

  const watchVerb = isFinal ? 'It aired on' : 'Watch on';
  const html = `<p style="font-family:'Oswald',sans-serif;font-size:1.02rem;line-height:1.55;color:var(--cream);margin:0;">${lead}${dhNote}. ${watchVerb} ${channelHtml}. <span style="color:var(--cream-dim);font-size:0.82rem;">Live scoreboard, lineups, and full schedule below.</span></p>`;

  const venue = game.venue?.name || (yankHome ? 'Yankee Stadium' : `${esc(home.name)} ballpark`);
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${away.name} at ${home.name}`,
    sport: 'Baseball',
    startDate: game.gameDate,
    eventStatus: isFinal ? 'https://schema.org/EventCompleted' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/MixedEventAttendanceMode',
    location: { '@type': 'Place', name: venue },
    homeTeam: { '@type': 'SportsTeam', name: home.name },
    awayTeam: { '@type': 'SportsTeam', name: away.name },
    url: 'https://whatchannelaretheyankeeson.com',
    ...(r.primary ? { broadcastOfEvent: { '@type': 'BroadcastEvent', name: netName(r.primary.name), isLiveBroadcast: !isFinal } } : {}),
  };
  return { html, schema };
}

function replaceBetween(src, startMarker, endMarker, replacement) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s + startMarker.length);
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(0, s + startMarker.length) + replacement + src.slice(e);
}

async function main() {
  const now = new Date();
  const nowMs = now.getTime();
  const start = etParts(now);
  const endD = new Date(nowMs + 14 * 864e5);
  const end = etParts(endD);

  let games = [];
  try {
    const url = `https://statsapi.mlb.com/api/v1/schedule?teamId=${YANKEES_ID}&sportId=1&startDate=${start}&endDate=${end}&hydrate=broadcasts,probablePitcher,linescore`;
    const data = await getJSON(url);
    for (const d of data.dates || []) for (const g of d.games || []) games.push(g);
  } catch (err) {
    console.error('[snapshot] fetch failed, leaving index.html unchanged:', err.message);
    return; // exit 0 — never break a deploy over a flaky API call
  }

  const game = pickGame(games, nowMs);
  const { html, schema } = buildSnapshot(game, nowMs);

  let src = await readFile(INDEX_URL, 'utf8');
  const before = src;

  // 1) snapshot block
  const snapInner = `\n  <div class="quick-answer" id="quick-answer" style="max-width:900px;margin:8px auto 0;padding:12px 16px;min-height:52px;background:rgba(196,164,74,0.07);border:1px solid var(--cell-border);border-radius:6px;text-align:center;position:relative;z-index:1;">\n    ${html}\n  </div>\n  `;
  src = replaceBetween(src, '<!-- SNAPSHOT:START — auto-generated daily by scripts/update-snapshot.mjs; do not hand-edit -->', '<!-- SNAPSHOT:END -->', snapInner);

  // 2) JSON-LD SportsEvent (only when we have a concrete game)
  if (schema) {
    const jsonBlock = `\n${JSON.stringify(schema, null, 2)}\n`;
    src = replaceBetween(src, '<script type="application/ld+json" id="next-game-schema">', '</script>', jsonBlock);
  }

  // 3) footer timestamp
  const stamp = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now) + ' ET';
  src = src.replace(/(<span id="last-updated">)[^<]*(<\/span>)/, `$1${stamp}$2`);

  // Bump the homepage <lastmod> in sitemap.xml to today (ET) — quiet SEO freshness.
  try {
    const SITEMAP_URL = new URL('../sitemap.xml', import.meta.url);
    const today = etParts(now); // YYYY-MM-DD
    let sm = await readFile(SITEMAP_URL, 'utf8');
    const sm2 = sm.replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, `<lastmod>${today}</lastmod>`);
    if (sm2 !== sm) { await writeFile(SITEMAP_URL, sm2, 'utf8'); console.log(`[snapshot] sitemap lastmod -> ${today}`); }
  } catch (e) { /* sitemap optional */ }

  if (src === before) { console.log('[snapshot] no change'); return; }
  await writeFile(INDEX_URL, src, 'utf8');
  console.log(`[snapshot] updated — ${game ? `${game.teams.away.team.name} @ ${game.teams.home.team.name}` : 'no game'} · ${stamp}`);
}

main().catch((e) => { console.error('[snapshot] unexpected error (non-fatal):', e); });
