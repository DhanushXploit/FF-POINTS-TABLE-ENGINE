// Points Table Engine — pure scoring functions (shared by the page and the Node test).
export const DEFAULT_KILL_POINTS = 1;
export const DEFAULT_PLACEMENT = {
  squad: [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0],
  duo: [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 0],
  solo: [60, 54, 50, 48, 46, 44, 42, 40, 38, 36, 34, 32, 31, 29, 28, 26, 25, 23, 22, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 3, 3, 2, 2, 1, 0, 0, 0],
};
export const PLAYERS_PER_MODE = { squad: 4, duo: 2, solo: 1 };

export function placementPointsFor(config, rank) {
  const table = (config && config.placementPoints) || [];
  if (!rank || rank < 1 || rank > table.length) return 0;
  return table[rank - 1] || 0;
}

export function rowTotals(row, config) {
  const killPoints = config && typeof config.killPoints === "number" ? config.killPoints : DEFAULT_KILL_POINTS;
  const kills = (row.kills || []).reduce((a, k) => a + (Number(k) || 0), 0);
  const killPts = kills * killPoints;
  const placementPts = placementPointsFor(config, row.rank);
  return { kills, killPts, placementPts, total: killPts + placementPts };
}

// Enriched, points-sorted results for a single match's rows.
export function computeMatchResults(match, config) {
  return (match.rows || [])
    .map((row) => ({ ...row, ...rowTotals(row, config) }))
    .sort((a, b) => b.total - a.total || b.killPts - a.killPts || a.rank - b.rank);
}

// Standings across confirmed matches (optionally only one match number).
// teams: [{id, name}], matches: [{number, status, rows: [{rank, teamId, kills: []}]}]
export function computeStandings(teams, matches, config, onlyMatchNumber = null) {
  const confirmed = (matches || []).filter(
    (m) => m.status === "confirmed" && (onlyMatchNumber == null || m.number === onlyMatchNumber)
  );
  const latestNumber = confirmed.length ? Math.max(...confirmed.map((m) => m.number)) : null;
  const byTeam = new Map();
  for (const t of teams || []) {
    byTeam.set(t.id, {
      teamId: t.id, name: t.name, matches: 0, booyahs: 0,
      placementPts: 0, killPts: 0, totalPts: 0, latestBestRank: null, perMatch: [],
    });
  }
  for (const m of confirmed) {
    for (const row of m.rows || []) {
      const s = byTeam.get(row.teamId);
      if (!s) continue;
      const tot = rowTotals(row, config);
      s.matches += 1;
      if (row.rank === 1) s.booyahs += 1;
      s.placementPts += tot.placementPts;
      s.killPts += tot.killPts;
      s.totalPts += tot.total;
      if (m.number === latestNumber) s.latestBestRank = row.rank;
      s.perMatch.push({ matchNumber: m.number, rank: row.rank, ...tot });
    }
  }
  const list = [...byTeam.values()];
  list.sort((a, b) =>
    b.totalPts - a.totalPts ||
    b.killPts - a.killPts ||
    b.booyahs - a.booyahs ||
    (a.latestBestRank ?? 999) - (b.latestBestRank ?? 999) ||
    a.name.localeCompare(b.name)
  );
  list.forEach((s, i) => { s.standing = i + 1; s.perMatch.sort((x, y) => x.matchNumber - y.matchNumber); });
  return list;
}

// Top fraggers across confirmed matches. Rows carry players: [names] aligned with kills: [].
export function topFraggers(matches, limit = 5) {
  const byPlayer = new Map();
  for (const m of matches || []) {
    if (m.status !== "confirmed") continue;
    for (const row of m.rows || []) {
      (row.players || []).forEach((name, i) => {
        if (!name) return;
        const key = name + "|" + (row.teamName || row.teamId || "");
        const cur = byPlayer.get(key) || { player: name, team: row.teamName || "", kills: 0 };
        cur.kills += Number((row.kills || [])[i]) || 0;
        byPlayer.set(key, cur);
      });
    }
  }
  return [...byPlayer.values()].sort((a, b) => b.kills - a.kills || a.player.localeCompare(b.player)).slice(0, limit);
}
