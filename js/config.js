/**
 * Central configuration. Everything tunable lives here.
 */

export const API_BASE = 'https://statsapi.mlb.com/api/v1';

/** MLB "sportId" for the major leagues. */
export const SPORT_ID = 1;

/**
 * Rotation cycle length per team id. The rotation advances one slot per
 * team *game* (not per calendar day), so off-days, doubleheaders and
 * postponements are handled by the schedule itself.
 *
 * Every club runs a five-man rotation except the Dodgers, who use six.
 * When a club shifts to a six-man, add its id here.
 */
export const DEFAULT_ROTATION_SIZE = 5;
export const ROTATION_SIZE_BY_TEAM = {
  119: 6, // Los Angeles Dodgers
};

export function rotationSizeFor(teamId) {
  return ROTATION_SIZE_BY_TEAM[teamId] ?? DEFAULT_ROTATION_SIZE;
}

/** Days of completed games used to infer each rotation's order. */
export const LOOKBACK_DAYS = 21;

/**
 * A pitcher needs this many starts inside the lookback window to earn a
 * rotation slot. Keeps openers and one-off spot starters out of the cycle.
 * Relaxed automatically if a club has too few qualifying starters.
 */
export const MIN_STARTS_FOR_SLOT = 2;

/**
 * Projected starts within this many turns through the rotation are shown as
 * "near" confidence; anything further out is "far".
 */
export const NEAR_CONFIDENCE_TURNS = 2;

/** Roster statuses that mean a pitcher is unavailable. */
export const INJURED_STATUS_RE = /injur|disabled|restricted|suspend|bereavement|paternity/i;

/** Path to the snapshot committed by the scheduled GitHub Action. */
export const SNAPSHOT_URL = 'data/snapshot.json';

/** localStorage key for the user's saved pitcher list. */
export const STORAGE_KEY = 'probables-grid:my-pitchers';
