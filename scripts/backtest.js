#!/usr/bin/env node
/**
 * Backtest the reconstructed Vitisport analytics against what Vitibet published.
 *
 * For every match on the given days that has a published INDEX, the script
 * rebuilds the analytics block from the match page's own inputs (recent
 * results + league table) and compares:
 *
 *   - the calculated INDEX with the published INDEX,
 *   - calculated form / team power with the published bars,
 *   - calculated 1 / 0 / 2 probabilities with the published ones,
 *   - the calculated pick with the published tip,
 *   - on finished games, whether the calculated pick actually won,
 *   - and the calculated total points (predictTotal) against the actual total.
 *
 * Totals are scored on every settled game of the chosen days, including the
 * matches Vitibet leaves untipped, so that sample is not limited to fixtures
 * the site is confident about. Index/form/power/pick numbers still only use
 * matches with a published analytics block.
 *
 * Usage:
 *   node scripts/backtest.js                          # previous three days
 *   node scripts/backtest.js 2026-11-16 2026-11-17    # explicit days
 *   node scripts/backtest.js --concurrency 10 --save backtest.json
 *   node scripts/backtest.js --sport football 2026-11-18 2026-11-19
 *
 * Football reuses every check above; only the window sizes differ (the index
 * is on a goal scale and a total is a handful of goals, so ±0.5/±1/±2 for the
 * index and ±1/±2/±3 for totals replace the basketball windows). Draws count
 * as a third outcome there, so an X pick is scored instead of skipped.
 */

import { fetchDay, fetchMatch, normalizeSport } from '../lib/scrape.js';
import { estimateAnalytics } from '../lib/analytics.js';

const argv = process.argv.slice(2);
const positional = [];
let concurrency = 8;
let savePath = null;
let sport = 'basketball';

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--concurrency' || arg === '-c') {
    concurrency = Number.parseInt(argv[++i], 10) || concurrency;
  } else if (arg === '--save' || arg === '-s') {
    savePath = argv[++i] || null;
  } else if (arg === '--sport') {
    sport = normalizeSport(argv[++i]);
  } else if (!arg.startsWith('-')) {
    positional.push(arg);
  }
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const shiftDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

const today = isoDay(new Date());
const dates = positional.length
  ? positional
  : [-3, -2, -1].map((offset) => shiftDays(today, offset));

const toNumber = (value) => {
  const n = Number.parseFloat(String(value ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const pct = (value) => toNumber(value);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fixed = (value, digits = 2) => (value == null ? '–' : value.toFixed(digits));

/* ---------------- collect candidates ---------------- */

const candidates = [];
const perDate = [];
const seen = new Set();

for (const date of dates) {
  const day = await fetchDay(date, sport);
  const all = day.leagues.flatMap((league) => league.matches);
  const published = all.filter((match) => match.tip && match.indexValue != null && match.fixtureId);
  const settled = all.filter(
    (match) =>
      match.status === 'finished' &&
      match.homeScore != null &&
      match.awayScore != null &&
      match.fixtureId
  );
  perDate.push({ date, fixtures: all.length, published: published.length, settled: settled.length });
  for (const match of [...published, ...settled]) {
    const key = `${match.fixtureId}:${match.leagueId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ date, match });
  }
  console.error(
    `${date}: ${all.length} fixtures, ${published.length} with a published INDEX, ${settled.length} settled`
  );
}

if (!candidates.length) {
  console.error('No matches to backtest.');
  process.exit(1);
}

/* ---------------- rebuild and compare ---------------- */

const rows = [];
const skipped = { noPublished: 0, noEstimate: 0, error: 0 };
let cursor = 0;
let finished = 0;
let notFinal = 0;
const started = Date.now();

async function worker() {
  while (cursor < candidates.length) {
    const { date, match } = candidates[cursor++];
    try {
      const detail = await fetchMatch(match.fixtureId, match.leagueId, sport);
      const published = detail.analytics;
      const hasPublished = Boolean(published && !published.estimated);

      // Rebuild our own block for every readable match, not only the ones
      // Vitibet tipped, so the best-market pick is scored on the full sample.
      const estimated =
        estimateAnalytics({
          lastMatches: detail.lastMatches,
          table: detail.modelTable ?? detail.table,
          leagueId: match.leagueId,
          homeName: detail.home?.name,
          awayName: detail.away?.name,
          sport,
          prediction: detail.prediction,
        }) || null;

      // A page with neither a published block nor a calculable total adds nothing.
      if (!hasPublished && !detail.prediction) {
        skipped.noPublished += 1;
        continue;
      }
      if (hasPublished && !estimated) skipped.noEstimate += 1;

      const publishedIndex = hasPublished ? toNumber(published.index) : null;
      const homeScore = toNumber(detail.homeScore);
      const awayScore = toNumber(detail.awayScore);
      // Games still in progress show a quarter score and a badge like "Q2 8'"
      // (and the odd abandoned fixture sits at 0:0), so a total is only
      // scored when the page itself says the game is final.
      const finalBadge = String(detail.badge || match.badge || '').trim();
      const isFinal = /^ft\b/i.test(finalBadge);
      const isSettled = isFinal && homeScore > 0 && awayScore > 0;
      const result = isSettled ? (homeScore === awayScore ? 'X' : homeScore > awayScore ? '1' : '2') : null;
      const hasResult = result != null;
      if (!isSettled && (homeScore != null || match.homeScore != null)) notFinal += 1;
      const predictedTotal = detail.prediction?.total ?? null;
      const actualTotal = isSettled ? homeScore + awayScore : null;

      const publishedProbs = {
        1: pct(published?.probabilities?.['1']),
        X: pct(published?.probabilities?.X ?? published?.probabilities?.['0']),
        2: pct(published?.probabilities?.['2']),
      };
      const calcProbs = {
        1: pct(estimated?.probabilities?.['1']),
        X: pct(estimated?.probabilities?.X),
        2: pct(estimated?.probabilities?.['2']),
      };
      const probErrors = Object.keys(calcProbs)
        .filter((key) => calcProbs[key] != null && publishedProbs[key] != null)
        .map((key) => Math.abs(calcProbs[key] - publishedProbs[key]));

      const tip = String(match.tip || '').trim().toUpperCase();

      rows.push({
        fixtureId: match.fixtureId,
        date,
        league: match.leagueName,
        home: match.home,
        away: match.away,
        hasPublishedAnalytics: hasPublished,
        publishedIndex,
        calculatedIndex: estimated?.indexValue ?? null,
        indexError:
          publishedIndex == null || estimated?.indexValue == null
            ? null
            : estimated.indexValue - publishedIndex,
        publishedForm: {
          home: toNumber(published?.form?.home),
          away: toNumber(published?.form?.away),
        },
        calculatedForm: {
          home: toNumber(estimated?.form?.home),
          away: toNumber(estimated?.form?.away),
        },
        publishedPower: {
          home: toNumber(published?.power?.home),
          away: toNumber(published?.power?.away),
        },
        calculatedPower: {
          home: toNumber(estimated?.power?.home),
          away: toNumber(estimated?.power?.away),
        },
        publishedProbabilities: publishedProbs,
        calculatedProbabilities: calcProbs,
        probabilityError: probErrors.length ? Math.max(...probErrors) : null,
        publishedPick: tip || null,
        calculatedPick: estimated?.pick?.key ?? null,
        calculatedPct: estimated?.pick?.pct ?? null,
        predictedTotal,
        totalSample: detail.prediction?.sample
          ? Math.min(detail.prediction.sample.home ?? 0, detail.prediction.sample.away ?? 0)
          : null,
        expectedScore: detail.prediction
          ? { home: detail.prediction.home, away: detail.prediction.away }
          : null,
        actualTotal,
        homeScore,
        awayScore,
        bestPick: estimated?.best?.key ?? null,
        bestLabel: estimated?.best?.label ?? null,
        bestPct: estimated?.best?.pct ?? null,
        markets: estimated?.markets ?? null,
        totalError:
          predictedTotal == null || actualTotal == null ? null : predictedTotal - actualTotal,
        result,
      });

      finished += isSettled ? 1 : 0;
      if (rows.length % 20 === 0) {
        console.error(`  ${rows.length} compared (${skipped.noPublished + skipped.noEstimate + skipped.error} skipped)`);
      }
    } catch (error) {
      skipped.error += 1;
      console.error(`  ! ${match.fixtureId} ${match.home} vs ${match.away}: ${error?.message || error}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

/* ---------------- summary ---------------- */

const pairs = (calculated, published) =>
  [['home', calculated.home, published.home], ['away', calculated.away, published.away]]
    .filter(([, a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .map(([, a, b]) => Math.abs(a - b));

const absIndex = rows
  .map((row) => (row.indexError == null ? null : Math.abs(row.indexError)))
  .filter((value) => value != null);
const signedIndex = rows.map((row) => row.indexError).filter((value) => value != null);
const absForm = rows.flatMap((row) => pairs(row.calculatedForm, row.publishedForm));
const absPower = rows.flatMap((row) => pairs(row.calculatedPower, row.publishedPower));
const absProbs = rows.map((row) => row.probabilityError).filter((value) => value != null);
const totalErrors = rows.map((row) => row.totalError).filter((value) => value != null);
const absTotal = totalErrors.map((value) => Math.abs(value));
const totalWithin = (limit) => absTotal.filter((value) => value <= limit).length;

const share = (count, total) => (total ? `${((count / total) * 100).toFixed(1)}%` : '–');
const within = (limit) => absIndex.filter((value) => value <= limit).length;

const drawScores = sport === 'football';
const scoreable = (pick) => drawScores || pick !== 'X';

const pickRows = rows.filter((row) => row.calculatedPick);
// Only matches Vitibet tipped can agree or disagree with its tip.
const comparedPickRows = pickRows.filter((row) => row.publishedPick);
const agreed = comparedPickRows.filter((row) => row.calculatedPick === row.publishedPick);
const contested = pickRows.filter(
  (row) =>
    row.publishedPick &&
    row.calculatedPick !== row.publishedPick &&
    row.result &&
    scoreable(row.calculatedPick)
);
const settledCalc = pickRows.filter((row) => row.result && scoreable(row.calculatedPick));
const settledTip = pickRows.filter(
  (row) => row.result && row.publishedPick && (drawScores || ['1', '2'].includes(row.publishedPick))
);
const calcWins = settledCalc.filter((row) => row.calculatedPick === row.result);
const tipWins = settledTip.filter((row) => row.publishedPick === row.result);
const contestedCalcWins = contested.filter((row) => row.calculatedPick === row.result);
const contestedTipWins = contested.filter((row) => row.publishedPick === row.result);
// The same matches, both models, so the two win rates are comparable.
const overlap = pickRows.filter((row) => row.result && row.publishedPick && scoreable(row.calculatedPick));
const overlapCalcWins = overlap.filter((row) => row.calculatedPick === row.result);
const overlapTipWins = overlap.filter((row) => row.publishedPick === row.result);

const marketHit = (key, row) => {
  if (key === '1X') return row.result === '1' || row.result === 'X';
  if (key === 'X2') return row.result === 'X' || row.result === '2';
  if (key === '12') return row.result === '1' || row.result === '2';
  if (key === 'O2.5') return row.actualTotal > 2.5;
  if (key === 'U2.5') return row.actualTotal < 2.5;
  if (key === 'GG') return row.homeScore > 0 && row.awayScore > 0;
  if (key === 'NG') return !(row.homeScore > 0 && row.awayScore > 0);
  return row.result === key;
};

const bestRows = rows.filter((row) => row.bestPick && row.result);
const bestHits = bestRows.filter((row) => marketHit(row.bestPick, row));
const bestMarkets = new Map();
for (const row of bestRows) {
  const entry = bestMarkets.get(row.bestPick) || { n: 0, hits: 0, pct: [] };
  entry.n += 1;
  if (marketHit(row.bestPick, row)) entry.hits += 1;
  if (row.bestPct != null) entry.pct.push(row.bestPct);
  bestMarkets.set(row.bestPick, entry);
}
const bestByMarket = [...bestMarkets]
  .map(([key, entry]) => ({
    key,
    matches: entry.n,
    hits: entry.hits,
    hitRate: share(entry.hits, entry.n),
    averageProbability: mean(entry.pct),
  }))
  .sort((a, b) => b.matches - a.matches);
const bestAverageProbability = mean(bestRows.map((row) => row.bestPct).filter((value) => value != null));
const settledRows = rows.filter((row) => row.result);
const actualTotalMean = mean(rows.map((row) => row.actualTotal).filter((value) => value != null));

const leagueStats = new Map();
for (const row of rows) {
  const key = String(row.league || 'Unknown').split(':').pop().trim() || 'Unknown';
  const entry = leagueStats.get(key) || { index: [], total: [] };
  if (row.indexError != null) entry.index.push(Math.abs(row.indexError));
  if (row.totalError != null) entry.total.push(Math.abs(row.totalError));
  leagueStats.set(key, entry);
}
const leagues = [...leagueStats]
  .map(([name, entry]) => ({
    name,
    matches: entry.index.length,
    meanAbsoluteError: mean(entry.index),
    worstError: entry.index.length ? Math.max(...entry.index) : null,
    totalMatches: entry.total.length,
    totalMeanAbsoluteError: mean(entry.total),
    totalWorstError: entry.total.length ? Math.max(...entry.total) : null,
  }))
  .sort((a, b) => (b.meanAbsoluteError ?? 0) - (a.meanAbsoluteError ?? 0));

const summary = {
  generatedAt: new Date().toISOString(),
  sport,
  dates,
  seconds: Math.round((Date.now() - started) / 1000),
  matchesCompared: rows.length,
  publishedCompared: rows.filter((row) => row.hasPublishedAnalytics).length,
  finishedWithResult: finished,
  excludedNotFinal: notFinal,
  skipped,
  index: {
    meanAbsoluteError: mean(absIndex),
    medianAbsoluteError: median(absIndex),
    meanSignedError: mean(signedIndex),
    exact: absIndex.filter((value) => value < 0.005).length,
    withinHalf: absIndex.filter((value) => value <= 0.5).length,
    within1: within(1),
    within2: absIndex.filter((value) => value <= 2).length,
    within3: within(3),
    within5: within(5),
    within10: within(10),
  },
  form: { meanAbsoluteError: mean(absForm), medianAbsoluteError: median(absForm) },
  power: { meanAbsoluteError: mean(absPower), medianAbsoluteError: median(absPower) },
  probabilities: { meanAbsoluteError: mean(absProbs), maxError: absProbs.length ? Math.max(...absProbs) : null },
  totals: {
    matches: absTotal.length,
    meanAbsoluteError: mean(absTotal),
    medianAbsoluteError: median(absTotal),
    meanSignedError: mean(totalErrors),
    within1: totalWithin(1),
    within2: totalWithin(2),
    within3: totalWithin(3),
    within5: totalWithin(5),
    within10: totalWithin(10),
    within20: totalWithin(20),
  },
  bestPick: {
    matches: bestRows.length,
    hits: bestHits.length,
    hitRate: share(bestHits.length, bestRows.length),
    averageProbability: bestAverageProbability,
    byMarket: bestByMarket,
  },
  picks: {
    agreeWithPublished: `${agreed.length}/${comparedPickRows.length}`,
    agreeShare: share(agreed.length, comparedPickRows.length),
    calculatedWinRate: share(calcWins.length, settledCalc.length),
    publishedWinRate: share(tipWins.length, settledTip.length),
    sameMatches: overlap.length,
    sameMatchesCalculated: share(overlapCalcWins.length, overlap.length),
    sameMatchesPublished: share(overlapTipWins.length, overlap.length),
    contested: contested.length,
    contestedCalculatedWins: share(contestedCalcWins.length, contested.length),
    contestedPublishedWins: share(contestedTipWins.length, contested.length),
  },
  leagues,
  rows,
};

console.log('');
console.log(`Backtest — ${sport} — ${dates.join(', ')}  (${summary.seconds}s, ${concurrency} workers)`);
for (const entry of perDate) {
  console.log(
    `  ${entry.date}: ${entry.published} with a published tip/index, ${entry.settled} settled, of ${entry.fixtures} fixtures`
  );
}
console.log(
  `  compared ${rows.length} matches (${summary.publishedCompared} with published analytics, ${notFinal} live/partial excluded)` +
    (skipped.noPublished || skipped.noEstimate || skipped.error
      ? ` · skipped ${skipped.noPublished} without published analytics, ${skipped.noEstimate} without enough data, ${skipped.error} errors`
      : '')
);
console.log('');
console.log('INDEX');
console.log(
  `  MAE ${fixed(mean(absIndex))}   median ${fixed(median(absIndex))}   bias ${fixed(mean(signedIndex))}`
);
const indexTicks =
  sport === 'football'
    ? [['±0.5', 0.5], ['±1', 1], ['±2', 2]]
    : [['±1', 1], ['±3', 3], ['±5', 5], ['±10', 10]];
console.log(
  `  exact ${summary.index.exact} (${share(summary.index.exact, absIndex.length)})` +
    indexTicks
      .map(([label, limit]) => `   ${label} ${within(limit)} (${share(within(limit), absIndex.length)})`)
      .join('')
);
console.log('');
console.log('BARS');
console.log(`  Calculated Form  MAE ${fixed(mean(absForm))}   median ${fixed(median(absForm))}`);
console.log(`  Team Power       MAE ${fixed(mean(absPower))}   median ${fixed(median(absPower))}`);
console.log(
  `  Probabilities    MAE ${fixed(mean(absProbs), 1)} pts   worst ${fixed(absProbs.length ? Math.max(...absProbs) : null, 1)} pts`
);
console.log('');
console.log('PICK');
console.log(`  Agrees with the published tip: ${summary.picks.agreeWithPublished} (${summary.picks.agreeShare})`);
console.log(
  `  Calculated pick won: ${calcWins.length}/${settledCalc.length} (${share(calcWins.length, settledCalc.length)})` +
    `   published tip won: ${tipWins.length}/${settledTip.length} (${share(tipWins.length, settledTip.length)})`
);
console.log(
  `  Same matches (${overlap.length}): ours ${overlapCalcWins.length} (${share(overlapCalcWins.length, overlap.length)})` +
    ` vs published ${overlapTipWins.length} (${share(overlapTipWins.length, overlap.length)})`
);
console.log(
  `  Where the pick differs (${contested.length}): calculated ${share(contestedCalcWins.length, contested.length)}` +
    ` vs published ${share(contestedTipWins.length, contested.length)}`
);

if (settledRows.length) {
  const split = ['1', 'X', '2']
    .map((key) => `${key} ${share(settledRows.filter((row) => row.result === key).length, settledRows.length)}`)
    .join(' · ');
  console.log('');
  console.log(`RESULTS (${settledRows.length} settled)  ${split}   mean actual total ${fixed(actualTotalMean)}`);
}

if (bestRows.length) {
  console.log('');
  console.log('BEST PICK (highest-probability calculated market, settled games)');
  console.log(
    `  Won ${bestHits.length}/${bestRows.length} (${share(bestHits.length, bestRows.length)})` +
      `   average stated probability ${fixed(bestAverageProbability, 1)}%`
  );
  for (const market of bestByMarket) {
    console.log(
      `  ${market.key.padEnd(6)} ${String(`${market.hits}/${market.matches}`).padStart(7)}` +
        `  ${market.hitRate.padStart(6)}   average ${fixed(market.averageProbability, 1)}%`
    );
  }
}

console.log('');
const totalTicks =
  sport === 'football'
    ? [['±1', 1], ['±2', 2], ['±3', 3]]
    : [['±5', 5], ['±10', 10], ['±20', 20]];
console.log(`TOTAL ${sport === 'football' ? 'GOALS' : 'POINTS'} (calculated vs actual, settled games)`);
console.log(
  `  MAE ${fixed(mean(absTotal))}   median ${fixed(median(absTotal))}   bias ${fixed(mean(totalErrors))}` +
    totalTicks
      .map(([label, limit]) => `   ${label} ${share(totalWithin(limit), absTotal.length)}`)
      .join('')
);
console.log(`  sample ${absTotal.length} settled matches (tipped and untipped)`);

console.log('');
console.log('INDEX / TOTAL by league');
for (const league of leagues.filter((entry) => entry.matches >= 3 || entry.totalMatches >= 3)) {
  const indexPart = league.matches
    ? `INDEX MAE ${fixed(league.meanAbsoluteError).padStart(5)} worst ${fixed(league.worstError).padStart(5)} (${league.matches})`
    : 'INDEX –';
  const totalPart = league.totalMatches
    ? `TOTAL MAE ${fixed(league.totalMeanAbsoluteError).padStart(5)} worst ${fixed(league.totalWorstError).padStart(5)} (${league.totalMatches})`
    : 'TOTAL –';
  console.log(`  ${league.name.slice(0, 28).padEnd(29)} ${indexPart.padEnd(40)} ${totalPart}`);
}

const worstTotals = [...rows]
  .filter((row) => row.totalError != null)
  .sort((a, b) => Math.abs(b.totalError) - Math.abs(a.totalError))
  .slice(0, 6);
if (worstTotals.length) {
  console.log('');
  console.log('Largest TOTAL misses');
  for (const row of worstTotals) {
    console.log(
      `  ${row.predictedTotal} vs ${row.actualTotal} (${row.totalError > 0 ? '+' : ''}${row.totalError})` +
        `  ${row.home} vs ${row.away} · ${row.league}`
    );
  }
}

const worst = [...rows]
  .filter((row) => row.indexError != null)
  .sort((a, b) => Math.abs(b.indexError) - Math.abs(a.indexError))
  .slice(0, 8);
if (worst.length) {
  console.log('');
  console.log('Largest INDEX misses');
  for (const row of worst) {
    console.log(
      `  ${fixed(row.publishedIndex)} vs ${fixed(row.calculatedIndex)} (${row.indexError > 0 ? '+' : ''}${fixed(row.indexError)})` +
        `  ${row.home} vs ${row.away} · ${row.league}`
    );
  }
}

if (savePath) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(savePath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log('');
  console.log(`Saved detailed results to ${savePath}`);
}
