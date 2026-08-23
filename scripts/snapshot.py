#!/usr/bin/env python3
"""
Bake a fallback copy of everything the grid needs.

The page normally calls the MLB Stats API straight from the browser. This
script writes the same data to data/snapshot.json so the site still renders
when that call fails. Run on a schedule by .github/workflows/snapshot.yml.

Usage: python3 scripts/snapshot.py [--out data/snapshot.json]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://statsapi.mlb.com/api/v1"
SPORT_ID = 1
LOOKBACK_DAYS = 21
TIMEOUT = 30

INJURED_KEYWORDS = ("injur", "disabled", "restricted", "suspend", "bereavement", "paternity")


def get(path: str) -> dict:
    url = f"{API}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "probables-grid-snapshot/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.load(resp)


def slim_schedule(payload: dict) -> dict:
    """Keep only the fields js/rotation.js reads, to keep the file small."""
    dates = []
    for day in payload.get("dates", []):
        games = []
        for g in day.get("games", []):
            rec = {
                "gamePk": g["gamePk"],
                "officialDate": g.get("officialDate"),
                "gameDate": g.get("gameDate"),
                "gameType": g.get("gameType"),
                "doubleHeader": g.get("doubleHeader", "N"),
                "gameNumber": g.get("gameNumber", 1),
                "status": {
                    "abstractGameState": g.get("status", {}).get("abstractGameState"),
                    "detailedState": g.get("status", {}).get("detailedState"),
                    "codedGameState": g.get("status", {}).get("codedGameState"),
                },
                "teams": {},
            }
            for side in ("away", "home"):
                t = g.get("teams", {}).get(side, {})
                team = t.get("team")
                if not team:
                    continue
                pp = t.get("probablePitcher")
                rec["teams"][side] = {
                    "team": {"id": team["id"], "name": team["name"]},
                    "probablePitcher": ({"id": pp["id"], "fullName": pp["fullName"]} if pp else None),
                }
            if len(rec["teams"]) == 2:
                games.append(rec)
        if games:
            dates.append({"date": day.get("date"), "games": games})
    return {"dates": dates}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/snapshot.json")
    args = ap.parse_args()

    today = dt.date.today()
    year = today.year

    try:
        season = get(f"seasons/{year}?sportId={SPORT_ID}")["seasons"][0]
        season_end = season.get("regularSeasonEndDate") or f"{year}-10-01"

        teams_raw = get(f"teams?sportId={SPORT_ID}")["teams"]
        teams = sorted(
            (
                {
                    "id": t["id"],
                    "name": t["name"],
                    "teamName": t.get("teamName", ""),
                    "abbreviation": t["abbreviation"],
                    "division": t.get("division", {}).get("name", ""),
                    "league": t.get("league", {}).get("name", ""),
                }
                for t in teams_raw
            ),
            key=lambda t: t["abbreviation"],
        )

        start = (today - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
        end = max(season_end, today.isoformat())
        schedule = slim_schedule(
            get(f"schedule?sportId={SPORT_ID}&startDate={start}&endDate={end}&hydrate=probablePitcher")
        )

        injured: dict[str, list[int]] = {}
        for t in teams:
            try:
                roster = get(f"teams/{t['id']}/roster?rosterType=40Man").get("roster", [])
            except urllib.error.URLError as exc:
                print(f"  warn: roster for {t['abbreviation']} failed ({exc}) — no exclusions", file=sys.stderr)
                roster = []
            ids = [
                r["person"]["id"]
                for r in roster
                if any(k in (r.get("status", {}).get("description") or "").lower() for k in INJURED_KEYWORDS)
            ]
            if ids:
                injured[str(t["id"])] = ids

    except (urllib.error.URLError, KeyError, IndexError, ValueError) as exc:
        print(f"snapshot failed: {exc}", file=sys.stderr)
        return 1

    snapshot = {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "seasonEnd": season_end,
        "teams": teams,
        "schedule": schedule,
        "injuredByTeam": injured,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, separators=(",", ":"))

    games = sum(len(d["games"]) for d in schedule["dates"])
    size = os.path.getsize(args.out)
    print(f"wrote {args.out}: {games} games, {len(teams)} teams, {sum(len(v) for v in injured.values())} injured, {size/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
