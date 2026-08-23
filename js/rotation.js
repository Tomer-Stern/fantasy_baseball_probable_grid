/**
 * Rotation inference and forward projection.
 *
 * The published probables feeds only announce ~10 days out. To see further we
 * infer each club's rotation order from the starters of *completed* games, then
 * walk that cycle forward across the remaining schedule.
 *
 * The cycle advances one slot per team **game**, not per calendar day. That is
 * the same thing as "a starter every five days" during a normal week, but it
 * stays correct through off-days, doubleheaders and postponements, because the
 * schedule supplies the dates.
 *
 * Pure functions only — no DOM, no network. Unit-testable under Node.
 */

import {
  rotationSizeFor,
  LOOKBACK_DAYS,
  MIN_STARTS_FOR_SLOT,
  NEAR_CONFIDENCE_TURNS,
} from './config.js';

/** Games in these states never happened and are replayed under a new gamePk. */
const VOID_STATE_RE = /postpon|cancel|suspend/i;

// ---------------------------------------------------------------- date utils

/** Parse a YYYY-MM-DD date as UTC noon, avoiding local-timezone drift. */
export function parseDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd, days) {
  const d = parseDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

/** Inclusive list of YYYY-MM-DD strings from start to end. */
export function dateRange(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// ------------------------------------------------------------ normalization

/**
 * Flatten a StatsAPI schedule payload into one record per team per game.
 * Each game yields two records, one from each club's point of view.
 */
export function normalizeSchedule(schedule) {
  // Keyed by game + club. The feed lists a postponed game twice on the same
  // date, once as "Postponed" and once as the makeup; a duplicate that slipped
  // through would advance the rotation an extra turn for that club.
  const seen = new Map();
  const out = [];
  for (const day of schedule?.dates ?? []) {
    for (const game of day.games ?? []) {
      if (game.gameType !== 'R') continue; // regular season only

      const detailed = game.status?.detailedState ?? '';
      if (VOID_STATE_RE.test(detailed)) continue; // never played

      // "Final" also covers weather-shortened games ("Completed Early").
      const isFinal = game.status?.abstractGameState === 'Final';

      for (const side of ['away', 'home']) {
        const me = game.teams?.[side];
        const opp = game.teams?.[side === 'away' ? 'home' : 'away'];
        if (!me?.team || !opp?.team) continue;

        const key = `${game.gamePk}:${me.team.id}`;
        const priorIdx = seen.get(key);
        const prior = priorIdx === undefined ? null : out[priorIdx];
        // On a collision keep the entry that actually carries information.
        if (prior && (prior.isFinal || prior.starter || !(isFinal || me.probablePitcher))) continue;

        const record = {
          gamePk: game.gamePk,
          // officialDate is the local calendar date. gameDate is UTC and would
          // push night games onto the following day.
          date: game.officialDate ?? (game.gameDate ?? '').slice(0, 10),
          startTime: game.gameDate,
          teamId: me.team.id,
          teamName: me.team.name,
          oppId: opp.team.id,
          oppName: opp.team.name,
          isHome: side === 'home',
          gameNumber: game.gameNumber ?? 1,
          isDoubleHeader: (game.doubleHeader ?? 'N') !== 'N',
          isFinal,
          starter: me.probablePitcher
            ? { id: me.probablePitcher.id, fullName: me.probablePitcher.fullName }
            : null,
        };

        if (prior) {
          out[priorIdx] = record;
        } else {
          seen.set(key, out.length);
          out.push(record);
        }
      }
    }
  }
  return out;
}

/** Group normalized records by team, each list in chronological order. */
export function gamesByTeam(records) {
  const byTeam = new Map();
  for (const r of records) {
    if (!byTeam.has(r.teamId)) byTeam.set(r.teamId, []);
    byTeam.get(r.teamId).push(r);
  }
  for (const list of byTeam.values()) {
    list.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.gameNumber - b.gameNumber ||
        String(a.startTime).localeCompare(String(b.startTime))
    );
  }
  return byTeam;
}

// -------------------------------------------------------------- inference

/** Modulo that returns a non-negative result for negative operands. */
function mod(n, m) {
  return ((n % m) + m) % m;
}

/**
 * The starts we treat as fact: completed games, plus probables the club has
 * already announced. Announcements matter for inference, not just display —
 * they are the freshest evidence of who is actually in the rotation right now,
 * and they reveal arms that recent history alone would miss.
 */
export function knownStarts(teamGames, { asOf, useAnnounced = true } = {}) {
  return teamGames.filter(
    (g) => g.starter && (g.isFinal ? g.date < asOf : useAnnounced && g.date >= asOf)
  );
}

/**
 * Infer a club's rotation order from its known starts.
 *
 * Collecting the most recent N *distinct* starters and reversing them yields
 * the cycle in turn order: whoever pitched longest ago is next up. Given
 * A,B,C,D,E,A,B,C the distinct-by-last-appearance order is D,E,A,B,C, so C
 * (most recent) sits in the final slot and D is on deck.
 *
 * Working from the tail also drops stale arms for free: a starter who has not
 * taken a turn lately falls out of the window without needing an IL feed.
 */
export function inferRotation(known, { rotationSize, injuredIds = new Set(), minStarts = MIN_STARTS_FOR_SLOT } = {}) {
  const counts = new Map();
  for (const g of known) counts.set(g.starter.id, (counts.get(g.starter.id) ?? 0) + 1);

  // Repeat appearances filter out openers and one-off fill-ins. If that leaves
  // too few arms to fill the cycle, fall back to counting single starts.
  const eligible = (id, floor) => (counts.get(id) ?? 0) >= floor && !injuredIds.has(id);
  const distinctAt = (f) => new Set(known.filter((g) => eligible(g.starter.id, f)).map((g) => g.starter.id)).size;

  let floor = minStarts;
  let relaxed = false;
  if (distinctAt(floor) < rotationSize && distinctAt(1) > distinctAt(floor)) {
    floor = 1;
    relaxed = true;
  }

  const rotation = [];
  const seen = new Set();
  const injuredExcluded = [];
  const injuredSeen = new Set();

  for (let i = known.length - 1; i >= 0 && rotation.length < rotationSize; i--) {
    const p = known[i].starter;
    if (seen.has(p.id)) continue;
    if (injuredIds.has(p.id)) {
      if (!injuredSeen.has(p.id)) {
        injuredSeen.add(p.id);
        injuredExcluded.push(p);
      }
      continue;
    }
    if ((counts.get(p.id) ?? 0) < floor) continue;
    seen.add(p.id);
    rotation.push(p); // collected newest-first
  }

  rotation.reverse(); // -> cycle order, most recent starter last
  return { rotation, injuredExcluded, relaxed };
}

// ------------------------------------------------------------- projection

/**
 * Project a club's remaining starters.
 *
 * Announced probables are treated as fixed points rather than mere overrides.
 * Each unannounced game takes its slot from the *nearest* announcement, which
 * means gaps sitting before an announcement are filled by counting backwards
 * from it. Filling such a gap forwards instead would routinely contradict the
 * club's own announcement two days later.
 *
 * @param {object[]} teamGames        chronological games for one club
 * @param {string}   opts.asOf        games before this date count as history
 * @param {boolean}  opts.useAnnounced honour announced probables. Set false to
 *                                     backtest the model on its own.
 */
export function projectTeam(teamGames, { teamId, asOf, useAnnounced = true, backtest = false, injuredIds = new Set(), lookbackDays = LOOKBACK_DAYS } = {}) {
  const rotationSize = rotationSizeFor(teamId);
  const windowStart = addDays(asOf, -lookbackDays);

  const known = knownStarts(teamGames, { asOf, useAnnounced }).filter((g) => g.date >= windowStart);
  const { rotation, injuredExcluded, relaxed } = inferRotation(known, { rotationSize, injuredIds });

  const result = {
    teamId,
    rotation,
    rotationSize,
    injuredExcluded,
    relaxed,
    starts: [],
    incomplete: rotation.length < rotationSize,
  };
  if (rotation.length === 0) return result;

  const cycle = rotation.length; // may run short if a club has few known arms
  const slotOfPitcher = new Map(rotation.map((p, i) => [p.id, i]));

  // Anchors: games whose starter is known *and* sits in the cycle. Their game
  // index plus slot pins the phase of the rotation.
  const anchors = [];
  teamGames.forEach((g, i) => {
    if (!g.starter) return;
    const isHistory = g.isFinal && g.date < asOf;
    const isAnnounced = useAnnounced && g.date >= asOf && !g.isFinal;
    if (!isHistory && !isAnnounced) return;
    const slot = slotOfPitcher.get(g.starter.id);
    if (slot !== undefined) anchors.push({ index: i, slot });
  });

  if (anchors.length === 0) return result;

  const lastAnnouncedIdx = teamGames.reduce(
    (acc, g, i) => (useAnnounced && g.date >= asOf && !g.isFinal && g.starter ? i : acc),
    -1
  );

  const nearestAnchor = (i) => {
    let best = anchors[0];
    let bestDist = Infinity;
    for (const a of anchors) {
      const dist = Math.abs(a.index - i);
      // Ties go to the later anchor: an upcoming announcement is a harder
      // constraint than a game already in the books.
      if (dist < bestDist || (dist === bestDist && a.index > best.index)) {
        best = a;
        bestDist = dist;
      }
    }
    return best;
  };

  for (let i = 0; i < teamGames.length; i++) {
    const g = teamGames[i];
    if (g.date < asOf) continue; // already accounted for as history

    // A start that is already fact — announced by the club, or pitched in a
    // game now final — is reported as-is. Backtesting suppresses this so the
    // model is scored without seeing the answers.
    if (!backtest && g.starter && (useAnnounced || g.isFinal)) {
      result.starts.push({ ...g, pitcher: g.starter, confidence: 'announced' });
      continue;
    }

    const anchor = nearestAnchor(i);
    const pitcher = rotation[mod(anchor.slot + (i - anchor.index), cycle)];
    const turnsOut = Math.floor(Math.max(0, i - lastAnnouncedIdx - 1) / cycle);
    result.starts.push({
      ...g,
      pitcher,
      confidence: turnsOut < NEAR_CONFIDENCE_TURNS ? 'near' : 'far',
    });
  }

  flagImpossibleRepeats(result.starts, cycle);
  return result;
}

/**
 * A club cannot start the same pitcher twice inside one turn of the rotation.
 * Where the schedule holds more games than the cycle can absorb — a
 * doubleheader, or a gap an announcement pins on both sides — some game is
 * covered by a spot starter nobody has named yet. Rather than print a start we
 * know to be impossible, demote it to TBD. Announced starts are never demoted:
 * the club's own word outranks the model.
 */
function flagImpossibleRepeats(starts, cycle) {
  const lastSeenAt = new Map();
  starts.forEach((s, i) => {
    if (!s.pitcher) return;
    const prev = lastSeenAt.get(s.pitcher.id);
    if (prev !== undefined && i - prev < cycle - 1 && s.confidence !== 'announced') {
      s.pitcher = null;
      s.confidence = 'tbd';
      return;
    }
    lastSeenAt.set(s.pitcher.id, i);
  });
}

/** Project every club. Returns Map teamId -> projection. */
export function projectAll(records, { asOf, useAnnounced = true, backtest = false, injuredIdsByTeam = new Map() } = {}) {
  const byTeam = gamesByTeam(records);
  const out = new Map();
  for (const [teamId, teamGames] of byTeam) {
    out.set(
      teamId,
      projectTeam(teamGames, {
        teamId,
        asOf,
        useAnnounced,
        backtest,
        injuredIds: injuredIdsByTeam.get(teamId) ?? new Set(),
      })
    );
  }
  return out;
}
