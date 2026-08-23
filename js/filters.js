/**
 * Filtering: name search, team selection, and a saved "my pitchers" list.
 */

import { STORAGE_KEY } from './config.js';

/** Diacritic-insensitive compare, so "rodon" finds "Rodón". */
export function fold(s) {
  return String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export function loadMyPitchers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function saveMyPitchers(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable (private browsing) — filtering still works in-session */
  }
}

/**
 * @param {object[]} rows      from buildRows
 * @param {object}   state     { search, teamIds:Set, myOnly:boolean, myPitchers:Set, hideEmpty:boolean }
 */
export function applyFilters(rows, state) {
  const q = fold(state.search ?? '');
  return rows.filter((r) => {
    if (state.myOnly && !state.myPitchers.has(r.pitcher.id)) return false;
    if (state.teamIds?.size && !state.teamIds.has(r.teamId)) return false;
    if (state.hideEmpty && r.starts === 0) return false;
    if (q && !fold(r.pitcher.fullName).includes(q) && !fold(r.team.abbreviation).includes(q) && !fold(r.team.name).includes(q)) {
      return false;
    }
    return true;
  });
}
