/**
 * Backtest: anchor the model at a past date, project forward blind, and score
 * it against what actually happened. Reported by horizon, because accuracy
 * decays the further out the projection reaches.
 *
 * Usage: node tests/backtest.mjs [asOf] [fixture]
 */
import fs from 'node:fs';
import { normalizeSchedule, gamesByTeam, projectAll } from '../js/rotation.js';

const asOf = process.argv[2] ?? '2026-08-02';
const fixture = process.argv[3] ?? new URL('./fixtures/schedule-wide.json', import.meta.url).pathname;

const records = normalizeSchedule(JSON.parse(fs.readFileSync(fixture, 'utf8')));

// Ground truth: who actually started each completed game.
const actual = new Map();
for (const g of records) {
  if (g.isFinal && g.starter) actual.set(`${g.gamePk}:${g.teamId}`, g.starter);
}

const proj = projectAll(records, { asOf, backtest: true, useAnnounced: false });

const buckets = [
  ['days 1-7', 1, 7],
  ['days 8-14', 8, 14],
  ['days 15-21', 15, 21],
];
const tally = new Map(buckets.map(([label]) => [label, { hit: 0, miss: 0, tbd: 0 }]));

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

for (const p of proj.values()) {
  for (const s of p.starts) {
    const truth = actual.get(`${s.gamePk}:${s.teamId}`);
    if (!truth) continue; // game not yet played -> nothing to score against
    const d = dayDiff(s.date, asOf) + 1;
    const bucket = buckets.find(([, lo, hi]) => d >= lo && d <= hi);
    if (!bucket) continue;
    const t = tally.get(bucket[0]);
    if (!s.pitcher) t.tbd++;
    else if (s.pitcher.id === truth.id) t.hit++;
    else t.miss++;
  }
}

console.log(`Backtest anchored ${asOf} (model blind to everything from that date on)\n`);
console.log('horizon      scored   correct   accuracy   tbd');
let H = 0, M = 0;
for (const [label] of buckets) {
  const { hit, miss, tbd } = tally.get(label);
  const n = hit + miss;
  H += hit; M += miss;
  const pct = n ? ((100 * hit) / n).toFixed(1) + '%' : '—';
  console.log(`${label.padEnd(12)} ${String(n).padEnd(8)} ${String(hit).padEnd(9)} ${pct.padEnd(10)} ${tbd}`);
}
const tot = H + M;
console.log(`\noverall      ${tot}      ${H}       ${tot ? ((100 * H) / tot).toFixed(1) + '%' : '—'}`);

// A naive baseline: how often does *any* fixed guess do this well? Compare to
// picking uniformly at random from a 5-man staff.
console.log(`random-guess baseline for a 5-man rotation: 20.0%`);
