/**
 * Vitisport analytics, reconstructed.
 *
 * Vitibet publishes three analytics numbers for every match with enough
 * league games played: INDEX, \"Calculated Form\" and \"Team Power\" (plus the
 * 1 / 0 / 2 probabilities). Matches with too few games get a zeroed block and
 * a \"?\" tip instead. The formulas below reproduce the published block from the
 * data every match page already ships (last results + league table).
 *
 * Basketball — calibrated against 192 published matches (Nov 2026):
 *
 *   INDEX = (form_home + power_home) - (form_away + power_away)
 *           exact on 178/192 pages (remainder are pages whose form/power bars
 *           themselves are rounded inconsistently by the source).
 *
 *   form  = weighted average of the last 6 point margins; the newest game
 *           carries weight 6, the oldest weight 1 (\"největší váha je
 *           přikládána poslednímu zápasu\" in the Czech FAQ), scaled by 0.52
 *           to match the units Vitibet prints.
 *
 *   power = season point differential per game plus the league's home-court
 *           edge, added for the home side and subtracted for the away side
 *           (the site calculates power separately for home and away games).
 *           Vitibet's own values sit 4.4 points from the neutral differential
 *           in most European leagues and 2.2 in the NBA.
 *
 *   P(1)  = (100 - draw) / (1 + e^(-0.06 * INDEX)), rounded
 *   P(2)  = 100 - draw - P(1)
 *   draw  = 6 for the NBA (league 12), 3 for every other basketball league
 *           (Vitibet needs a non-zero 0% for regular time).
 *
 * Probabilities follow the published curve exactly once the index matches;
 * form and power are estimates of a proprietary rating.
 *
 * Backtest over 2026-11-16..18 (135 published matches, `npm run backtest`):
 * INDEX MAE 5.15 points, median 3.33, bias -0.97, 67% within +-5 and 84%
 * within +-10; Calculated Form MAE 2.38; Team Power MAE 2.12 but median 0.04,
 * i.e. exact for most matches with a heavy tail. The calculated pick matches
 * Vitibet's own tip on 94% of matches and wins at the same rate (67% of the
 * settled sample).
 *
 * Domestic leagues are close to exact. What is left is concentrated in
 * cross-border competitions (Euroleague, Eurocup, Basketball Champions
 * League): the table shown on those pages is not the one Vitibet feeds into
 * Team Power (its published values there track each club's domestic record),
 * so the reconstruction drifts by 7-13 index points on those fixtures.
 *
 * Football — the same shape, in goals rather than points. The published index
 * is a goal-scale rating (typically -4 to +6) and draws are a real outcome, so
 * the draw share falls as the index grows instead of being a constant. The
 * curve below is fitted to 195 published football fixtures (two days of
 * quicktips, Nov 2026): P(1) = (100 - draw) / (1 + e^(-0.62 * INDEX)) with the
 * draw share taken from the fitted table. On that sample the reconstruction
 * reproduces the published 1 / X / 2 percentages to within 0.6 / 2.1 / 1.7
 * points of absolute error — the draw leg is the noisy one because the source
 * rounds it to whole percent.
 *
 * Form and power were fitted on 91 published football match pages: a form
 * scale of 0.3 and a 0.25-goal home edge reproduce the published INDEX.
 * Re-checked on 2026-11-14..18 with the current pre-match inputs (468 published
 * fixtures): INDEX MAE 0.69, median 0.48, bias -0.12, 77% within +-1 and 95%
 * within +-2; Calculated Form MAE 0.04 and Team Power 0.12, both almost always
 * exact; probabilities MAE 1.9 points. Totals on 1,157 settled fixtures: MAE
 * 1.29 goals, median 1, bias -0.8, 66% within +-1 and 86% within +-2.
 *
 * The inputs are pre-match by construction: the fixture being priced is removed
 * from both teams' recent results and head-to-head, and its result is taken
 * back out of the league-table copy used by the model (the table in the UI
 * keeps the real standings). That correction is what makes the published form
 * and power bars reproduce almost exactly.
 *
 * Calculated markets (football only, Vitibet publishes none of them): 1/X/2 and
 * double chance come from the model probabilities, Over/Under 2.5 and both
 * teams to score from independent Poisson goals on the expected score. The
 * list shows the single highest-probability market as \"BEST\". Backtest over
 * 2026-11-14..18 (1,164 settled fixtures, `npm run backtest -- --sport
 * football`): the best pick won 74.1% against an average stated probability of
 * 78.6%. Double chance carried it (1X 76.6%, X2 78.4%, 12 66.9%); Over 2.5 won
 * 88.1%. Unders and BTTS No are still priced but never selected, because the
 * totals model runs light and those legs lost far more than they claimed.
 *
 * Totals are not published by Vitibet at all (only the 1 / 0 / 2 tip), so
 * predictTotal below is a separate, clearly calculated number: each side's
 * points are the mean of its own scoring and the opponent's defence (league
 * table, per game), with the league's home-court edge split between the two.
 * Basketball backtest over 2026-11-17..19 (280 confirmed-final games, `npm run
 * backtest`): predicted total MAE 11.9 points, median 9.0, bias -0.3, 53%
 * within +-10 and 84% within +-20 — against 14.9 for assuming a league-average
 * total. Expect around +-12 points of error on a single game.
 */

const SPORTS = {
  basketball: {
    formWindow: 6,
    formWeights: [6, 5, 4, 3, 2, 1],
    formScale: 0.52,
    homeEdge: { nba: 2.2, other: 4.4 },
    pointsMin: 30,
    pointsMax: 160,
    slope: 0.06,
    draw: { nba: 6, other: 3 },
    barSteepness: 30,
  },
  football: {
    formWindow: 6,
    formWeights: [6, 5, 4, 3, 2, 1],
    formScale: 0.3,
    homeEdge: 0.25,
    pointsMin: 0.3,
    pointsMax: 5.5,
    slope: 0.62,
    // Draw share by |INDEX|, interpolated. Fitted on 195 published fixtures.
    drawTable: [
      [0, 29],
      [0.5, 27.9],
      [1, 26.5],
      [1.5, 24],
      [1.5, 24],
      [2, 21.8],
      [2.5, 18.5],
      [3, 14.6],
      [4, 10.5],
      [4, 10.5],
      [5, 6],
      [6, 3],
      [8, 1],
    ],
    barSteepness: 2,
  },
};

const NBA_LEAGUE_ID = '12';

const config = (sport) => SPORTS[String(sport || '').toLowerCase()] || SPORTS.basketball;

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const toNumber = (value) => {
  const n = Number.parseFloat(String(value ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const normName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const barShare = (home, away, steepness) =>
  round(100 / (1 + Math.exp(-(home - away) / steepness)), 1);

const isNba = (leagueId) => String(leagueId) === NBA_LEAGUE_ID;

const homeEdge = (cfg, leagueId) =>
  typeof cfg.homeEdge === 'number' ? cfg.homeEdge : isNba(leagueId) ? cfg.homeEdge.nba : cfg.homeEdge.other;

function drawShareTable(table, magnitude) {
  if (magnitude <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i += 1) {
    const [x, y] = table[i];
    if (magnitude <= x) {
      const [px, py] = table[i - 1];
      const t = (magnitude - px) / (x - px);
      return py + t * (y - py);
    }
  }
  return table[table.length - 1][1];
}

export function probabilitiesFromIndex(index, leagueId, sport = 'basketball') {
  const cfg = config(sport);
  if (cfg.drawTable) {
    const draw = Math.round(drawShareTable(cfg.drawTable, Math.abs(index)));
    const home = Math.round((100 - draw) / (1 + Math.exp(-cfg.slope * index)));
    return { 1: `${home}%`, X: `${draw}%`, 2: `${100 - draw - home}%` };
  }
  const draw = isNba(leagueId) ? cfg.draw.nba : cfg.draw.other;
  const home = Math.round((100 - draw) / (1 + Math.exp(-cfg.slope * index)));
  return { 1: `${home}%`, X: `${draw}%`, 2: `${100 - draw - home}%` };
}

/**
 * Pick the outcome with the highest model probability. Basketball draws are
 * always the residual (3% or 6%), so this resolves to 1 or 2 on the sign of
 * the index, but reading the probabilities keeps it consistent with whatever
 * the model prints.
 */
export function pickFromProbabilities(probabilities = {}) {
  const entries = Object.entries(probabilities)
    .map(([key, pct]) => ({ key, pct, value: Number.parseFloat(pct) || 0 }))
    .sort((a, b) => b.value - a.value);
  if (!entries.length) return null;
  return {
    key: entries[0].key,
    pct: entries[0].pct,
    margin: round(entries[0].value - (entries[1]?.value ?? 0), 1),
  };
}

const poissonPmf = (lambda, k) => {
  let fact = 1;
  for (let i = 2; i <= k; i += 1) fact *= i;
  return (Math.exp(-lambda) * lambda ** k) / fact;
};

/**
 * Markets Vitibet never publishes, priced from the model's own 1/X/2 split
 * and expected score. Independent Poisson goals is a deliberate
 * simplification: it ranks markets sensibly on this data, it is not a trading
 * model, and the list labels the result as calculated.
 */
export function marketPrices({ probabilities = {}, prediction = null } = {}) {
  const num = (value) => Number.parseFloat(value) || 0;
  const p1 = num(probabilities['1']);
  const pX = num(probabilities.X);
  const p2 = num(probabilities['2']);

  const markets = [
    { key: '1', label: '1', pct: round(p1, 1) },
    { key: 'X', label: 'X', pct: round(pX, 1) },
    { key: '2', label: '2', pct: round(p2, 1) },
    { key: '1X', label: '1X', pct: round(p1 + pX, 1) },
    { key: 'X2', label: 'X2', pct: round(pX + p2, 1) },
    { key: '12', label: '12', pct: round(p1 + p2, 1) },
  ];

  const home = Number(prediction?.home);
  const away = Number(prediction?.away);
  if (Number.isFinite(home) && Number.isFinite(away) && home > 0 && away > 0) {
    const lambda = home + away;
    const under25 = poissonPmf(lambda, 0) + poissonPmf(lambda, 1) + poissonPmf(lambda, 2);
    const btts = (1 - Math.exp(-home)) * (1 - Math.exp(-away));
    markets.push(
      { key: 'O2.5', label: 'Over 2.5', pct: round(100 * (1 - under25), 1) },
      { key: 'U2.5', label: 'Under 2.5', pct: round(100 * under25, 1) },
      { key: 'GG', label: 'BTTS Yes', pct: round(100 * btts, 1) },
      { key: 'NG', label: 'BTTS No', pct: round(100 * (1 - btts), 1) }
    );
  }

  // Unders and \"both teams to score: no\" stay priced (the tooltip lists every
  // market) but are never the headline pick: the totals model runs 0.8 goals
  // light on settled fixtures, so the low-goal side is structurally
  // overpriced. Backtesting the highest-probability rule, Unders landed 27%
  // against an average stated 78% and BTTS No lost all three times it was
  // selected, while Over 2.5 landed 88%.
  const choices = markets.filter((market) => market.key !== 'U2.5' && market.key !== 'NG');
  const best = choices.length ? { ...choices.reduce((a, b) => (b.pct > a.pct ? b : a)) } : null;
  return { markets, best };
}

function recentMargins(matches = [], cfg = SPORTS.basketball) {
  return matches
    .map((match) =>
      toNumber(match?.margin ?? (match?.score ? match.score.split(/[:\-]/).reduce((a, b) => a - b) : null))
    )
    .filter((margin) => margin != null)
    .slice(0, cfg.formWindow);
}

function weightedForm(matches, cfg) {
  const margins = recentMargins(matches, cfg);
  if (!margins.length) return null;
  const weights = cfg.formWeights.slice(0, margins.length);
  const total = weights.reduce((a, b) => a + b, 0);
  const average = margins.reduce((sum, margin, i) => sum + margin * weights[i], 0) / total;
  return round(average * cfg.formScale);
}

function recordDiff(row) {
  if (!row) return null;
  const games = toNumber(row.played);
  const match = /(\d+)\s*:\s*(\d+)/.exec(row.score || '');
  if (!games || !match) return null;
  const scored = Number(match[1]);
  const conceded = Number(match[2]);
  if (!scored && !conceded) return null;
  return (scored - conceded) / games;
}

function findRow(table, tabKey, teamName) {
  const tab = table?.tabs?.find((entry) => entry.key === tabKey);
  if (!tab) return null;
  const wanted = normName(teamName);
  return tab.rows.find((row) => normName(row.team) === wanted) || null;
}

function teamPower(table, teamName, side, matches, leagueId, cfg) {
  const overall = recordDiff(findRow(table, 'total', teamName));
  const venue = recordDiff(findRow(table, side, teamName));
  const edge = homeEdge(cfg, leagueId);
  const homeCourt = side === 'home' ? edge : -edge;

  if (overall == null && venue == null) {
    const margins = recentMargins(matches, cfg);
    if (!margins.length) return null;
    return round(margins.reduce((a, b) => a + b, 0) / margins.length + homeCourt);
  }

  return round((overall ?? venue) + homeCourt);
}

function pointsPerGame(row, cfg) {
  if (!row) return null;
  const games = toNumber(row.played);
  const match = /(\d+)\s*:\s*(\d+)/.exec(row.score || '');
  if (!games || !match) return null;
  const scored = Number(match[1]) / games;
  const conceded = Number(match[2]) / games;
  if (!(scored > cfg.pointsMin && scored < cfg.pointsMax)) return null;
  if (!(conceded > cfg.pointsMin && conceded < cfg.pointsMax)) return null;
  return { pf: scored, pa: conceded, games };
}

function recentPoints(matches = [], cfg) {
  const scored = [];
  const conceded = [];
  for (const match of matches.slice(0, cfg.formWindow)) {
    const parts = /(\d+)\s*[:\-]\s*(\d+)/.exec(match?.score || '');
    if (!parts) continue;
    scored.push(Number(parts[1]));
    conceded.push(Number(parts[2]));
  }
  if (scored.length < 3) return null;
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  return { pf: mean(scored), pa: mean(conceded), games: scored.length };
}

function teamPoints(table, matches, name, cfg) {
  if (!name) return null;
  return pointsPerGame(findRow(table, 'total', name), cfg) || recentPoints(matches, cfg);
}

/**
 * Expected total points (goals for football) for a match. Vitibet publishes no
 * total, so this is a calculation, not a copy: each side projects to the mean
 * of its own scoring rate and the opponent's conceding rate, with the league
 * home edge split across the two teams.
 */
export function predictTotal({
  table = null,
  lastMatches = [],
  homeName = null,
  awayName = null,
  leagueId = null,
  sport = 'basketball',
}) {
  const cfg = config(sport);
  const group = (name) => lastMatches.find((team) => normName(team.name) === normName(name));
  const home = teamPoints(table, group(homeName)?.matches || [], homeName, cfg);
  const away = teamPoints(table, group(awayName)?.matches || [], awayName, cfg);
  if (!home || !away) return null;

  const edge = homeEdge(cfg, leagueId);
  // Football goals are shrunk toward a three-goal match. Team rates built on a
  // handful of games (or a thin lower-league table) otherwise produce
  // implausible 1.4-goal expectations, and those were the matches where an
  // 80%-confident Under landed only a third of the time. Measured on 1,164
  // settled fixtures the shrink leaves total error unchanged (MAE 1.29) while
  // removing that tail; the edge is applied after shrinking so it is not
  // damped.
  const shrink = (value) => (cfg === SPORTS.football ? 1.5 + 0.7 * (value - 1.5) : value);
  const homePoints = shrink((home.pf + away.pa) / 2) + edge / 2;
  const awayPoints = shrink((away.pf + home.pa) / 2) - edge / 2;

  return {
    home: round(homePoints, 1),
    away: round(awayPoints, 1),
    total: Math.round(homePoints + awayPoints),
    estimated: true,
    sample: { home: home.games, away: away.games },
  };
}

/**
 * Rebuild the Vitisport analytics block for a match whose page has none.
 * Returns null when the page does not carry enough data to estimate it.
 */
export function estimateAnalytics({
  lastMatches = [],
  table = null,
  leagueId = null,
  homeName = null,
  awayName = null,
  sport = 'basketball',
  prediction = null,
}) {
  const cfg = config(sport);
  const pick = (name, fallbackIndex) =>
    (name && lastMatches.find((team) => normName(team.name) === normName(name))) || lastMatches[fallbackIndex];
  const homeTeam = pick(homeName, 0);
  const awayTeam = pick(awayName, 1);
  if (!homeTeam || !awayTeam) return null;

  const formHome = weightedForm(homeTeam.matches, cfg);
  const formAway = weightedForm(awayTeam.matches, cfg);
  const powerHome = teamPower(table, homeTeam.name, 'home', homeTeam.matches, leagueId, cfg);
  const powerAway = teamPower(table, awayTeam.name, 'away', awayTeam.matches, leagueId, cfg);

  if ([formHome, formAway, powerHome, powerAway].some((value) => value == null)) return null;

  const index = round(formHome + powerHome - (formAway + powerAway));
  const homeShare = barShare(formHome, formAway, cfg.barSteepness);
  const powerShare = barShare(powerHome, powerAway, cfg.barSteepness);
  const probabilities = probabilitiesFromIndex(index, leagueId, cfg === SPORTS.football ? 'football' : 'basketball');
  const pricing = cfg === SPORTS.football ? marketPrices({ probabilities, prediction }) : null;

  return {
    index: index.toFixed(2),
    indexValue: index,
    probabilities,
    pick: pickFromProbabilities(probabilities),
    markets: pricing?.markets ?? null,
    best: pricing?.best ?? null,
    form: {
      label: 'Calculated Form',
      home: formHome.toFixed(2),
      away: formAway.toFixed(2),
      homePct: homeShare,
      awayPct: round(100 - homeShare, 1),
    },
    power: {
      label: 'Team Power',
      home: powerHome.toFixed(2),
      away: powerAway.toFixed(2),
      homePct: powerShare,
      awayPct: round(100 - powerShare, 1),
    },
    estimated: true,
    sample: {
      home: recentMargins(homeTeam.matches, cfg).length,
      away: recentMargins(awayTeam.matches, cfg).length,
    },
  };
}
