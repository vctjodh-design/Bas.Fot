/**
 * Disk-backed store for the processing tab.
 *
 * Everything lives in data/db.json and is rewritten atomically (temp file +
 * rename), so a refresh or a server restart keeps the collected days, teams
 * and competitions exactly as they were left. Data is normalised:
 *
 *   days[<sport>|<date>]        one processed date with its fixtures
 *   teams[<sport>|<teamId>]     club profile + corners, shared across dates
 *   competitions[<sport>|<id>]  standings, goals, scorers, trends
 *   runs[]                      processing history (capped)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VERSION = 1;
const MAX_RUNS = 40;

const emptyDb = () => ({
  version: VERSION,
  createdAt: new Date().toISOString(),
  updatedAt: null,
  days: {},
  teams: {},
  competitions: {},
  predictions: {},
  runs: [],
});

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) return emptyDb();
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      ...emptyDb(),
      ...parsed,
      days: parsed.days || {},
      teams: parsed.teams || {},
      competitions: parsed.competitions || {},
      predictions: parsed.predictions || {},
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch (error) {
    console.error('[store] could not read database, starting empty:', error?.message || error);
    try {
      if (fs.existsSync(DB_FILE)) {
        const backup = `${DB_FILE}.corrupt-${Date.now()}`;
        fs.renameSync(DB_FILE, backup);
        console.error(`[store] moved unreadable database to ${backup}`);
      }
    } catch {
      // A failed backup must not stop the app from booting.
    }
    return emptyDb();
  }
}

let db = load();
let saveTimer = null;

export const dayKey = (sport, date) => `${sport}|${date}`;

export const teamKey = (sport, teamId, name) =>
  teamId ? `${sport}|${teamId}` : `${sport}|name:${String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

export const competitionKey = (sport, leagueId, name) =>
  leagueId ? `${sport}|${leagueId}` : `${sport}|name:${String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

export const getDatabase = () => db;

export function getDay(key) {
  return db.days[key] || null;
}

export function putDay(day) {
  db.days[day.key] = day;
  db.updatedAt = new Date().toISOString();
}

export function deleteDay(key) {
  const day = db.days[key];
  if (!day) return null;
  delete db.days[key];
  for (const team of Object.values(db.teams)) {
    if (Array.isArray(team.sources)) team.sources = team.sources.filter((date) => date !== day.date);
    if (Array.isArray(team.fixtures)) {
      team.fixtures = team.fixtures.filter((fixture) => fixture.date !== day.date);
    }
  }
  db.updatedAt = new Date().toISOString();
  saveNow();
  return day;
}

export function deleteFixture(key, fixtureId) {
  const day = db.days[key];
  if (!day || !Array.isArray(day.fixtures)) return null;
  const removed = day.fixtures.find((fixture) => String(fixture.fixtureId) === String(fixtureId));
  if (!removed) return null;

  day.fixtures = day.fixtures.filter((fixture) => String(fixture.fixtureId) !== String(fixtureId));
  day.updatedAt = new Date().toISOString();
  for (const teamKey of [removed.homeTeamKey, removed.awayTeamKey]) {
    const team = teamKey ? db.teams[teamKey] : null;
    if (!team) continue;
    if (Array.isArray(team.fixtures)) {
      team.fixtures = team.fixtures.filter(
        (fixture) =>
          !(String(fixture.fixtureId) === String(fixtureId) && fixture.date === day.date)
      );
    }
  }

  if (!day.fixtures.length) return { removed, day: deleteDay(key) };
  db.updatedAt = new Date().toISOString();
  saveNow();
  return { removed, day };
}

export function getTeam(key) {
  return db.teams[key] || null;
}

export function putTeam(team) {
  db.teams[team.key] = team;
  db.updatedAt = new Date().toISOString();
}

export function getCompetition(key) {
  return db.competitions[key] || null;
}

export function putCompetition(competition) {
  db.competitions[competition.key] = competition;
  db.updatedAt = new Date().toISOString();
}

/* Prediction set: fixtures kept because the model has every feature it needs.
 * They live apart from `days` so a prediction run never mixes scheduled
 * matches (no final score) into the training database. */

export const predictionKey = (sport, fixtureId) => `${sport}|${fixtureId}`;

export function putPrediction(prediction) {
  db.predictions[prediction.key] = prediction;
  db.updatedAt = new Date().toISOString();
}

export function getPrediction(key) {
  return db.predictions[key] || null;
}

export function listPredictions({ sport = null, date = null } = {}) {
  return Object.values(db.predictions)
    .filter((entry) => (!sport || entry.sport === sport) && (!date || entry.date === date))
    .sort((a, b) =>
      a.date === b.date
        ? String(a.record?.kickoff || '').localeCompare(String(b.record?.kickoff || ''))
        : String(b.date).localeCompare(String(a.date))
    );
}

/** Drop ready rows for a date that a fresh run did not produce again. */
export function removePredictions({ sport, date, keep = new Set() }) {
  for (const [key, entry] of Object.entries(db.predictions)) {
    if (entry.sport !== sport || entry.date !== date) continue;
    if (keep.has(String(entry.fixtureId))) continue;
    delete db.predictions[key];
  }
  db.updatedAt = new Date().toISOString();
}

export function putRun(run) {
  const index = db.runs.findIndex((entry) => entry.id === run.id);
  if (index >= 0) db.runs[index] = run;
  else db.runs.unshift(run);
  db.runs = db.runs.slice(0, MAX_RUNS);
  db.updatedAt = new Date().toISOString();
}

export function getRuns() {
  return db.runs;
}

export function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (error) {
    console.error('[store] could not save database:', error?.message || error);
  }
}

export function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 700);
}

/**
 * Keyword search over the stored database, so a club or competition can be
 * found without knowing which date it was processed on.
 */
export function search(rawQuery, { sport = null, limit = 8 } = {}) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const result = { query, matches: [], competitions: [], total: 0 };
  if (query.length < 2) return result;

  const max = Math.max(1, Math.min(Number(limit) || 8, 25));
  const matches = [];
  const competitions = new Map();
  let matchCount = 0;

  for (const day of Object.values(db.days)) {
    if (sport && day.sport !== sport) continue;
    for (const fixture of day.fixtures || []) {
      const leagueName = fixture.leagueName || fixture.league?.name || '';
      const haystack = `${fixture.home || ''} ${fixture.away || ''} ${leagueName}`.toLowerCase();
      if (!haystack.includes(query)) continue;
      matchCount += 1;

      if (leagueName && leagueName.toLowerCase().includes(query)) {
        const key = `${day.sport}|${fixture.leagueId || leagueName}`;
        const entry = competitions.get(key) || {
          key,
          sport: day.sport,
          leagueId: fixture.leagueId || null,
          name: leagueName,
          date: day.date,
          fixtures: 0,
        };
        entry.fixtures += 1;
        if (day.date > entry.date) entry.date = day.date;
        competitions.set(key, entry);
      }

      if (matches.length < max) {
        matches.push({
          fixtureId: fixture.fixtureId,
          date: day.date,
          sport: day.sport,
          leagueId: fixture.leagueId || null,
          leagueName: leagueName || null,
          home: fixture.home || 'Home',
          away: fixture.away || 'Away',
          status: fixture.status || null,
          kickoff: fixture.kickoff || null,
          score: fixture.score || null,
        });
      }
    }
  }

  matches.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  result.matches = matches;
  result.competitions = [...competitions.values()]
    .sort((a, b) => b.fixtures - a.fixtures || a.name.localeCompare(b.name))
    .slice(0, max);
  result.total = matchCount + competitions.size;
  return result;
}

export function summary() {
  const days = Object.values(db.days)
    .map((day) => ({
      key: day.key,
      date: day.date,
      sport: day.sport,
      status: day.status,
      processedAt: day.processedAt,
      updatedAt: day.updatedAt || day.processedAt,
      fixtures: Array.isArray(day.fixtures) ? day.fixtures.length : 0,
      skipped: Array.isArray(day.skipped) ? day.skipped.length : 0,
      teams: Array.isArray(day.teams) ? day.teams.length : 0,
      competitions: Array.isArray(day.competitions) ? day.competitions.length : 0,
      errors: Array.isArray(day.errors) ? day.errors.length : 0,
    }))
    .sort((a, b) => (a.date === b.date ? a.sport.localeCompare(b.sport) : b.date.localeCompare(a.date)));

  const teams = Object.values(db.teams)
    .map((team) => ({
      key: team.key,
      name: team.name,
      sport: team.sport,
      teamId: team.teamId || null,
      url: team.url || null,
      season: team.profile?.season || null,
      form: team.profile?.form || [],
      avgScored: team.profile?.summary?.avgScored ?? null,
      avgConceded: team.profile?.summary?.avgConceded ?? null,
      position: team.profile?.standings?.[0]?.position?.rank || null,
      fixtures: Array.isArray(team.fixtures) ? team.fixtures.length : 0,
      hasProfile: Boolean(team.profile),
      updatedAt: team.updatedAt || null,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const competitions = Object.values(db.competitions)
    .map((competition) => ({
      key: competition.key,
      name: competition.name,
      sport: competition.sport,
      leagueId: competition.leagueId || null,
      url: competition.url || null,
      leagueAverageGoals: competition.leagueAverageGoals ?? null,
      goalsPerGame: competition.goalsPerGame ?? null,
      teams: competition.tables?.all?.rows?.length || 0,
      updatedAt: competition.updatedAt || null,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return {
    updatedAt: db.updatedAt,
    counts: {
      days: days.length,
      fixtures: days.reduce((sum, day) => sum + day.fixtures, 0),
      teams: teams.length,
      competitions: competitions.length,
      predictions: Object.keys(db.predictions || {}).length,
      runs: db.runs.length,
    },
    days,
    teams,
    competitions,
  };
}

export { DB_FILE, DATA_DIR };
