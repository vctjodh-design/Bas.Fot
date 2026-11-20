/**
 * Neural model for complete football matches.
 *
 * The database stores pre-match features plus the final score. This module
 * turns every complete fixture into a fixed feature vector, fits a small
 * multi-head MLP (1X2, BTTS, over/under 2.5, total goals, home/away goals) and
 * derives the most likely correct score from a Poisson scoreline layer.
 *
 * The sample is deliberately small (only complete processed matches are used),
 * so training reports cross-validated metrics instead of pretending a holdout
 * is statistically strong.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDatabase, DATA_DIR } from './store.js';

const MODEL_FILE = path.join(DATA_DIR, 'ml-model.json');
const VERSION = 1;
const FEATURE_NAMES = [
  'league_avg_goals',
  'calc_index',
  'calc_p1',
  'calc_px',
  'calc_p2',
  'calc_total',
  'calc_exp_home',
  'calc_exp_away',
  'calc_form_home',
  'calc_form_away',
  'calc_form_diff',
  'calc_power_home',
  'calc_power_away',
  'calc_power_diff',
  'vit_index',
  'vit_p1',
  'vit_px',
  'vit_p2',
  'vit_published',
  'community_picks',
  'league_recent_matches',
  'league_home_win',
  'league_draw',
  'league_away_win',
  'league_btts',
  'league_over25',
  'league_recent_goals',
  'home_ppg',
  'home_gdpg',
  'home_gfpg',
  'home_gapg',
  'home_win_rate',
  'home_btts',
  'home_clean_sheets',
  'home_over25',
  'home_form_pts',
  'home_recent_gf',
  'home_recent_ga',
  'away_ppg',
  'away_gdpg',
  'away_gfpg',
  'away_gapg',
  'away_win_rate',
  'away_btts',
  'away_clean_sheets',
  'away_over25',
  'away_form_pts',
  'away_recent_gf',
  'away_recent_ga',
];

const num = (value) => {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const normName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
};

const scorePair = (value) => {
  const match = /(\d+)\s*[:–-]\s*(\d+)/.exec(String(value || ''));
  return match ? { for: Number(match[1]), against: Number(match[2]) } : null;
};

const formPoints = (form = []) => {
  const values = form
    .map((item) => String(item).toUpperCase())
    .map((item) => (item === 'W' ? 3 : item === 'D' ? 1 : item === 'L' ? 0 : null))
    .filter((value) => value != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
};

function recentStats(team, fx, side) {
  const opponent = side === 'home' ? fx.away : fx.home;
  const ownScore = side === 'home' ? fx.score?.home : fx.score?.away;
  const otherScore = side === 'home' ? fx.score?.away : fx.score?.home;
  const matchScore = `${fx.score?.home}:${fx.score?.away}`;
  const recent = (team.recent || []).filter(
    (match) =>
      !(
        normName(match.opponent) === normName(opponent) &&
        String(match.score || '').replace(/\s/g, '') === matchScore
      )
  );
  const goalsFor = [];
  const goalsAgainst = [];
  for (const match of recent.slice(0, 5)) {
    const pair = scorePair(match.score);
    if (!pair) continue;
    const isHome = match.venue === 'H';
    goalsFor.push(isHome ? pair.for : pair.against);
    goalsAgainst.push(isHome ? pair.against : pair.for);
  }
  if (!goalsFor.length) return { gf: null, ga: null };
  return {
    gf: goalsFor.reduce((sum, value) => sum + value, 0) / goalsFor.length,
    ga: goalsAgainst.reduce((sum, value) => sum + value, 0) / goalsAgainst.length,
  };
}

function preMatchTeam(team, fx, side) {
  if (!team || team.available === false) return null;
  const completed =
    fx.status === 'finished' &&
    Number.isFinite(Number(fx.score?.home)) &&
    Number.isFinite(Number(fx.score?.away));
  const postPlayed = num(team.played);
  // Stored training rows are post-match, so remove the current result. A
  // clicked scheduled/live fixture has no final result to remove; its team
  // profile is already the pre-match picture.
  const played = completed && postPlayed && postPlayed > 1 ? postPlayed - 1 : postPlayed;
  if (!played) return null;

  const ownScore = side === 'home' ? fx.score?.home : fx.score?.away;
  const otherScore = side === 'home' ? fx.score?.away : fx.score?.home;
  const win = completed && ownScore > otherScore;
  const draw = completed && ownScore === otherScore;

  const postWins = num(team.wins) || 0;
  const postDraws = num(team.draws) || 0;
  const postLosses = num(team.losses) || 0;
  const wins = Math.max(0, postWins - (completed && win ? 1 : 0));
  const draws = Math.max(0, postDraws - (completed && draw ? 1 : 0));
  const losses = Math.max(0, postLosses - (completed && !win && !draw ? 1 : 0));
  const points = Math.max(0, (num(team.points) || 0) - (completed ? (win ? 3 : draw ? 1 : 0) : 0));
  const goals = scorePair(team.goals || '');
  const goalsFor = Math.max(0, (goals?.for || 0) - (completed ? ownScore || 0 : 0));
  const goalsAgainst = Math.max(0, (goals?.against || 0) - (completed ? otherScore || 0 : 0));
  const adjust = (pct, hit) => {
    if (pct == null) return null;
    if (!completed) return clamp(Number(pct) / 100, 0, 1);
    if (!postPlayed) return null;
    const count = (Number(pct) / 100) * postPlayed;
    return clamp((count - (hit ? 1 : 0)) / played, 0, 1);
  };
  const recent = recentStats(team, fx, side);
  const form = fx.form?.[side] || team.form || [];

  return {
    ppg: (wins * 3 + draws) / played,
    gdpg: (goalsFor - goalsAgainst) / played,
    gfpg: goalsFor / played,
    gapg: goalsAgainst / played,
    winRate: wins / played,
    btts: adjust(team.bttsPct, ownScore > 0 && otherScore > 0),
    cleanSheets: adjust(team.cleanSheetPct, otherScore === 0),
    over25: adjust(team.over25Pct, (ownScore || 0) + (otherScore || 0) > 2.5),
    formPoints: formPoints(form),
    recentGf: recent.gf,
    recentGa: recent.ga,
  };
}

function leagueRecent(fx) {
  const rows = (fx.league?.recentMatches || []).filter(
    (match) => String(match.fixtureId || '') !== String(fx.fixtureId || '')
  );
  if (!rows.length) return null;
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let btts = 0;
  let over25 = 0;
  let goals = 0;
  for (const match of rows) {
    const home = match.homeScore ?? scorePair(match.score)?.for;
    const away = match.awayScore ?? scorePair(match.score)?.against;
    if (!Number.isFinite(Number(home)) || !Number.isFinite(Number(away))) continue;
    const h = Number(home);
    const a = Number(away);
    if (h > a) homeWins += 1;
    else if (h === a) draws += 1;
    else awayWins += 1;
    if (h > 0 && a > 0) btts += 1;
    if (h + a > 2.5) over25 += 1;
    goals += h + a;
  }
  const sample = rows.length;
  return {
    sample,
    homeWin: homeWins / sample,
    draw: draws / sample,
    awayWin: awayWins / sample,
    btts: btts / sample,
    over25: over25 / sample,
    avgGoals: goals / sample,
  };
}

function probabilities(value) {
  const entries = ['1', 'X', '2'].map((key) => num(value?.[key]));
  if (entries.some((entry) => entry == null)) return [null, null, null];
  const sum = entries.reduce((total, entry) => total + entry, 0) || 1;
  return entries.map((entry) => entry / sum);
}

/** Fixed feature vector built only from information available before kick-off. */
export function featuresForFixture(fx, { requireResult = true } = {}) {
  const hasResult =
    fx?.score &&
    Number.isFinite(Number(fx.score.home)) &&
    Number.isFinite(Number(fx.score.away));
  if (requireResult && !hasResult) return null;
  const home = preMatchTeam(fx.teamContext?.home, fx, 'home');
  const away = preMatchTeam(fx.teamContext?.away, fx, 'away');
  if (!home || !away) return null;

  const calc = fx.calculated || {};
  const vit = fx.vitibet || {};
  const calcProb = probabilities(calc.probabilities);
  const vitProb = probabilities(vit.probabilities);
  const recent = leagueRecent(fx);
  const formHome = num(calc.form?.home);
  const formAway = num(calc.form?.away);
  const powerHome = num(calc.power?.home);
  const powerAway = num(calc.power?.away);

  const values = [
    num(fx.league?.averageGoals),
    num(calc.index),
    calcProb[0],
    calcProb[1],
    calcProb[2],
    num(calc.total),
    num(calc.expected?.home),
    num(calc.expected?.away),
    formHome,
    formAway,
    formHome != null && formAway != null ? formHome - formAway : null,
    powerHome,
    powerAway,
    powerHome != null && powerAway != null ? powerHome - powerAway : null,
    num(vit.index),
    vitProb[0],
    vitProb[1],
    vitProb[2],
    vit.published ? 1 : 0,
    Math.log1p(Number(fx.community?.totalPicks) || 0),
    recent?.sample ?? null,
    recent?.homeWin ?? null,
    recent?.draw ?? null,
    recent?.awayWin ?? null,
    recent?.btts ?? null,
    recent?.over25 ?? null,
    recent?.avgGoals ?? null,
    home.ppg,
    home.gdpg,
    home.gfpg,
    home.gapg,
    home.winRate,
    home.btts,
    home.cleanSheets,
    home.over25,
    home.formPoints,
    home.recentGf,
    home.recentGa,
    away.ppg,
    away.gdpg,
    away.gfpg,
    away.gapg,
    away.winRate,
    away.btts,
    away.cleanSheets,
    away.over25,
    away.formPoints,
    away.recentGf,
    away.recentGa,
  ];

  return values.map((value) => (Number.isFinite(Number(value)) ? Number(value) : null));
}

function labelsFor(fx) {
  const home = Number(fx.score?.home);
  const away = Number(fx.score?.away);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  const total = home + away;
  return {
    result: home > away ? 0 : home === away ? 1 : 2,
    btts: home > 0 && away > 0 ? 1 : 0,
    over25: total > 2.5 ? 1 : 0,
    total,
    home,
    away,
  };
}

/** Every complete stored football fixture with its labels and date. */
export function buildDataset(sport = 'football') {
  const db = getDatabase();
  const rows = [];
  const days = new Set();
  for (const day of Object.values(db.days || {})) {
    if (day.sport !== sport) continue;
    for (const fx of day.fixtures || []) {
      const labels = labelsFor(fx);
      const features = featuresForFixture(fx);
      if (!labels || !features) continue;
      rows.push({ fixtureId: fx.fixtureId, date: day.date, features, labels });
      days.add(day.date);
    }
  }
  return { rows, days: [...days].sort() };
}

/* ---------------- neural network ---------------- */

const mulberry32 = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const zeros = (n) => Array.from({ length: n }, () => 0);
const matrix = (rows, cols, scale, rng) =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => (rng() * 2 - 1) * scale));

function normalizeStats(rows) {
  const means = FEATURE_NAMES.map((_, index) => {
    const values = rows.map((row) => row.features[index]).filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  });
  const stds = FEATURE_NAMES.map((_, index) => {
    const values = rows.map((row) => row.features[index]).filter((value) => Number.isFinite(value));
    if (!values.length) return 1;
    const mean = means[index];
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) || 1;
  });
  const goals = rows.flatMap((row) => [row.labels.home, row.labels.away]);
  const goalMean = goals.reduce((sum, value) => sum + value, 0) / goals.length;
  const goalStd =
    Math.sqrt(goals.reduce((sum, value) => sum + (value - goalMean) ** 2, 0) / goals.length) || 1;
  const totals = rows.map((row) => row.labels.total);
  const totalMean = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  const totalStd =
    Math.sqrt(totals.reduce((sum, value) => sum + (value - totalMean) ** 2, 0) / totals.length) || 1;
  return { mean: means, std: stds, goalMean, goalStd, totalMean, totalStd };
}

function transform(row, stats) {
  return FEATURE_NAMES.map((_, index) => {
    const value = row.features[index];
    const safe = Number.isFinite(value) ? value : stats.mean[index];
    return (safe - stats.mean[index]) / stats.std[index];
  });
}

function targetVector(labels, stats) {
  const oneHot = [0, 0, 0];
  oneHot[labels.result] = 1;
  return [
    ...oneHot,
    labels.btts,
    labels.over25,
    (labels.total - stats.totalMean) / stats.totalStd,
    (labels.home - stats.goalMean) / stats.goalStd,
    (labels.away - stats.goalMean) / stats.goalStd,
  ];
}

const LOGIT_TEMPERATURE = 4;
const LABEL_SMOOTHING = 0.05;
const PRIOR_1X2 = [0.45, 0.26, 0.29];
const PRIOR_RATE = 0.5;

const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));

function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0) || 1;
  return exps.map((value) => value / sum);
}

function forward(x, params) {
  const z1 = zeros(params.W1.length);
  for (let i = 0; i < params.W1.length; i += 1) {
    z1[i] = params.b1[i];
    for (let j = 0; j < x.length; j += 1) z1[i] += params.W1[i][j] * x[j];
  }
  const a1 = z1.map((value) => Math.max(0, value));
  const z2 = zeros(params.W2.length);
  for (let i = 0; i < params.W2.length; i += 1) {
    z2[i] = params.b2[i];
    for (let j = 0; j < a1.length; j += 1) z2[i] += params.W2[i][j] * a1[j];
  }
  const a2 = z2.map((value) => Math.max(0, value));
  const out = zeros(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = params.b3[i];
    for (let j = 0; j < a2.length; j += 1) out[i] += params.W3[i][j] * a2[j];
  }
  return { z1, a1, z2, a2, out };
}

function predictVector(x, params, stats) {
  const { out } = forward(x, params);
  const probs = softmax(out.slice(0, 3).map((value) => value / LOGIT_TEMPERATURE));
  const btts = sigmoid(out[3] / LOGIT_TEMPERATURE);
  const over25 = sigmoid(out[4] / LOGIT_TEMPERATURE);
  const total = Math.max(0, out[5] * stats.totalStd + stats.totalMean);
  const home = Math.max(0.05, out[6] * stats.goalStd + stats.goalMean);
  const away = Math.max(0.05, out[7] * stats.goalStd + stats.goalMean);
  return { probs, btts, over25, total, home, away };
}

function poissonPmf(lambda, k) {
  let factorial = 1;
  for (let i = 2; i <= k; i += 1) factorial *= i;
  return (Math.exp(-lambda) * lambda ** k) / factorial;
}

function scoreline(home, away) {
  const h = clamp(home, 0.05, 6);
  const a = clamp(away, 0.05, 6);
  const scores = [];
  for (let i = 0; i <= 6; i += 1) {
    for (let j = 0; j <= 6; j += 1) {
      scores.push({ score: `${i}-${j}`, probability: poissonPmf(h, i) * poissonPmf(a, j) });
    }
  }
  scores.sort((left, right) => right.probability - left.probability);
  const total = scores.reduce((sum, entry) => sum + entry.probability, 0) || 1;
  return scores.map((entry) => ({ ...entry, probability: entry.probability / total })).slice(0, 5);
}

function createParams(input, h1, h2, rng) {
  return {
    W1: matrix(h1, input, Math.sqrt(2 / input), rng),
    b1: zeros(h1),
    W2: matrix(h2, h1, Math.sqrt(2 / h1), rng),
    b2: zeros(h2),
    W3: matrix(8, h2, Math.sqrt(2 / h2), rng),
    b3: zeros(8),
  };
}

function copyParams(params) {
  return JSON.parse(JSON.stringify(params));
}

function trainParams(rows, stats, { epochs = 220, batchSize = 8, learningRate = 0.01, l2 = 0.0005, seed = 7 } = {}) {
  const rng = mulberry32(seed);
  const input = FEATURE_NAMES.length;
  const params = createParams(input, 24, 12, rng);
  const adam = {
    m: copyParams(params),
    v: copyParams(params),
  };
  for (const key of Object.keys(adam.m)) {
    adam.m[key] = JSON.parse(JSON.stringify(params[key]));
    adam.v[key] = JSON.parse(JSON.stringify(params[key]));
    const zero = (value) => (Array.isArray(value) ? value.map(zero) : 0);
    adam.m[key] = zero(params[key]);
    adam.v[key] = zero(params[key]);
  }
  let step = 0;
  const history = [];

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const order = rows.map((_, index) => index).sort(() => rng() - 0.5);
    let epochLoss = 0;
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      const grads = {
        W1: params.W1.map((row) => row.map(() => 0)),
        b1: zeros(params.b1.length),
        W2: params.W2.map((row) => row.map(() => 0)),
        b2: zeros(params.b2.length),
        W3: params.W3.map((row) => row.map(() => 0)),
        b3: zeros(params.b3.length),
      };
      for (const index of batch) {
        const x = transform(rows[index], stats);
        const y = targetVector(rows[index].labels, stats);
        const { z1, a1, z2, a2, out } = forward(x, params);
        const scaled = out.slice(0, 3).map((value) => value / LOGIT_TEMPERATURE);
        const probs = softmax(scaled);
        const pBtts = sigmoid(out[3] / LOGIT_TEMPERATURE);
        const pOver = sigmoid(out[4] / LOGIT_TEMPERATURE);
        const y1 = y.slice(0, 3).map((value) => value * (1 - LABEL_SMOOTHING) + LABEL_SMOOTHING / 3);
        const yBtts = y[3] * (1 - LABEL_SMOOTHING) + LABEL_SMOOTHING / 2;
        const yOver = y[4] * (1 - LABEL_SMOOTHING) + LABEL_SMOOTHING / 2;

        const loss =
          -Math.log(Math.max(1e-8, probs[y[0]])) +
          -(yBtts * Math.log(Math.max(1e-8, pBtts)) + (1 - yBtts) * Math.log(Math.max(1e-8, 1 - pBtts))) * 0.5 +
          -(yOver * Math.log(Math.max(1e-8, pOver)) + (1 - yOver) * Math.log(Math.max(1e-8, 1 - pOver))) * 0.5 +
          (out[5] - y[5]) ** 2 * 0.35 +
          ((out[6] - y[6]) ** 2 + (out[7] - y[7]) ** 2) * 0.35;
        epochLoss += loss;

        const dOut = zeros(8);
        for (let i = 0; i < 3; i += 1) dOut[i] = (probs[i] - y1[i]) / LOGIT_TEMPERATURE;
        dOut[3] = ((pBtts - yBtts) * 0.5) / LOGIT_TEMPERATURE;
        dOut[4] = ((pOver - yOver) * 0.5) / LOGIT_TEMPERATURE;
        dOut[5] = (out[5] - y[5]) * 0.7;
        dOut[6] = (out[6] - y[6]) * 0.7;
        dOut[7] = (out[7] - y[7]) * 0.7;

        const dA2 = zeros(a2.length);
        for (let i = 0; i < 8; i += 1) {
          for (let j = 0; j < a2.length; j += 1) {
            grads.W3[i][j] += dOut[i] * a2[j];
            dA2[j] += params.W3[i][j] * dOut[i];
          }
          grads.b3[i] += dOut[i];
        }
        const dZ2 = dA2.map((value, i) => (z2[i] > 0 ? value : 0));
        const dA1 = zeros(a1.length);
        for (let i = 0; i < z2.length; i += 1) {
          for (let j = 0; j < a1.length; j += 1) {
            grads.W2[i][j] += dZ2[i] * a1[j];
            dA1[j] += params.W2[i][j] * dZ2[i];
          }
          grads.b2[i] += dZ2[i];
        }
        const dZ1 = dA1.map((value, i) => (z1[i] > 0 ? value : 0));
        for (let i = 0; i < z1.length; i += 1) {
          for (let j = 0; j < x.length; j += 1) grads.W1[i][j] += dZ1[i] * x[j];
          grads.b1[i] += dZ1[i];
        }
      }

      step += 1;
      const beta1 = 0.9;
      const beta2 = 0.999;
      const scale = 1 / batch.length;
      const apply = (key) => {
        const param = params[key];
        const grad = grads[key];
        const m = adam.m[key];
        const v = adam.v[key];
        for (let i = 0; i < param.length; i += 1) {
          if (Array.isArray(param[i])) {
            for (let j = 0; j < param[i].length; j += 1) {
              const g = grad[i][j] * scale + l2 * param[i][j];
              m[i][j] = beta1 * m[i][j] + (1 - beta1) * g;
              v[i][j] = beta2 * v[i][j] + (1 - beta2) * g * g;
              const mh = m[i][j] / (1 - beta1 ** step);
              const vh = v[i][j] / (1 - beta2 ** step);
              param[i][j] -= learningRate * (mh / (Math.sqrt(vh) + 1e-8));
            }
          } else {
            const g = grad[i] * scale;
            m[i] = beta1 * m[i] + (1 - beta1) * g;
            v[i] = beta2 * v[i] + (1 - beta2) * g * g;
            const mh = m[i] / (1 - beta1 ** step);
            const vh = v[i] / (1 - beta2 ** step);
            param[i] -= learningRate * (mh / (Math.sqrt(vh) + 1e-8));
          }
        }
      };
      for (const key of ['W1', 'b1', 'W2', 'b2', 'W3', 'b3']) apply(key);
    }
    if (epoch % 20 === 0 || epoch === epochs - 1) {
      history.push({ epoch: epoch + 1, loss: round(epochLoss / rows.length, 4) });
    }
  }

  return { params, history };
}

function evaluate(rows, stats, params) {
  let correct1x2 = 0;
  let correctBtts = 0;
  let correctOver = 0;
  let totalError = 0;
  let correctTop1 = 0;
  let correctTop3 = 0;
  let logLoss = 0;
  for (const row of rows) {
    const prediction = predictVector(transform(row, stats), params, stats);
    const top = prediction.probs.indexOf(Math.max(...prediction.probs));
    if (top === row.labels.result) correct1x2 += 1;
    if ((prediction.btts >= 0.5 ? 1 : 0) === row.labels.btts) correctBtts += 1;
    if ((prediction.over25 >= 0.5 ? 1 : 0) === row.labels.over25) correctOver += 1;
    totalError += Math.abs(prediction.total - row.labels.total);
    logLoss += -Math.log(Math.max(1e-8, prediction.probs[row.labels.result]));
    const scores = scoreline(prediction.home, prediction.away);
    const actual = `${row.labels.home}-${row.labels.away}`;
    if (scores[0]?.score === actual) correctTop1 += 1;
    if (scores.slice(0, 3).some((entry) => entry.score === actual)) correctTop3 += 1;
  }
  const n = rows.length || 1;
  return {
    samples: rows.length,
    '1x2Accuracy': round((100 * correct1x2) / n, 1),
    bttsAccuracy: round((100 * correctBtts) / n, 1),
    over25Accuracy: round((100 * correctOver) / n, 1),
    totalMae: round(totalError / n, 2),
    correctScoreTop1: round((100 * correctTop1) / n, 1),
    correctScoreTop3: round((100 * correctTop3) / n, 1),
    logLoss: round(logLoss / n, 3),
  };
}

function predictFromModel(model, rawFeatures) {
  const stats = model.normalization;
  const vector = FEATURE_NAMES.map((_, index) => {
    const value = rawFeatures[index];
    const safe = Number.isFinite(value) ? value : stats.mean[index];
    return (safe - stats.mean[index]) / stats.std[index];
  });
  const prediction = predictVector(vector, model.params, stats);
  // Shrink the network's output toward football priors and the page's own
  // pre-match expected goals. A 49-feature net trained on a few hundred rows
  // can otherwise print 99% probabilities that its cross-validation does not
  // support.
  const blended = prediction.probs.map((value, index) => 0.7 * value + 0.3 * PRIOR_1X2[index]);
  const sum = blended.reduce((total, value) => total + value, 0) || 1;
  const probs = blended.map((value) => value / sum);
  const btts = 0.7 * prediction.btts + 0.3 * PRIOR_RATE;
  const over25 = 0.7 * prediction.over25 + 0.3 * PRIOR_RATE;
  const calcHome = Number.isFinite(rawFeatures[6]) ? rawFeatures[6] : 1.3;
  const calcAway = Number.isFinite(rawFeatures[7]) ? rawFeatures[7] : 1.1;
  const homeLambda = clamp(0.65 * prediction.home + 0.35 * calcHome, 0.2, 4.5);
  const awayLambda = clamp(0.65 * prediction.away + 0.35 * calcAway, 0.2, 4.5);
  const totalGoals = homeLambda + awayLambda;
  const top = probs.indexOf(Math.max(...probs));
  const score = scoreline(homeLambda, awayLambda);
  const percentages = probs.map((value) => Math.round(value * 1000) / 10);
  percentages[2] = round(100 - percentages[0] - percentages[1], 1);
  return {
    probabilities: {
      '1': percentages[0],
      X: percentages[1],
      '2': percentages[2],
    },
    pick: ['1', 'X', '2'][top],
    confidence: percentages[top],
    btts: {
      yes: round(btts * 100, 1),
      no: round((1 - btts) * 100, 1),
      pick: btts >= 0.5 ? 'Yes' : 'No',
    },
    over25: {
      over: round(over25 * 100, 1),
      under: round((1 - over25) * 100, 1),
      pick: over25 >= 0.5 ? 'Over 2.5' : 'Under 2.5',
    },
    totalGoals: round(totalGoals, 1),
    expected: { home: round(homeLambda, 2), away: round(awayLambda, 2) },
    correctScore: {
      score: score[0]?.score || null,
      probability: round((score[0]?.probability || 0) * 100, 1),
      top: score.slice(0, 3).map((entry) => ({
        score: entry.score,
        probability: round(entry.probability * 100, 1),
      })),
    },
  };
}

function loadModelCache() {
  try {
    if (!fs.existsSync(MODEL_FILE)) return null;
    const text = fs.readFileSync(MODEL_FILE, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let cachedModel = loadModelCache();

export function getModel() {
  return cachedModel;
}

export function modelSummary(model = cachedModel) {
  if (!model) return null;
  const { params, normalization, ...summary } = model;
  return summary;
}

export function status() {
  const dataset = buildDataset();
  const model = modelSummary();
  return {
    dataset: {
      matches: dataset.rows.length,
      days: dataset.days.length,
      features: FEATURE_NAMES.length,
      targets: ['1X2', 'BTTS', 'Total goals', 'Over/Under 2.5', 'Correct score'],
    },
    model,
    featureNames: FEATURE_NAMES,
  };
}

export function train({ sport = 'football', epochs = 220, folds = 5 } = {}) {
  const dataset = buildDataset(sport);
  if (dataset.rows.length < 8) {
    throw new Error(`Need at least 8 complete ${sport} matches to train; found ${dataset.rows.length}.`);
  }
  const rows = dataset.rows;
  const foldCount = Math.max(2, Math.min(folds, Math.floor(rows.length / 3)));
  const order = rows.map((_, index) => index).sort(() => Math.random() - 0.5);
  const foldSize = Math.ceil(rows.length / foldCount);
  const foldMetrics = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const start = fold * foldSize;
    const testIndices = new Set(order.slice(start, start + foldSize));
    const trainRows = rows.filter((_, index) => !testIndices.has(index));
    const testRows = rows.filter((_, index) => testIndices.has(index));
    if (!trainRows.length || !testRows.length) continue;
    const stats = normalizeStats(trainRows);
    const { params } = trainParams(trainRows, stats, { epochs, seed: 11 + fold });
    foldMetrics.push(evaluate(testRows, stats, params));
  }
  const stats = normalizeStats(rows);
  const { params, history } = trainParams(rows, stats, { epochs: Math.round(epochs * 1.2), seed: 29 });
  const model = {
    version: VERSION,
    sport,
    trainedAt: new Date().toISOString(),
    samples: rows.length,
    days: dataset.days,
    featureNames: FEATURE_NAMES,
    architecture: { input: FEATURE_NAMES.length, hidden: [24, 12], outputs: 8, heads: 5 },
    calibration: {
      temperature: LOGIT_TEMPERATURE,
      labelSmoothing: LABEL_SMOOTHING,
      prior1x2: PRIOR_1X2,
      priorRate: PRIOR_RATE,
      outputBlend: 0.7,
    },
    epochs: Math.round(epochs * 1.2),
    normalization: stats,
    params,
    metrics: {
      folds: foldMetrics.length,
      ...Object.fromEntries(
        ['1x2Accuracy', 'bttsAccuracy', 'over25Accuracy', 'totalMae', 'correctScoreTop1', 'correctScoreTop3', 'logLoss'].map(
          (key) => [key, round(foldMetrics.reduce((sum, fold) => sum + (fold[key] || 0), 0) / (foldMetrics.length || 1), 2)]
        )
      ),
    },
    cv: foldMetrics,
    history,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MODEL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(model));
  fs.renameSync(tmp, MODEL_FILE);
  cachedModel = model;
  return modelSummary(model);
}

export function predictRecord(found) {
  const model = cachedModel;
  if (!model) return { available: false, reason: 'not_trained' };
  if (!found) return { available: false, reason: 'not_in_database' };
  // Prediction is allowed for scheduled fixtures; training still requires a
  // final score through the default `requireResult` option.
  const features = featuresForFixture(found, { requireResult: false });
  if (!features) return { available: false, reason: 'incomplete_features' };
  return {
    available: true,
    fixtureId: String(found.fixtureId),
    home: found.home,
    away: found.away,
    ...predictFromModel(model, features),
    model: {
      trainedAt: model.trainedAt,
      samples: model.samples,
      features: model.featureNames.length,
      architecture: model.architecture,
      metrics: model.metrics,
    },
  };
}

export function predictFixture(fixtureId, sport = 'football') {
  const model = cachedModel;
  if (!model) return { available: false, reason: 'not_trained' };
  const db = getDatabase();
  let found = null;
  for (const day of Object.values(db.days || {})) {
    if (day.sport !== sport) continue;
    found = (day.fixtures || []).find((fixture) => String(fixture.fixtureId) === String(fixtureId));
    if (found) break;
  }
  return predictRecord(found);
}
