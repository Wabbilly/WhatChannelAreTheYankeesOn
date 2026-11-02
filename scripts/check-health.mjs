#!/usr/bin/env node
/**
 * check-health.mjs
 * ------------------------------------------------------------------
 * Watchdog for whatchannelaretheyankeeson.com. Runs alongside the
 * snapshot bot and opens a GitHub issue when something needs a human.
 *
 * It never writes to index.html and never fails the workflow — a bug in
 * here must not be able to break the snapshot pipeline or a deploy.
 * Every problem it finds becomes an issue; it always exits 0.
 *
 * Checks:
 *   1. Unknown broadcaster  — a callsign in MLB's feed that the channel
 *      classifier doesn't recognize (new network, renamed RSN).
 *   2. Snapshot markers     — the four strings the snapshot bot rewrites.
 *      If one drifts, the SEO snapshot silently dies.
 *   3. JSON-LD validity     — every ld+json block still parses.
 *   4. Classifier lockstep  — index.html and update-snapshot.mjs must
 *      agree on OPP_RSN and NATIONAL_NAME_HINTS.
 *
 * Issues are deduped by title, so a given network or breakage is only
 * reported once until the issue is closed.
 *
 * No dependencies — Node 18+ (global fetch).
 */

import { readFile } from 'node:fs/promises';

const YANKEES_ID = 147;
const INDEX_URL = new URL('../index.html', import.meta.url);
const SNAPSHOT_URL = new URL('./update-snapshot.mjs', import.meta.url);
const TZ = 'America/New_York';

const REPO = process.env.GITHUB_REPOSITORY || 'Wabbilly/whatchannelaretheyankeeson';
const TOKEN = process.env.GITHUB_TOKEN || '';

// ---- classifier, mirrored from resolveYankeesTV() ----
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
  if (/NBCS/.test(u) || /NBC\s*SPORTS/.test(u)) return false;
  if (/(^|[^A-Z])NBC([^A-Z]|$)/.test(u)) return true;
  return NATIONAL_NAME_HINTS.some((k) => u.includes(k));
};
// A name is "recognized" if the classifier would route it deliberately:
// as YES, as a national carrier, or as an opponent RSN we filter out.
const isRecognized = (name) => {
  const u = (name || '').toUpperCase();
  if (!u.trim()) return true;
  if (u.includes('YES')) return true;
  if (nameLooksNational(u)) return true;
  if (OPP_RSN.some((k) => u.includes(k))) return true;
  return false;
};

const etParts = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const problems = [];
const note = (title, body) => problems.push({ title, body });

// ---- 1. unknown broadcasters ----
async function checkBroadcasters() {
  const now = new Date();
  const start = etParts(new Date(now.getTime() - 7 * 864e5));
  const end = etParts(new Date(now.getTime() + 30 * 864e5));
  const url = `https://statsapi.mlb.com/api/v1/schedule?teamId=${YANKEES_ID}&sportId=1&startDate=${start}&endDate=${end}&hydrate=broadcasts`;

  let data;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'whatchannelaretheyankeeson.com health check' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    // One failed call is normal (flaky API). The snapshot bot already
    // tolerates it; don't open an issue over a single blip.
    console.log(`[health] schedule fetch failed, skipping broadcaster check: ${err.message}`);
    return;
  }

  const unknown = new Map(); // NAME -> sample context
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      for (const b of (g.broadcasts || []).filter(isTvEntry)) {
        const name = (b.name || '').trim();
        if (isRecognized(name) || unknown.has(name.toUpperCase())) continue;
        unknown.set(name.toUpperCase(), {
          name,
          type: b.type || '(none)',
          homeAway: b.homeAway || '(none)',
          gamePk: g.gamePk,
          date: g.gameDate,
        });
      }
    }
  }

  for (const info of unknown.values()) {
    note(
      `Unknown broadcaster: ${info.name}`,
      [
        `The MLB feed returned a TV broadcaster the channel classifier does not recognize.`,
        ``,
        `| field | value |`,
        `|---|---|`,
        `| name | \`${info.name}\` |`,
        `| type | \`${info.type}\` |`,
        `| homeAway | \`${info.homeAway}\` |`,
        `| gamePk | ${info.gamePk} |`,
        `| gameDate | ${info.date} |`,
        ``,
        `It is currently falling through to the generic path, so the site may show it as the Yankees channel when it is actually an opponent RSN, or miss that it blacks out YES.`,
        ``,
        `**Fix:** add it to \`OPP_RSN\` (opponent regional network) or \`NATIONAL_NAME_HINTS\` (national carrier) in **both** \`index.html\` and \`scripts/update-snapshot.mjs\`. They must stay in lockstep.`,
      ].join('\n')
    );
  }
}

// ---- 2 & 3. markers and JSON-LD ----
async function checkIndex() {
  let src;
  try {
    src = await readFile(INDEX_URL, 'utf8');
  } catch (err) {
    note('Health check cannot read index.html', `\`${err.message}\``);
    return;
  }

  const markers = [
    '<!-- SNAPSHOT:START — auto-generated daily by scripts/update-snapshot.mjs; do not hand-edit -->',
    '<!-- SNAPSHOT:END -->',
    'id="next-game-schema"',
    'id="last-updated"',
  ];
  const missing = markers.filter((m) => !src.includes(m));
  if (missing.length) {
    note(
      'Snapshot markers missing from index.html',
      [
        `The snapshot bot rewrites index.html by locating exact marker strings. These are no longer present:`,
        ``,
        ...missing.map((m) => `- \`${m}\``),
        ``,
        `Until this is fixed the baked SEO answer will stop updating **silently** — the Action keeps running and reports success.`,
      ].join('\n')
    );
  }

  const blocks = [...src.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)];
  blocks.forEach((m, i) => {
    try {
      JSON.parse(m[1]);
    } catch (err) {
      note(
        `Invalid JSON-LD in index.html (block ${i + 1})`,
        `Structured-data block ${i + 1} does not parse, so search engines will drop it.\n\n\`\`\`\n${err.message}\n\`\`\``
      );
    }
  });
  if (!blocks.length) note('No JSON-LD found in index.html', 'All structured data appears to have been removed.');
}

// ---- 4. classifier lockstep ----
async function checkLockstep() {
  let html, mjs;
  try {
    html = await readFile(INDEX_URL, 'utf8');
    mjs = await readFile(SNAPSHOT_URL, 'utf8');
  } catch (err) {
    note('Health check cannot read source files', `\`${err.message}\``);
    return;
  }

  const grab = (src, name) => {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\[[^\\]]*\\])`));
    return m ? m[1].replace(/\s+/g, '') : null;
  };

  for (const name of ['OPP_RSN', 'NATIONAL_NAME_HINTS']) {
    const a = grab(html, name);
    const b = grab(mjs, name);
    if (a === null || b === null) {
      note(
        `Cannot find ${name} in both files`,
        `The lockstep check could not locate \`${name}\` in ${a === null ? '`index.html`' : '`scripts/update-snapshot.mjs`'}. Either it was renamed or the check needs updating.`
      );
      continue;
    }
    if (a !== b) {
      note(
        `Classifier out of lockstep: ${name}`,
        [
          `\`${name}\` differs between the page and the snapshot bot. The site and the baked SEO answer will disagree about what channel a game is on.`,
          ``,
          `**index.html**`,
          '```js',
          a,
          '```',
          ``,
          `**scripts/update-snapshot.mjs**`,
          '```js',
          b,
          '```',
        ].join('\n')
      );
    }
  }
}

// ---- issue reporting ----
async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': 'wcatyo-health-check',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function report() {
  if (!problems.length) {
    console.log('[health] all checks passed');
    return;
  }

  for (const p of problems) console.log(`[health] PROBLEM: ${p.title}`);

  if (!TOKEN) {
    console.log('[health] no GITHUB_TOKEN — printing only, not opening issues');
    for (const p of problems) console.log(`\n--- ${p.title} ---\n${p.body}`);
    return;
  }

  let open = [];
  try {
    open = await gh(`repos/${REPO}/issues?state=open&per_page=100&labels=site-health`);
  } catch (err) {
    console.error(`[health] could not list issues: ${err.message}`);
  }
  const existing = new Set(open.map((i) => i.title));

  for (const p of problems) {
    if (existing.has(p.title)) {
      console.log(`[health] already reported, skipping: ${p.title}`);
      continue;
    }
    try {
      const issue = await gh(`repos/${REPO}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: p.title, body: p.body, labels: ['site-health'] }),
      });
      console.log(`[health] opened #${issue.number}: ${p.title}`);
    } catch (err) {
      console.error(`[health] could not open issue "${p.title}": ${err.message}`);
    }
  }
}

async function main() {
  await checkIndex();
  await checkLockstep();
  await checkBroadcasters();
  await report();
}

// Always exit 0 — a watchdog must never be the thing that breaks the build.
main().catch((e) => console.error('[health] unexpected error (non-fatal):', e));
