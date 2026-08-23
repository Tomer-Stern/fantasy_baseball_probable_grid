/**
 * MLB StatsAPI client.
 *
 * statsapi.mlb.com sends `Access-Control-Allow-Origin: *`, so the browser can
 * call it directly and this stays a static site with no backend. If the live
 * call fails we fall back to the snapshot the scheduled Action commits.
 */

import { API_BASE, SPORT_ID, LOOKBACK_DAYS, INJURED_STATUS_RE, SNAPSHOT_URL } from './config.js';
import { addDays } from './rotation.js';

/** Today in the viewer's own timezone, as YYYY-MM-DD. */
export function today() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

async function getJSON(url, { cacheBust = false } = {}) {
  const u = new URL(url);
  if (cacheBust) u.searchParams.set('_', Date.now().toString(36));
  const res = await fetch(u, { cache: cacheBust ? 'reload' : 'default' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${u.pathname}`);
  return res.json();
}

export async function fetchSeason(year, opts) {
  const data = await getJSON(`${API_BASE}/seasons/${year}?sportId=${SPORT_ID}`, opts);
  return data?.seasons?.[0] ?? null;
}

export async function fetchTeams(opts) {
  const data = await getJSON(`${API_BASE}/teams?sportId=${SPORT_ID}`, opts);
  return (data.teams ?? [])
    .map((t) => ({
      id: t.id,
      name: t.name,
      teamName: t.teamName,
      abbreviation: t.abbreviation,
      division: t.division?.name ?? '',
      league: t.league?.name ?? '',
    }))
    .sort((a, b) => a.abbreviation.localeCompare(b.abbreviation));
}

export async function fetchSchedule(startDate, endDate, opts) {
  return getJSON(
    `${API_BASE}/schedule?sportId=${SPORT_ID}&startDate=${startDate}&endDate=${endDate}&hydrate=probablePitcher`,
    opts
  );
}

/**
 * Which pitchers are unavailable, per club.
 * Bulk roster hydration is not supported, so this is 30 small parallel calls.
 * A club whose roster fails to load simply contributes no exclusions.
 */
export async function fetchInjured(teams, opts) {
  const byTeam = new Map();
  await Promise.all(
    teams.map(async (t) => {
      try {
        const data = await getJSON(`${API_BASE}/teams/${t.id}/roster?rosterType=40Man`, opts);
        const out = new Set();
        for (const r of data.roster ?? []) {
          if (INJURED_STATUS_RE.test(r.status?.description ?? '')) out.add(r.person.id);
        }
        byTeam.set(t.id, out);
      } catch {
        byTeam.set(t.id, new Set());
      }
    })
  );
  return byTeam;
}

/**
 * Everything the grid needs, in one call.
 * Returns { teams, schedule, injuredIdsByTeam, asOf, seasonEnd, source, fetchedAt }.
 */
export async function loadAll({ cacheBust = false } = {}) {
  const asOf = today();
  const year = Number(asOf.slice(0, 4));

  try {
    const [season, teams] = await Promise.all([
      fetchSeason(year, { cacheBust }),
      fetchTeams({ cacheBust }),
    ]);

    const seasonEnd = season?.regularSeasonEndDate ?? `${year}-10-01`;
    const start = addDays(asOf, -LOOKBACK_DAYS);

    // Nothing left to project once the regular season is over.
    const end = seasonEnd < asOf ? asOf : seasonEnd;

    const [schedule, injuredIdsByTeam] = await Promise.all([
      fetchSchedule(start, end, { cacheBust }),
      fetchInjured(teams, { cacheBust }),
    ]);

    return {
      teams,
      schedule,
      injuredIdsByTeam,
      asOf,
      seasonEnd,
      source: 'live',
      fetchedAt: new Date().toISOString(),
    };
  } catch (liveError) {
    const snap = await loadSnapshot().catch(() => null);
    if (!snap) throw liveError;
    return { ...snap, source: 'snapshot', liveError: liveError.message };
  }
}

/** The pre-baked fallback committed by .github/workflows/snapshot.yml. */
export async function loadSnapshot() {
  const snap = await getJSON(new URL(SNAPSHOT_URL, location.href).href, { cacheBust: true });
  return {
    teams: snap.teams,
    schedule: snap.schedule,
    injuredIdsByTeam: new Map(
      Object.entries(snap.injuredByTeam ?? {}).map(([k, v]) => [Number(k), new Set(v)])
    ),
    asOf: today(),
    seasonEnd: snap.seasonEnd,
    fetchedAt: snap.fetchedAt,
  };
}
