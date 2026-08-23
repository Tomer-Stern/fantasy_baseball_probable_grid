/**
 * Wiring: load -> project -> render, plus the controls.
 */

import { loadAll, today } from './api.js';
import { normalizeSchedule, projectAll, addDays } from './rotation.js';
import { buildRows, renderGrid } from './grid.js';
import { applyFilters, loadMyPitchers, saveMyPitchers } from './filters.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  allRows: [],
  search: '',
  teamIds: new Set(),
  myOnly: false,
  myPitchers: loadMyPitchers(),
  hideEmpty: true,
};

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function formatStamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderTeamFilter(teams) {
  const box = $('#team-filter');
  box.innerHTML = teams
    .map(
      (t) => `<label class="team-chip">
        <input type="checkbox" value="${t.id}" ${state.teamIds.has(t.id) ? 'checked' : ''}>
        <span>${t.abbreviation}</span>
      </label>`
    )
    .join('');
}

function draw() {
  if (!state.data) return;
  const rows = applyFilters(state.allRows, state);
  renderGrid($('#grid-wrap'), {
    rows,
    startDate: state.data.asOf,
    endDate: state.data.endDate,
    teams: state.data.teams,
    today: today(),
    myPitchers: state.myPitchers,
  });

  const teamCount = new Set(rows.map((r) => r.teamId)).size;
  $('#counts').textContent = `${rows.length} pitcher${rows.length === 1 ? '' : 's'} · ${teamCount} team${teamCount === 1 ? '' : 's'}`;
}

function recompute() {
  const { schedule, teams, injuredIdsByTeam, asOf, seasonEnd } = state.data;
  const records = normalizeSchedule(schedule);
  const projections = projectAll(records, { asOf, injuredIdsByTeam });
  state.allRows = buildRows(projections, teams);

  // Never draw columns past the last scheduled game.
  const lastGame = records.reduce((m, r) => (r.date > m ? r.date : m), asOf);
  state.data.endDate = seasonEnd && seasonEnd < lastGame ? lastGame : seasonEnd || lastGame;
  if (state.data.endDate < asOf) state.data.endDate = addDays(asOf, 1);
}

async function refresh({ cacheBust = false } = {}) {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  setStatus('Loading schedule and probables…');

  try {
    state.data = await loadAll({ cacheBust });
    recompute();
    renderTeamFilter(state.data.teams);
    draw();

    const stamp = formatStamp(state.data.fetchedAt);
    if (state.data.source === 'snapshot') {
      setStatus(`Live feed unavailable — showing a saved copy from ${stamp}.`, 'warn');
    } else {
      setStatus(`Updated ${stamp} · projected through ${state.data.endDate}`, 'ok');
    }
  } catch (err) {
    setStatus(`Could not load data: ${err.message}`, 'error');
    $('#grid-wrap').innerHTML = `<p class="empty">Nothing to show. Check your connection and hit Refresh.</p>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function wire() {
  $('#refresh').addEventListener('click', () => refresh({ cacheBust: true }));

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.search = v;
      draw();
    }, 120);
  });

  $('#team-filter').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const id = Number(cb.value);
    if (cb.checked) state.teamIds.add(id);
    else state.teamIds.delete(id);
    draw();
  });

  $('#clear-teams').addEventListener('click', () => {
    state.teamIds.clear();
    renderTeamFilter(state.data?.teams ?? []);
    draw();
  });

  $('#my-only').addEventListener('change', (e) => {
    state.myOnly = e.target.checked;
    draw();
  });

  $('#hide-empty').addEventListener('change', (e) => {
    state.hideEmpty = e.target.checked;
    draw();
  });

  // Star toggles live inside the grid, which is re-rendered wholesale.
  $('#grid-wrap').addEventListener('click', (e) => {
    const btn = e.target.closest('.star');
    if (!btn) return;
    const id = Number(btn.dataset.pitcherId);
    if (state.myPitchers.has(id)) state.myPitchers.delete(id);
    else state.myPitchers.add(id);
    saveMyPitchers(state.myPitchers);
    draw();
  });
}

wire();
refresh();
