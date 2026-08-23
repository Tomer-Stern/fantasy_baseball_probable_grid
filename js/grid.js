/**
 * Grid rendering: pitchers down the side, dates across the top.
 */

import { dateRange, parseDate } from './rotation.js';

/** "Carlos Rodon" -> "C. Rodon". Used on narrow screens, where the full name
 *  would otherwise be clipped to an ellipsis. */
export function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Turn per-team projections into one row per pitcher.
 * Pitchers outside the inferred rotation still earn a row if a club has
 * announced them, so spot starters are not silently dropped.
 */
export function buildRows(projections, teams) {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const rows = [];

  for (const [teamId, proj] of projections) {
    const team = teamById.get(teamId);
    if (!team) continue;

    const byPitcher = new Map();
    const order = [];

    const ensure = (p) => {
      if (!p) return null;
      if (!byPitcher.has(p.id)) {
        byPitcher.set(p.id, { pitcher: p, cells: new Map() });
        order.push(p.id);
      }
      return byPitcher.get(p.id);
    };

    proj.rotation.forEach(ensure); // rotation arms first, in turn order
    for (const s of proj.starts) {
      const row = ensure(s.pitcher);
      if (!row) continue;
      if (!row.cells.has(s.date)) row.cells.set(s.date, []);
      row.cells.get(s.date).push(s);
    }

    const injured = new Set(proj.injuredExcluded.map((p) => p.id));
    for (const id of order) {
      const r = byPitcher.get(id);
      rows.push({
        teamId,
        team,
        pitcher: r.pitcher,
        cells: r.cells,
        starts: [...r.cells.values()].flat().length,
        inRotation: proj.rotation.some((p) => p.id === id),
        injured: injured.has(id),
      });
    }

    // Unnamed starts still need somewhere to live.
    const tbd = proj.starts.filter((s) => !s.pitcher);
    if (tbd.length) {
      const cells = new Map();
      for (const s of tbd) {
        if (!cells.has(s.date)) cells.set(s.date, []);
        cells.get(s.date).push(s);
      }
      rows.push({
        teamId,
        team,
        pitcher: { id: `tbd-${teamId}`, fullName: 'Undecided' },
        cells,
        starts: tbd.length,
        inRotation: false,
        isTBD: true,
      });
    }
  }

  rows.sort(
    (a, b) => a.team.abbreviation.localeCompare(b.team.abbreviation) || a.pitcher.fullName.localeCompare(b.pitcher.fullName)
  );
  return rows;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function headerCell(date, todayStr) {
  const d = parseDate(date);
  const isToday = date === todayStr;
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  return `<th class="date-col${isToday ? ' is-today' : ''}${weekend ? ' is-weekend' : ''}" scope="col">
    <span class="dow">${WEEKDAY[d.getUTCDay()]}</span>
    <span class="dom">${d.getUTCMonth() + 1}/${d.getUTCDate()}</span>
  </th>`;
}

function startCell(starts, teamById) {
  return starts
    .map((s) => {
      const opp = teamById.get(s.oppId);
      const abbr = opp ? opp.abbreviation : 'TBD';
      const dh = s.isDoubleHeader ? `<sup class="dh">${s.gameNumber}</sup>` : '';
      const label = s.isHome ? abbr : `@${abbr}`;
      const title = `${s.date} ${s.isHome ? 'vs' : 'at'} ${escapeHTML(opp?.name ?? '')} — ${
        { announced: 'announced by the club', near: 'projected', far: 'projected (long range)', tbd: 'not yet determined' }[s.confidence]
      }`;
      return `<span class="start c-${s.confidence}" title="${title}">${escapeHTML(label)}${dh}</span>`;
    })
    .join('');
}

/** Render the whole grid. Returns the number of visible rows. */
export function renderGrid(container, { rows, startDate, endDate, teams, today: todayStr, myPitchers = new Set() }) {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const dates = dateRange(startDate, endDate);

  if (!rows.length) {
    container.innerHTML = `<p class="empty">No pitchers match the current filters.</p>`;
    return 0;
  }

  const head = `<thead><tr>
      <th class="pitcher-col" scope="col">Pitcher</th>
      ${dates.map((d) => headerCell(d, todayStr)).join('')}
    </tr></thead>`;

  let prevTeam = null;
  const body = rows
    .map((r) => {
      const newTeam = r.team.id !== prevTeam;
      prevTeam = r.team.id;
      const flags = [
        r.injured ? '<span class="flag flag-il" title="Currently listed as injured">IL</span>' : '',
        !r.inRotation && !r.isTBD ? '<span class="flag flag-spot" title="Not part of the inferred rotation">spot</span>' : '',
      ].join('');

      const starred = myPitchers.has(r.pitcher.id);
      const star = r.isTBD
        ? ''
        : `<button class="star" type="button" data-pitcher-id="${escapeHTML(r.pitcher.id)}"
             aria-pressed="${starred}" aria-label="${starred ? 'Remove' : 'Add'} ${escapeHTML(r.pitcher.fullName)} ${starred ? 'from' : 'to'} my pitchers"
             title="${starred ? 'Remove from' : 'Add to'} my pitchers">${starred ? '\u2605' : '\u2606'}</button>`;

      const cells = dates
        .map((d) => {
          const starts = r.cells.get(d);
          const isToday = d === todayStr;
          if (!starts) return `<td class="${isToday ? 'is-today' : ''}"></td>`;
          return `<td class="has-start${isToday ? ' is-today' : ''}">${startCell(starts, teamById)}</td>`;
        })
        .join('');

      return `<tr class="${newTeam ? 'team-start' : ''}${r.isTBD ? ' row-tbd' : ''}">
        <th class="pitcher-col" scope="row">
          ${star}
          <span class="team-badge">${escapeHTML(r.team.abbreviation)}</span>
          <span class="pitcher-name">${escapeHTML(r.pitcher.fullName)}</span><span class="pitcher-short">${escapeHTML(shortName(r.pitcher.fullName))}</span>
          ${flags}
        </th>${cells}</tr>`;
    })
    .join('');

  container.innerHTML = `<table class="grid">${head}<tbody>${body}</tbody></table>`;
  return rows.length;
}
