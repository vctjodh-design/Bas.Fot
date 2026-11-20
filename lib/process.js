/**
 * Processing job: for one past date it walks every fixture on Vitibet and
 * collects the pre-match picture for each match:
 *
 *   match page      → published Vitibet index/tip, our calculated form, power,
 *                     probabilities, markets, expected score, odds, community
 *   club profile    → season totals, half splits, streaks, recent matches,
 *                     home/away standings rows, corners
 *   competition     → full/home/away/half standings, form table, over/under,
 *                     goal distribution, league average goals, top scorers,
 *                     trends
 *
 * Results are written to the disk store, so the Database tab keeps them
 * across refreshes and server restarts.
 */

import crypto from 'node:crypto';
import { fetchDay, fetchMatch } from './scrape.js';
import { fetchClubProfile, fetchCompetitionPage, fetchCommunity, normTeam, round } from './profile.js';
import { featuresForFixture } from './ml.js';
import * as store from './store.js';

// Every page request also waits in lib/http.js's shared queue, which is what
// actually paces the run, so fixtures can be worked on several at a time.
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.PROCESS_CONCURRENCY || 5), 12));
const PROFILE_TTL_MS = Number(process.env.PROFILE_TTL_MS || 6 * 60 * 60 * 1000);
const MAX_FIXTURES = Math.max(0, Number(process.env.PROCESS_MAX_FIXTURES || 0));

const jobs = new Map();

const age = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);

const todayISO = () => new Date().toISOString().slice(0, 10);

function log(job, message) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${message}`;
  job.log.push(line);
  if (job.log.length > 300) job.log.shift();
  console.log(`[process ${job.id.slice(0, 8)}] ${message}`);
}

function publicRun(job) {
  return {
    id: job.id,
    mode: job.mode || 'database',
    date: job.date,
    sport: job.sport,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    counts: job.counts,
    error: job.error || null,
  };
}

async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

function settleBest(key, home, away) {
  if (!key || !Number.isFinite(home) || !Number.isFinite(away)) return null;
  const total = home + away;
  switch (key) {
    case '1':
      return home > away ? 'won' : 'lost';
    case 'X':
      return home === away ? 'won' : 'lost';
    case '2':
      return away > home ? 'won' : 'lost';
    case '1X':
      return home >= away ? 'won' : 'lost';
    case 'X2':
      return away >= home ? 'won' : 'lost';
    case '12':
      return home !== away ? 'won' : 'lost';
    case 'O2.5':
      return total > 2.5 ? 'won' : 'lost';
    case 'U2.5':
      return total < 2.5 ? 'won' : 'lost';
    case 'GG':
      return home > 0 && away > 0 ? 'won' : 'lost';
    case 'NG':
      return !(home > 0 && away > 0) ? 'won' : 'lost';
    default:
      return null;
  }
}

function mergeFixture(existing, entry) {
  const list = Array.isArray(existing) ? [...existing] : [];
  if (!list.some((item) => item.fixtureId === entry.fixtureId && item.date === entry.date)) {
    list.push(entry);
  }
  return list.slice(-500);
}

function teamSummary(record) {
  if (!record) return null;
  const profile = record.profile || null;
  const usable = profile && profile.available !== false;
  return {
    key: record.key,
    name: record.name,
    teamId: record.teamId || null,
    url: record.url || null,
    corners: record.corners || null,
    profile: usable
      ? {
          season: profile.season,
          matches: profile.matches,
          form: profile.form,
          summary: profile.summary,
          standings: profile.standings,
          recentMatches: (profile.recentMatches || []).slice(0, 10),
          highlights: profile.highlights,
          halftime: profile.halftime || null,
          streaks: profile.streaks || null,
          available: true,
        }
      : {
          available: false,
          reason:
            profile?.note || record.note || 'Vitibet publishes no club profile for this team.',
        },
  };
}

function competitionSummary(record) {
  if (!record) return null;
  return {
    key: record.key,
    name: record.name,
    leagueId: record.leagueId || null,
    url: record.url || null,
    leagueAverageGoals: record.leagueAverageGoals ?? null,
    goalsPerGame: record.goalsPerGame ?? null,
    overUnder: record.overUnder || [],
    goalDistribution: record.goalDistribution || [],
    topScorers: (record.topScorers || []).slice(0, 10),
    recentMatches: (record.recentMatches || []).slice(0, 10),
    leagueStats: record.leagueStats || null,
    recentRates: record.recentRates || null,
    seasonRates: record.seasonRates || null,
    rates: record.rates || null,
  };
}

const impliedProbabilities = (odds) => {
  const current = (odds?.outcomes || [])
    .map((outcome) => Number(outcome.current))
    .filter((value) => Number.isFinite(value) && value > 1)
    .slice(0, 3);
  if (current.length < 3) return null;
  const inverse = current.map((value) => 1 / value);
  const sum = inverse.reduce((total, value) => total + value, 0);
  return {
    '1': round((100 * inverse[0]) / sum, 1),
    X: round((100 * inverse[1]) / sum, 1),
    '2': round((100 * inverse[2]) / sum, 1),
  };
};

/** Compact team picture attached to every match record (and dossier). */
function teamContext(record, fallbackName) {
  if (!record) return { name: fallbackName || 'Team', available: false };
  const profile = record.profile || null;
  const usable = profile && profile.available !== false;
  const overall = profile?.standings?.find((table) => /overall/i.test(table.label))?.position || null;
  const summary = profile?.summary || {};
  return {
    key: record.key || null,
    name: record.name || fallbackName || 'Team',
    teamId: record.teamId || null,
    url: record.url || null,
    available: usable,
    position: overall?.rank || null,
    points: overall?.points != null ? Number(overall.points) : null,
    played: overall?.played != null ? Number(overall.played) : summary.played ?? null,
    wins: overall?.wins != null ? Number(overall.wins) : summary.record?.wins ?? null,
    draws: overall?.draws != null ? Number(overall.draws) : summary.record?.draws ?? null,
    losses: overall?.losses != null ? Number(overall.losses) : summary.record?.losses ?? null,
    goals: overall?.goals || null,
    form: profile?.form || [],
    avgScored: summary.avgScored ?? null,
    avgConceded: summary.avgConceded ?? null,
    bttsPct: summary.bttsPct ?? null,
    cleanSheetPct: summary.cleanSheetPct ?? null,
    over25Pct: summary.over25Pct ?? null,
    winRate: summary.winRate ?? null,
    streaks: profile?.streaks || null,
    halftime: profile?.halftime || null,
    halves: profile?.halves || null,
    pointsTrend: profile?.pointsTrend || null,
    recent: (profile?.recentMatches || []).slice(0, 5).map((match) => ({
      date: match.date,
      opponent: match.opponent,
      venue: match.venue,
      score: match.score,
      result: match.result,
    })),
  };
}

/** Season rates pooled from every stored club profile in one competition. */
function aggregateTeamRates(records = []) {
  let played = 0;
  let cleanSheets = 0;
  let btts = 0;
  let over25 = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let teams = 0;

  for (const record of records) {
    const profile = record?.profile;
    if (!profile || profile.available === false) continue;
    const summary = profile.summary || {};
    const games = Number(summary.played) || 0;
    if (!games) continue;
    teams += 1;
    played += games;
    cleanSheets += ((Number(summary.cleanSheetPct) || 0) / 100) * games;
    btts += ((Number(summary.bttsPct) || 0) / 100) * games;
    over25 += ((Number(summary.over25Pct) || 0) / 100) * games;
    goalsFor += Number(summary.goals?.for) || 0;
    goalsAgainst += Number(summary.goals?.against) || 0;
    wins += Number(summary.record?.wins) || 0;
    draws += Number(summary.record?.draws) || 0;
    losses += Number(summary.record?.losses) || 0;
  }

  if (!played) return null;
  return {
    teams,
    played,
    matches: Math.round(played / 2),
    // Counts are pooled over both teams, so halve them to express "per match".
    cleanSheets: Math.round(cleanSheets / 2),
    btts: Math.round(btts / 2),
    over25: Math.round(over25 / 2),
    avgGoals: round((2 * goalsFor) / played, 2),
    cleanSheetPct: round((100 * cleanSheets) / played, 1),
    bttsPct: round((100 * btts) / played, 1),
    over25Pct: round((100 * over25) / played, 1),
    wins,
    draws,
    losses,
    winPct: round((100 * wins) / played, 1),
    drawPct: round((100 * draws) / played, 1),
    lossPct: round((100 * losses) / played, 1),
  };
}

/**
 * The database is meant to hold complete match records only. A fixture is
 * stored when it has a final score and the full pre-match picture the dossier
 * renders: our calculated stats, the calculated-form/team-power bars, both club
 * profiles and the competition's recent-match rates. Everything else is
 * reported as skipped with the missing pieces.
 */
function incompleteReasons(record) {
  const reasons = [];
  const home = Number(record.score?.home);
  const away = Number(record.score?.away);
  if (!Number.isFinite(home) || !Number.isFinite(away)) reasons.push('no final score');
  if (!record.calculated?.probabilities || record.calculated?.total == null) {
    reasons.push('no calculated stats');
  }
  const barLabels = (record.bars || []).map((bar) => String(bar.label || ''));
  if (!barLabels.some((label) => /calculated form/i.test(label))) {
    reasons.push('missing calculated form');
  }
  if (!barLabels.some((label) => /team power/i.test(label))) {
    reasons.push('missing team power');
  }
  if (!record.teamContext?.home?.available || !record.teamContext?.away?.available) {
    reasons.push('missing team profile');
  }
  if (!record.league?.rates?.recent) reasons.push('missing league rates');
  return reasons;
}

/* What a prediction run reports when a fixture cannot be scored by the model. */
function predictionGaps(record) {
  const gaps = [];
  if (!record.teamContext?.home?.available) gaps.push('missing home team profile');
  if (!record.teamContext?.away?.available) gaps.push('missing away team profile');
  if (record.calculated?.total == null) gaps.push('no calculated stats');
  if (!gaps.length) gaps.push('not enough pre-match history');
  return gaps;
}

function buildFixtureRecord({ fixture, detail, homeTeam, awayTeam, competition, community }) {
  const calculated = detail.calculated || null;
  const published = detail.published || null;
  const finished =
    detail.status === 'finished' && detail.homeScore != null && detail.awayScore != null;

  const home = Number(detail.homeScore);
  const away = Number(detail.awayScore);
  const expected = detail.prediction ? { home: detail.prediction.home, away: detail.prediction.away } : null;
  const total = detail.prediction?.total ?? null;
  const actualTotal = finished ? home + away : null;

  // Corners are a league-wide table on the competition page, so both teams
  // are looked up there rather than on their own profile.
  const cornerRows = competition?.corners?.rows || [];
  const findCorners = (name) =>
    cornerRows.find((row) => normTeam(row.team) === normTeam(name)) || null;

  return {
    fixtureId: fixture.fixtureId,
    kickoff: fixture.kickoff || null,
    startsAt: fixture.startsAt || null,
    status: detail.status,
    score: finished ? { home, away } : null,
    actualTotal,
    totalDelta: finished && total != null ? total - actualTotal : null,
    bestResult: finished ? settleBest(calculated?.best?.key, home, away) : null,
    home: detail.home?.name || fixture.home,
    away: detail.away?.name || fixture.away,
    homeLogo: detail.home?.logo || fixture.homeLogo || null,
    awayLogo: detail.away?.logo || fixture.awayLogo || null,
    leagueId: fixture.leagueId || detail.leagueId || null,
    leagueName: fixture.leagueName || detail.leagueName || null,
    leagueUrl: competition?.url || null,
    competitionKey: competition?.key || null,
    detailUrl: detail.detailUrl || fixture.detailUrl || null,
    homeTeamKey: homeTeam?.key || null,
    awayTeamKey: awayTeam?.key || null,
    homeTeamId: detail.homeTeamId || homeTeam?.teamId || null,
    awayTeamId: detail.awayTeamId || awayTeam?.teamId || null,
    vitibet: {
      published: Boolean(published),
      tip: fixture.tip || null,
      index: published?.index ?? null,
      probabilities: published?.probabilities ?? null,
    },
    calculated: calculated
      ? {
          index: calculated.index ?? null,
          form: calculated.form ?? null,
          power: calculated.power ?? null,
          probabilities: calculated.probabilities ?? null,
          best: calculated.best ?? null,
          markets: calculated.markets ?? null,
          total,
          expected,
          sample: detail.prediction?.sample ?? null,
        }
      : null,
    odds: detail.odds || null,
    oddsProbabilities: impliedProbabilities(detail.odds),
    community: community || detail.community || null,
    bars: detail.bars || null,
    headerStats: detail.headerStats || null,
    form: {
      home: detail.home?.form || [],
      away: detail.away?.form || [],
    },
    teamContext: {
      home: teamContext(homeTeam, fixture.home),
      away: teamContext(awayTeam, fixture.away),
    },
    league: {
      key: competition?.key || null,
      name: competition?.name || fixture.leagueName || null,
      url: competition?.url || fixture.leagueUrl || null,
      averageGoals:
        competition?.leagueStats?.avgGoalsPerMatch ?? competition?.leagueAverageGoals ?? null,
      goalsPerGame: competition?.goalsPerGame ?? null,
      leagueStats: competition?.leagueStats || null,
      recentMatches: (competition?.recentMatches || []).slice(0, 10),
      rates: {
        recent: competition?.recentRates || null,
        season: competition?.seasonRates || null,
        teams: null,
      },
    },
    corners: {
      home: findCorners(homeTeam?.name),
      away: findCorners(awayTeam?.name),
    },
    scrapedAt: detail.scrapedAt || new Date().toISOString(),
    teamProfiles: {
      home: teamSummary(homeTeam),
      away: teamSummary(awayTeam),
    },
    competition: competitionSummary(competition),
  };
}

async function collectTeam({ sport, teamId, url, name }) {
  const key = store.teamKey(sport, teamId, name);
  const existing = store.getTeam(key);
  if (existing?.profile && age(existing.updatedAt) < PROFILE_TTL_MS) return existing;
  if (!url) {
    return {
      ...(existing || {}),
      key,
      sport,
      teamId: teamId || null,
      name: name || 'Team',
      url: null,
      profile: null,
      note: 'Vitibet publishes no club profile link for this team.',
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const profile = await fetchClubProfile(url);
    return {
      ...(existing || {}),
      key,
      sport,
      teamId: teamId || null,
      name: profile.name || name || 'Team',
      url,
      profile,
      note: null,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ...(existing || {}),
      key,
      sport,
      teamId: teamId || null,
      name: name || 'Team',
      url,
      profile: null,
      note: String(error?.message || error),
      updatedAt: new Date().toISOString(),
    };
  }
}

async function collectCompetition({ sport, league, date }) {
  const leagueId = league?.id || null;
  const compKey = store.competitionKey(sport, leagueId, league?.name);
  const existing = store.getCompetition(compKey);
  if (existing?.tables?.all && age(existing.updatedAt) < PROFILE_TTL_MS) return existing;

  let page = null;
  if (league?.url) {
    try {
      page = await fetchCompetitionPage(league.url, {
        leagueId,
        name: league.name,
        sport,
      });
    } catch {
      page = null;
    }
  }

  const corners = page?.corners || existing?.corners || null;
  return {
    ...(existing || {}),
    key: compKey,
    sport,
    leagueId,
    name: page?.name || league?.name || existing?.name || 'Competition',
    url: league?.url || existing?.url || null,
    tables: page?.tables || existing?.tables || {},
    groups: page?.groups || existing?.groups || [],
    leagueAverageGoals: page?.leagueAverageGoals ?? existing?.leagueAverageGoals ?? null,
    goalsPerGame: page?.goalsPerGame ?? existing?.goalsPerGame ?? null,
    overUnder: page?.overUnder || existing?.overUnder || [],
    goalDistribution: page?.goalDistribution || existing?.goalDistribution || [],
    topScorers: page?.topScorers || existing?.topScorers || [],
    topAssists: page?.topAssists || existing?.topAssists || [],
    cards: page?.cards || existing?.cards || [],
    trends: page?.trends || existing?.trends || [],
    recentMatches: page?.recentMatches || existing?.recentMatches || [],
    leagueStats: page?.leagueStats || existing?.leagueStats || null,
    recentRates: page?.recentRates || existing?.recentRates || null,
    seasonRates: page?.seasonRates || existing?.seasonRates || null,
    rates: existing?.rates || null,
    season: page?.season || existing?.season || null,
    corners,
    sources: [...new Set([...(existing?.sources || []), date])],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Collect the same pre-match picture as a processing run for one clicked
 * fixture, without adding that fixture to the training database. This is the
 * on-demand path used by match pages for fixtures that are not stored yet.
 */
export async function collectFixture({ fixtureId, date, sport = 'football', leagueId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Pass date=YYYY-MM-DD so the fixture can be looked up.');
  }
  const day = await fetchDay(date, sport);
  const league = day.leagues.find(
    (entry) =>
      (leagueId && String(entry.id) === String(leagueId)) ||
      entry.matches.some((match) => String(match.fixtureId) === String(fixtureId))
  );
  const fixture = league?.matches.find((match) => String(match.fixtureId) === String(fixtureId));
  if (!fixture) {
    throw new Error('This fixture is not listed on the selected date.');
  }

  const detail = await fetchMatch(fixtureId, fixture.leagueId || league.id, sport);
  const homeName = detail.home?.name || fixture.home;
  const awayName = detail.away?.name || fixture.away;
  const [competition, homeTeam, awayTeam, liveCommunity] = await Promise.all([
    collectCompetition({ sport, league, date }),
    collectTeam({ sport, teamId: detail.homeTeamId, url: detail.homeProfileUrl, name: homeName }),
    collectTeam({ sport, teamId: detail.awayTeamId, url: detail.awayProfileUrl, name: awayName }),
    fetchCommunity(fixtureId, sport).catch(() => null),
  ]);

  const community = liveCommunity
    ? { ...(detail.community || {}), ...liveCommunity }
    : { ...(detail.community || {}), available: false, reason: 'The community pick lookup failed.' };

  const record = buildFixtureRecord({
    fixture: { ...fixture, league },
    detail,
    homeTeam,
    awayTeam,
    competition,
    community,
  });

  const aggregate = aggregateTeamRates([homeTeam, awayTeam]);
  const averageGoals =
    [competition?.leagueStats?.avgGoalsPerMatch, competition?.leagueAverageGoals, aggregate?.avgGoals].find(
      (value) => Number.isFinite(value) && value > 0
    ) ?? null;
  record.league = {
    ...(record.league || {}),
    averageGoals,
    recentMatches: (competition?.recentMatches || []).slice(0, 10),
    rates: {
      recent: competition?.recentRates || null,
      season: competition?.seasonRates || null,
      teams: aggregate,
    },
  };

  return record;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  const memory = [...jobs.values()].map(publicRun);
  const seen = new Set(memory.map((run) => run.id));
  const stored = store
    .getRuns()
    .filter((run) => !seen.has(run.id))
    .map((run) => ({ ...run, stored: true }));
  return [...memory, ...stored].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function startProcessing({ date, sport = 'football', refresh = false, mode = 'database' }) {
  const predictionMode = mode === 'prediction';
  const key = `${mode}|${store.dayKey(sport, date)}`;
  const existing = [...jobs.values()].find(
    (job) => job.key === key && (job.status === 'running' || job.status === 'queued')
  );
  if (existing) return existing;

  const job = {
    id: crypto.randomUUID(),
    key,
    mode,
    date,
    sport,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { stage: 'fixtures', done: 0, total: 0, teams: 0, competitions: 0 },
    counts: { fixtures: 0, teams: 0, competitions: 0, errors: 0 },
    log: [],
    errors: [],
    error: null,
  };
  jobs.set(job.id, job);
  store.putRun(publicRun(job));
  store.scheduleSave();
  log(job, predictionMode ? `Preparing ${sport} matches for prediction on ${date}` : `Processing ${sport} for ${date}`);

  void (async () => {
    try {
      const day = await fetchDay(date, sport);
      const fixtures = day.leagues
        .flatMap((league) => league.matches.map((match) => ({ ...match, league })))
        .filter((match) => match.fixtureId);
      const limited = MAX_FIXTURES ? fixtures.slice(0, MAX_FIXTURES) : fixtures;
      job.progress.total = limited.length;
      if (MAX_FIXTURES) log(job, `PROCESS_MAX_FIXTURES=${MAX_FIXTURES}, limiting the run`);
      log(job, `${day.leagues.length} competitions, ${limited.length} fixtures listed`);

      store.scheduleSave();
      const dayRecord = {
        key: store.dayKey(sport, date),
        date,
        sport,
        status: 'running',
        processedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: day.source,
        counts: { ...(day.counts || {}), leagues: day.leagues.length },
        fixtures: [],
        skipped: [],
        teams: [],
        competitions: [],
        errors: [],
      };
      if (!predictionMode) store.putDay(dayRecord);

      const teamPages = new Map();
      const compPages = new Map();
      const predictionKeys = new Set();
      const predictionTeamKeys = new Set();
      const predictionCompKeys = new Set();

      const ensureTeam = (teamId, url, name) => {
        const teamKey = store.teamKey(sport, teamId, name);
        if (teamPages.has(teamKey)) return teamPages.get(teamKey);

        const promise = (async () => {
          const existing = store.getTeam(teamKey);
          if (!refresh && existing?.profile && age(existing.updatedAt) < PROFILE_TTL_MS) {
            return existing;
          }

          job.progress.stage = 'teams';
          let profile = null;
          let note = null;
          if (url) {
            try {
              profile = await fetchClubProfile(url);
              job.progress.teams += 1;
              log(job, `team profile: ${profile.name || name}`);
            } catch (error) {
              note = String(error?.message || error);
              job.errors.push({ team: name, message: note });
              log(job, `team profile failed: ${name} — ${note}`);
            }
          } else {
            note = 'Vitibet publishes no club profile link for this team.';
          }

          const record = {
            key: teamKey,
            sport,
            teamId: teamId || null,
            name: profile?.name || name || 'Team',
            url: url || null,
            note,
            profile,
            corners: existing?.corners || null,
            fixtures: Array.isArray(existing?.fixtures) ? [...existing.fixtures] : [],
            sources: [...new Set([...(existing?.sources || []), date])],
            updatedAt: new Date().toISOString(),
          };
          store.putTeam(record);
          store.scheduleSave();
          return record;
        })();

        teamPages.set(teamKey, promise);
        return promise;
      };

      const ensureCompetition = (league) => {
        const leagueId = league.id || null;
        const compKey = store.competitionKey(sport, leagueId, league.name);
        if (compPages.has(compKey)) return compPages.get(compKey);

        const promise = (async () => {
          const existing = store.getCompetition(compKey);
          if (!refresh && existing?.tables?.all && age(existing.updatedAt) < PROFILE_TTL_MS) {
            return existing;
          }

          job.progress.stage = 'competitions';
          let page = null;
          if (league.url) {
            try {
              page = await fetchCompetitionPage(league.url, {
                leagueId,
                name: league.name,
                sport,
              });
              log(job, `competition page: ${page.name}`);
            } catch (error) {
              job.errors.push({ competition: league.name, message: String(error?.message || error) });
              log(job, `competition page failed: ${league.name}`);
            }
          }
          const corners = page?.corners || existing?.corners || null;

          job.progress.competitions += 1;
          const record = {
            key: compKey,
            sport,
            leagueId,
            name: page?.name || league.name,
            url: league.url || null,
            tables: page?.tables || existing?.tables || {},
            groups: page?.groups || existing?.groups || [],
            leagueAverageGoals: page?.leagueAverageGoals ?? existing?.leagueAverageGoals ?? null,
            goalsPerGame: page?.goalsPerGame ?? existing?.goalsPerGame ?? null,
            overUnder: page?.overUnder || existing?.overUnder || [],
            goalDistribution: page?.goalDistribution || existing?.goalDistribution || [],
            topScorers: page?.topScorers || existing?.topScorers || [],
            topAssists: page?.topAssists || existing?.topAssists || [],
            cards: page?.cards || existing?.cards || [],
            trends: page?.trends || existing?.trends || [],
            recentMatches: page?.recentMatches || existing?.recentMatches || [],
            leagueStats: page?.leagueStats || existing?.leagueStats || null,
            recentRates: page?.recentRates || existing?.recentRates || null,
            seasonRates: page?.seasonRates || existing?.seasonRates || null,
            rates: existing?.rates || null,
            season: page?.season || existing?.season || null,
            corners,
            sources: [...new Set([...(existing?.sources || []), date])],
            updatedAt: new Date().toISOString(),
          };
          store.putCompetition(record);
          store.scheduleSave();
          return record;
        })();

        compPages.set(compKey, promise);
        return promise;
      };

      let done = 0;
      await pool(limited, CONCURRENCY, async (fixture) => {
        try {
          job.progress.stage = 'fixtures';
          const detail = await fetchMatch(fixture.fixtureId, fixture.leagueId, sport);
          const homeName = detail.home?.name || fixture.home;
          const awayName = detail.away?.name || fixture.away;
          // Both club profiles, the competition page and the community lookup
          // are independent of each other: fetch them together rather than one
          // after another, which is what made a run look like it was going one
          // fixture at a time.
          const [competition, homeTeam, awayTeam, liveCommunity] = await Promise.all([
            ensureCompetition(fixture.league),
            ensureTeam(detail.homeTeamId, detail.homeProfileUrl, homeName),
            ensureTeam(detail.awayTeamId, detail.awayProfileUrl, awayName),
            fetchCommunity(fixture.fixtureId, sport).catch(() => null),
          ]);

          const attachCorners = (team) => {
            if (!team || !competition?.corners?.rows?.length) return;
            const row = competition.corners.rows.find((entry) => normTeam(entry.team) === normTeam(team.name));
            if (row) {
              team.corners = {
                label: competition.corners.label,
                competition: competition.name,
                rows: [row],
              };
            }
          };

          const community = liveCommunity
            ? { ...(detail.community || {}), ...liveCommunity }
            : {
                ...(detail.community || {}),
                available: false,
                reason: 'The community pick lookup failed.',
              };

          const record = buildFixtureRecord({
            fixture,
            detail,
            homeTeam,
            awayTeam,
            competition,
            community,
          });

          if (predictionMode) {
            // The prediction set keeps every fixture the model can score, with
            // or without a final result. Team profiles and the competition page
            // are already stored on their own, so the match row stays slim.
            const gaps = featuresForFixture(record, { requireResult: false })
              ? []
              : predictionGaps(record);
            if (gaps.length) {
              dayRecord.skipped.push({
                fixtureId: fixture.fixtureId,
                home: record.home,
                away: record.away,
                leagueName: record.leagueName || null,
                reasons: gaps,
              });
              log(job, `not predict-ready: ${record.home} vs ${record.away} (${gaps.join(', ')})`);
              return;
            }

            const { teamProfiles, competition: _competition, ...stored } = record;
            store.putPrediction({
              key: store.predictionKey(sport, record.fixtureId),
              sport,
              date,
              fixtureId: String(record.fixtureId),
              savedAt: new Date().toISOString(),
              record: stored,
            });
            predictionKeys.add(String(record.fixtureId));
            if (homeTeam?.key) predictionTeamKeys.add(homeTeam.key);
            if (awayTeam?.key) predictionTeamKeys.add(awayTeam.key);
            if (competition?.key) predictionCompKeys.add(competition.key);
            log(job, `ready for prediction: ${record.home} vs ${record.away}`);
            return;
          }

          const reasons = incompleteReasons(record);
          if (reasons.length) {
            dayRecord.skipped.push({
              fixtureId: fixture.fixtureId,
              home: record.home,
              away: record.away,
              leagueName: record.leagueName || null,
              reasons,
            });
            log(job, `skipped incomplete: ${record.home} vs ${record.away} (${reasons.join(', ')})`);
            return;
          }

          for (const team of [homeTeam, awayTeam]) {
            if (!team) continue;
            attachCorners(team);
            team.fixtures = mergeFixture(team.fixtures, { date, fixtureId: fixture.fixtureId });
            store.putTeam(team);
          }

          dayRecord.fixtures.push(record);

          for (const team of [homeTeam, awayTeam]) {
            if (team && !dayRecord.teams.includes(team.key)) dayRecord.teams.push(team.key);
          }
          const compKey = competition?.key;
          if (compKey && !dayRecord.competitions.includes(compKey)) dayRecord.competitions.push(compKey);
        } catch (error) {
          const message = String(error?.message || error);
          dayRecord.errors.push({
            fixtureId: fixture.fixtureId,
            home: fixture.home,
            away: fixture.away,
            message,
          });
          job.errors.push({ fixtureId: fixture.fixtureId, message });
          log(job, `fixture failed: ${fixture.home} vs ${fixture.away} — ${message}`);
        } finally {
          done += 1;
          job.progress.done = done;
          job.progress.stage = 'fixtures';
          // Report the running totals, not just the final ones, so the card
          // shows what has been saved while the run is still going.
          job.counts = predictionMode
            ? {
                fixtures: predictionKeys.size,
                skipped: dayRecord.skipped.length,
                teams: predictionTeamKeys.size,
                competitions: predictionCompKeys.size,
                errors: dayRecord.errors.length,
              }
            : {
                fixtures: dayRecord.fixtures.length,
                skipped: dayRecord.skipped.length,
                teams: dayRecord.teams.length,
                competitions: dayRecord.competitions.length,
                errors: dayRecord.errors.length,
              };
          store.scheduleSave();
        }
      });

      if (predictionMode) {
        // Re-running a date replaces its ready set instead of keeping fixtures
        // that have since disappeared from the listing.
        store.removePredictions({ sport, date, keep: predictionKeys });
        store.saveNow();
        job.counts = {
          fixtures: predictionKeys.size,
          skipped: dayRecord.skipped.length,
          teams: predictionTeamKeys.size,
          competitions: predictionCompKeys.size,
          errors: dayRecord.errors.length,
        };
        job.status = dayRecord.errors.length ? 'partial' : 'done';
        job.finishedAt = new Date().toISOString();
        job.progress.stage = 'done';
        log(
          job,
          `Saved ${job.counts.fixtures} matches ready for prediction` +
            (job.counts.skipped ? `, ${job.counts.skipped} skipped without enough data` : '') +
            (job.counts.errors ? `, ${job.counts.errors} errors` : '')
        );
        store.putRun(publicRun(job));
        store.saveNow();
        return;
      }

      // Pool the club profiles of each competition into league-wide rates, and
      // attach the competition picture to every match record for the dossier.
      const teamsByCompetition = new Map();
      for (const fixture of dayRecord.fixtures) {
        if (!fixture.competitionKey) continue;
        if (!teamsByCompetition.has(fixture.competitionKey)) {
          teamsByCompetition.set(fixture.competitionKey, new Set());
        }
        const keys = teamsByCompetition.get(fixture.competitionKey);
        if (fixture.homeTeamKey) keys.add(fixture.homeTeamKey);
        if (fixture.awayTeamKey) keys.add(fixture.awayTeamKey);
      }

      for (const [competitionKey, teamKeys] of teamsByCompetition) {
        const competition = store.getCompetition(competitionKey);
        const aggregate = aggregateTeamRates([...teamKeys].map((key) => store.getTeam(key)));
        const rates = {
          recent: competition?.recentRates || null,
          season: competition?.seasonRates || null,
          teams: aggregate,
        };
        const averageGoals =
          [
            competition?.leagueStats?.avgGoalsPerMatch,
            competition?.leagueAverageGoals,
            aggregate?.avgGoals,
          ].find((value) => Number.isFinite(value) && value > 0) ?? null;
        if (competition) {
          competition.rates = rates;
          competition.updatedAt = new Date().toISOString();
          store.putCompetition(competition);
        }
        for (const fixture of dayRecord.fixtures) {
          if (fixture.competitionKey !== competitionKey) continue;
          fixture.league = {
            key: competitionKey,
            name: competition?.name || fixture.leagueName || null,
            url: competition?.url || fixture.leagueUrl || null,
            averageGoals,
            goalsPerGame: competition?.goalsPerGame ?? null,
            leagueStats: competition?.leagueStats || null,
            recentMatches: competition?.recentMatches || fixture.league?.recentMatches || [],
            rates,
          };
        }
      }

      dayRecord.fixtures.sort((a, b) => String(a.kickoff || '').localeCompare(String(b.kickoff || '')));
      dayRecord.status = dayRecord.errors.length ? 'partial' : 'done';
      dayRecord.updatedAt = new Date().toISOString();
      store.putDay(dayRecord);
      store.saveNow();

      job.counts = {
        fixtures: dayRecord.fixtures.length,
        skipped: dayRecord.skipped.length,
        teams: dayRecord.teams.length,
        competitions: dayRecord.competitions.length,
        errors: dayRecord.errors.length,
      };
      dayRecord.counts = { ...(dayRecord.counts || {}), skipped: dayRecord.skipped.length };
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.progress.stage = 'done';
      log(
        job,
        `Saved ${job.counts.fixtures} complete fixtures, ${job.counts.teams} teams, ${job.counts.competitions} competitions` +
          (job.counts.skipped ? `, ${job.counts.skipped} incomplete skipped` : '') +
          (job.counts.errors ? `, ${job.counts.errors} errors` : '')
      );
      store.putRun(publicRun(job));
      store.saveNow();
    } catch (error) {
      const message = String(error?.message || error);
      job.status = 'error';
      job.error = message;
      job.finishedAt = new Date().toISOString();
      job.progress.stage = 'error';
      log(job, `stopped: ${message}`);
      store.putRun(publicRun(job));
      store.saveNow();
    }
  })();

  return job;
}

/** Runs left mid-flight by a server restart are shown as interrupted. */
function recoverInterrupted() {
  let changed = false;
  for (const run of store.getRuns()) {
    if (run.status === 'running' || run.status === 'queued') {
      run.status = 'interrupted';
      run.finishedAt = run.finishedAt || new Date().toISOString();
      changed = true;
    }
  }
  for (const day of Object.values(store.getDatabase().days)) {
    if (day.status === 'running') {
      day.status = 'interrupted';
      changed = true;
    }
  }
  if (changed) store.scheduleSave();
}

recoverInterrupted();

export { todayISO };
