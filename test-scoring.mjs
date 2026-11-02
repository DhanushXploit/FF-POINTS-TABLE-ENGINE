// Throwaway verification for the standalone Points Table Engine scoring.
// Run: node test-scoring.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { computeStandings, computeMatchResults } from "./public/scoring.js";

const seed = JSON.parse(readFileSync(new URL("./seed-data.json", import.meta.url), "utf8"));
const teams = seed.teams.map((t) => ({ id: "team-" + t.slot, name: t.name }));
const idByName = Object.fromEntries(teams.map((t) => [t.name, t.id]));
const config = { killPoints: seed.config.killPoints, placementPoints: seed.config.placementPoints };
const matches = seed.matches.map((m) => ({
  number: m.number, status: m.status,
  rows: m.rows.map((r) => ({ rank: r.rank, teamId: idByName[r.team], teamName: r.team, players: r.players.map((p) => p.player), kills: r.players.map((p) => p.kills) })),
}));

const expected = [
  ["REVEN ES", 20], ["TEAM POISON", 18], ["MIDDLE CLASS", 14], ["MIT FINGER", 10],
  ["MID CLAW", 9], ["RULE BREAKERS", 8], ["MISTY", 7], ["TAMIL GAMING", 7],
  ["FFBLOODS", 4], ["DEVIL EATERS", 1], ["BLOOD PRONE", 0],
];

// Per-match results in points order
const results = computeMatchResults(matches[0], config);
assert.deepEqual(results.map((r) => [r.teamName, r.total]), expected, "match results totals/order");

// Overall standings: same sequence and totals
const standings = computeStandings(teams, matches, config);
assert.deepEqual(standings.map((s) => [s.name, s.totalPts]), expected, "standings totals/order");

// Tiebreak check: MISTY (4 kills) must sit above TAMIL GAMING (1 kill), both on 7 pts
const names = standings.map((s) => s.name);
assert.ok(names.indexOf("MISTY") < names.indexOf("TAMIL GAMING"), "kill tiebreak");

console.log("PASS: Match 1 totals and standings order match the expected sequence:");
for (const [n, pts] of expected) console.log(`  ${n}: ${pts}`);
