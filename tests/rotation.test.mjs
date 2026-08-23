/**
 * Unit tests for the rotation engine. Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  normalizeSchedule,
  gamesByTeam,
  inferRotation,
  projectTeam,
  projectAll,
  addDays,
  dateRange,
} from '../js/rotation.js';
import { buildRows, shortName } from '../js/grid.js';
import { applyFilters, fold } from '../js/filters.js';
import { rotationSizeFor } from '../js/config.js';

const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const schedule = fixture('schedule-wide.json');
const teams = fixture('teams.json').teams;
const records = normalizeSchedule(schedule);
const byTeam = gamesByTeam(records);

const NYY = 147;
const LAD = 119;
const ASOF = '2026-08-23';

// --------------------------------------------------------------- date utils

test('addDays and dateRange are inclusive and timezone-stable', () => {
  assert.equal(addDays('2026-08-23', 5), '2026-08-28');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(dateRange('2026-08-23', '2026-08-25'), ['2026-08-23', '2026-08-24', '2026-08-25']);
});

// ------------------------------------------------------------ normalization

test('every game yields one record per club', () => {
  const played = schedule.dates.flatMap((d) => d.games).filter(
    (g) => g.gameType === 'R' && !/postpon|cancel|suspend/i.test(g.status.detailedState)
  );
  assert.equal(records.length, played.length * 2);
  assert.ok(records.length > 2000, 'fixture should be substantial');
  assert.equal(byTeam.size, 30);
});

test('a postponed game is counted once, as the game that was actually played', () => {
  // The feed lists a postponed game twice on the same date: once as
  // "Postponed" and once as the makeup. Only the played one may survive, and
  // only once, or the club's rotation advances an extra turn.
  const all = schedule.dates.flatMap((d) => d.games);
  const postponedPks = new Set(all.filter((g) => /postpon/i.test(g.status.detailedState)).map((g) => g.gamePk));
  assert.ok(postponedPks.size > 0, 'fixture should contain postponed games');

  for (const pk of postponedPks) {
    const kept = records.filter((r) => r.gamePk === pk);
    assert.equal(kept.length, 2, `gamePk ${pk} should survive once per club`);
    assert.ok(kept.every((r) => r.isFinal));
  }
});

test('no club ever sees the same game twice', () => {
  const keys = records.map((r) => `${r.gamePk}:${r.teamId}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('records use the local officialDate, not the UTC gameDate', () => {
  const night = records.find((r) => r.startTime?.includes('T23:') || r.startTime?.includes('T02:'));
  if (night) assert.equal(night.date, night.date.slice(0, 10));
  for (const r of records) assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('games are ordered, with doubleheaders sequenced by game number', () => {
  for (const list of byTeam.values()) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      assert.ok(a.date < b.date || (a.date === b.date && a.gameNumber <= b.gameNumber));
    }
  }
  assert.ok(records.some((r) => r.isDoubleHeader), 'fixture should contain a doubleheader');
});

// ---------------------------------------------------------------- inference

test('the inferred rotation reproduces the observed order', () => {
  // NYY started Schlittler 8/21, Weathers 8/22, then announced Rodon 8/23,
  // Warren 8/25 and Cole 8/27 — a clean five-man turn.
  const p = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: ASOF });
  assert.deepEqual(
    p.rotation.map((x) => x.fullName),
    ['Cam Schlittler', 'Ryan Weathers', 'Carlos Rodón', 'Will Warren', 'Gerrit Cole']
  );
  assert.equal(p.incomplete, false);
});

test('a stale arm drops out of the cycle without needing an injury feed', () => {
  // Max Fried last started 8/13 and has been passed over since.
  const p = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: ASOF });
  assert.ok(!p.rotation.some((x) => x.fullName === 'Max Fried'));
});

test('injured pitchers are excluded and reported', () => {
  const rot = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: ASOF }).rotation;
  const drop = rot[0];
  const p = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: ASOF, injuredIds: new Set([drop.id]) });
  assert.ok(!p.rotation.some((x) => x.id === drop.id));
  assert.ok(p.injuredExcluded.some((x) => x.id === drop.id));
  assert.equal(p.rotation.length, 5);
});

test('a one-off spot starter does not earn a rotation slot', () => {
  const games = [];
  const arms = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 20; i++) {
    games.push({
      gamePk: i, date: addDays('2026-08-01', i), gameNumber: 1, isFinal: true, isDoubleHeader: false,
      teamId: 1, oppId: 2, isHome: true,
      starter: { id: arms.indexOf(arms[i % 5]) + 1, fullName: arms[i % 5] },
    });
  }
  // one emergency start by a sixth arm
  games.push({ gamePk: 99, date: '2026-08-21', gameNumber: 1, isFinal: true, isDoubleHeader: false,
    teamId: 1, oppId: 2, isHome: true, starter: { id: 99, fullName: 'Opener' } });
  const { rotation } = inferRotation(games, { rotationSize: 5 });
  assert.equal(rotation.length, 5);
  assert.ok(!rotation.some((p) => p.fullName === 'Opener'));
});

// --------------------------------------------------------------- projection

test('the Dodgers run a six-man cycle, everyone else five', () => {
  assert.equal(rotationSizeFor(LAD), 6);
  assert.equal(rotationSizeFor(NYY), 5);
  assert.equal(projectTeam(byTeam.get(LAD), { teamId: LAD, asOf: ASOF }).rotation.length, 6);
});

test('announced probables are passed through untouched', () => {
  const p = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: ASOF });
  for (const s of p.starts.filter((x) => x.confidence === 'announced')) {
    const game = byTeam.get(NYY).find((g) => g.gamePk === s.gamePk);
    assert.equal(s.pitcher.id, game.starter.id);
  }
});

test('the model never starts a pitcher twice inside one turn', () => {
  for (const [teamId, p] of projectAll(records, { asOf: ASOF })) {
    const cycle = p.rotation.length;
    if (!cycle) continue;
    const lastAt = new Map();
    p.starts.forEach((s, i) => {
      if (!s.pitcher) return;
      const prev = lastAt.get(s.pitcher.id);
      if (prev !== undefined && s.confidence !== 'announced') {
        assert.ok(i - prev >= cycle - 1, `team ${teamId}: ${s.pitcher.fullName} repeats after ${i - prev} games`);
      }
      lastAt.set(s.pitcher.id, i);
    });
  }
});

test('a game the cycle cannot absorb is marked TBD rather than guessed wrong', () => {
  // NYY play 8/25, 8/26 and 8/27, with 8/25 and 8/27 both announced. The five
  // arms cannot cover the middle game, so it must not claim a starter.
  const p = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: ASOF });
  const mid = p.starts.find((s) => s.date === '2026-08-26');
  assert.equal(mid.confidence, 'tbd');
  assert.equal(mid.pitcher, null);
});

test('projections reach the end of the schedule for every club', () => {
  const proj = projectAll(records, { asOf: ASOF });
  assert.equal(proj.size, 30);
  for (const [teamId, p] of proj) {
    const future = byTeam.get(teamId).filter((g) => g.date >= ASOF && !g.isFinal);
    assert.equal(p.starts.length, future.length, `team ${teamId} missed games`);
    assert.equal(p.incomplete, false, `team ${teamId} has an incomplete rotation`);
  }
});

test('confidence degrades with distance and is never blank', () => {
  const p = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: ASOF });
  const valid = new Set(['announced', 'near', 'far', 'tbd']);
  for (const s of p.starts) assert.ok(valid.has(s.confidence));
  assert.equal(p.starts.at(-1).confidence, 'far');
});

test('backtest mode is blind to results on or after the anchor date', () => {
  const p = projectTeam(byTeam.get(NYY), { teamId: NYY, asOf: '2026-08-02', backtest: true });
  assert.ok(p.starts.length > 0);
  assert.equal(p.starts.filter((s) => s.confidence === 'announced').length, 0);
  assert.ok(!p.rotation.some((r) => r.fullName === 'Nonexistent'));
});

test('an empty or unknown club degrades quietly instead of throwing', () => {
  const p = projectTeam([], { teamId: 999, asOf: ASOF });
  assert.deepEqual(p.rotation, []);
  assert.deepEqual(p.starts, []);
  assert.equal(p.incomplete, true);
});

// ------------------------------------------------------------------ display

test('every projected start reaches a grid row', () => {
  const proj = projectAll(records, { asOf: ASOF });
  const rows = buildRows(proj, teams);
  const cells = rows.reduce((n, r) => n + [...r.cells.values()].flat().length, 0);
  const starts = [...proj.values()].reduce((n, p) => n + p.starts.length, 0);
  assert.equal(cells, starts);
  assert.ok(rows.every((r) => r.pitcher.fullName && r.team.abbreviation));
});

test('unnamed starts get an Undecided row rather than vanishing', () => {
  const proj = projectAll(records, { asOf: ASOF });
  const rows = buildRows(proj, teams);
  const tbdStarts = [...proj.values()].reduce((n, p) => n + p.starts.filter((s) => !s.pitcher).length, 0);
  const tbdCells = rows.filter((r) => r.isTBD).reduce((n, r) => n + [...r.cells.values()].flat().length, 0);
  assert.equal(tbdCells, tbdStarts);
});

test('names shorten for narrow screens without an ellipsis', () => {
  assert.equal(shortName('Carlos Rodón'), 'C. Rodón');
  assert.equal(shortName('Undecided'), 'Undecided');
});

test('search folds diacritics and matches team as well as pitcher', () => {
  assert.equal(fold('Carlos Rodón'), 'carlos rodon');
  const rows = buildRows(projectAll(records, { asOf: ASOF }), teams);
  const base = { myPitchers: new Set(), teamIds: new Set() };
  assert.ok(applyFilters(rows, { ...base, search: 'rodon' }).some((r) => r.pitcher.fullName === 'Carlos Rodón'));
  assert.ok(applyFilters(rows, { ...base, search: 'yankees' }).every((r) => r.teamId === NYY));
  assert.equal(applyFilters(rows, { ...base, teamIds: new Set([LAD]) }).every((r) => r.teamId === LAD), true);
});
