import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDay, fetchMatch, fetchPicks, normalizeSport, SUPPORTED_SPORTS } from './lib/scrape.js';
import { collectFixture, getJob, listJobs, startProcessing, todayISO } from './lib/process.js';
import { stats as scrapeStats } from './lib/http.js';
import {
  modelSummary as mlModelSummary,
  predictFixture as predictMl,
  predictRecord as predictMlRecord,
  status as mlStatus,
  train as trainMl,
} from './lib/ml.js';
import {
  deleteDay,
  deleteFixture,
  getCompetition,
  getDay,
  getTeam,
  listPredictions,
  search as searchDatabase,
  summary as databaseSummary,
} from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders: (res, filePath) => {
      // The page shell and its scripts change together, so always revalidate
      // them: a stale cached page paired with newer JS once broke the app.
      if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const isRealDate = (value) => {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const SPORT_ALIASES = new Set(['basketball', 'basket', 'football', 'fotbal', 'soccer']);

const resolveSport = (raw, res) => {
  const value = String(raw || '').trim().toLowerCase();
  if (value && !SPORT_ALIASES.has(value)) {
    res.status(400).json({
      error: `Unknown sport '${value}'. Use one of: ${SUPPORTED_SPORTS.join(', ')}.`,
    });
    return null;
  }
  return normalizeSport(value);
};

const readSport = (req, res) => resolveSport(req.query.sport, res);

app.get('/api/fixtures', async (req, res) => {
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) {
    res.status(400).json({ error: 'Pass date=YYYY-MM-DD (for example 2026-11-11).' });
    return;
  }
  const sport = readSport(req, res);
  if (!sport) return;

  try {
    const payload = await fetchDay(date, sport);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (error) {
    console.error(`[fixtures] ${date}:`, error?.message || error);
    res.status(502).json({
      error: 'Could not load fixtures from Vitibet right now.',
      detail: String(error?.message || error),
      date,
    });
  }
});

app.get('/api/match', async (req, res) => {
  const fixtureId = String(req.query.fixture_id || req.query.fixture || '').trim();
  const leagueId = String(req.query.league_id || req.query.league || '').trim();
  const sport = readSport(req, res);
  if (!sport) return;

  if (!/^\d{1,12}$/.test(fixtureId)) {
    res.status(400).json({ error: 'Pass fixture_id=<number> (optionally league_id=<number>).' });
    return;
  }
  if (leagueId && !/^\d{1,12}$/.test(leagueId)) {
    res.status(400).json({ error: 'league_id must be a number.' });
    return;
  }

  try {
    const payload = await fetchMatch(fixtureId, leagueId || null, sport);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (error) {
    console.error(`[match] ${fixtureId}:`, error?.message || error);
    res.status(502).json({
      error: 'Could not load this match from Vitibet right now.',
      detail: String(error?.message || error),
      fixtureId,
    });
  }
});

app.get('/api/picks', async (req, res) => {
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) {
    res.status(400).json({ error: 'Pass date=YYYY-MM-DD (for example 2026-11-11).' });
    return;
  }
  const sport = readSport(req, res);
  if (!sport) return;

  const cursor = Number.parseInt(String(req.query.cursor || '0'), 10);
  const limit = Number.parseInt(String(req.query.limit || '6'), 10);

  try {
    const payload = await fetchPicks(date, {
      sport,
      cursor: Number.isFinite(cursor) ? cursor : 0,
      limit: Number.isFinite(limit) ? limit : 6,
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (error) {
    console.error(`[picks] ${date}:`, error?.message || error);
    res.status(502).json({
      error: 'Could not calculate picks for this date right now.',
      detail: String(error?.message || error),
      date,
    });
  }
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q || req.query.query || '').trim();
  const rawSport = String(req.query.sport || '').trim();
  const sport = rawSport ? resolveSport(rawSport, res) : null;
  if (rawSport && !sport) return;

  const limit = Number.parseInt(String(req.query.limit || '8'), 10);
  res.set('Cache-Control', 'no-store');
  res.json(
    searchDatabase(query, { sport, limit: Number.isFinite(limit) ? limit : 8 })
  );
});

/* ---------------- processing ---------------- */

app.post('/api/process', (req, res) => {
  const body = req.body || {};
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) {
    res.status(400).json({ error: 'Pass a date in the form YYYY-MM-DD.' });
    return;
  }
  if (date > todayISO()) {
    res.status(400).json({ error: 'Processing works on past and current dates, not future ones.' });
    return;
  }

  const sport = resolveSport(body.sport, res);
  if (!sport) return;

  const mode = String(body.mode || 'database').trim().toLowerCase();
  if (!['database', 'prediction'].includes(mode)) {
    res.status(400).json({ error: "mode must be 'database' or 'prediction'." });
    return;
  }

  const job = startProcessing({ date, sport, refresh: Boolean(body.refresh), mode });
  res.status(202).json({
    job: {
      id: job.id,
      mode: job.mode,
      date: job.date,
      sport: job.sport,
      status: job.status,
      progress: job.progress,
    },
  });
});

app.get('/api/process/:id', (req, res) => {
  const job = getJob(String(req.params.id || ''));
  if (!job) {
    res.status(404).json({ error: 'No such processing job in this server session.' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ job });
});

app.get('/api/process', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ jobs: listJobs() });
});

/* ---------------- prediction set ---------------- */

const predictionModelInfo = () => {
  const model = mlModelSummary();
  return model
    ? { trainedAt: model.trainedAt, samples: model.samples, metrics: model.metrics }
    : null;
};

app.get('/api/predictions', (req, res) => {
  const rawSport = String(req.query.sport || '').trim();
  const sport = rawSport ? resolveSport(rawSport, res) : null;
  if (rawSport && !sport) return;
  const date = String(req.query.date || '').trim() || null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Pass date=YYYY-MM-DD or leave it out.' });
    return;
  }

  const stored = listPredictions({ sport, date });
  res.set('Cache-Control', 'no-store');
  res.json({
    model: predictionModelInfo(),
    total: stored.length,
    dates: [...new Set(stored.map((entry) => entry.date))].sort((a, b) => b.localeCompare(a)),
    fixtures: stored.map((entry) => ({
      fixtureId: entry.fixtureId,
      date: entry.date,
      sport: entry.sport,
      home: entry.record?.home || 'Home',
      away: entry.record?.away || 'Away',
      leagueName: entry.record?.leagueName || null,
      kickoff: entry.record?.kickoff || null,
      status: entry.record?.status || null,
      score: entry.record?.score || null,
      savedAt: entry.savedAt || null,
    })),
  });
});

app.post('/api/predictions/run', (req, res) => {
  const body = req.body || {};
  const sport = resolveSport(body.sport || 'football', res);
  if (!sport) return;
  const date = String(body.date || '').trim() || null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Pass date=YYYY-MM-DD or leave it out.' });
    return;
  }
  if (!mlModelSummary()) {
    res.status(409).json({
      error: 'No ML model has been trained yet. Open ML Training and train it first.',
      results: [],
      skipped: [],
    });
    return;
  }

  const stored = listPredictions({ sport, date });
  if (!stored.length) {
    res.status(404).json({
      error: 'No matches are stored for prediction yet. Process a date in the Predictions tab first.',
      results: [],
      skipped: [],
    });
    return;
  }

  const results = [];
  const skipped = [];
  for (const entry of stored) {
    const result = predictMlRecord(entry.record);
    if (!result.available) {
      skipped.push({
        fixtureId: entry.fixtureId,
        date: entry.date,
        home: entry.record?.home || 'Home',
        away: entry.record?.away || 'Away',
        reason: result.reason || 'unavailable',
      });
      continue;
    }
    results.push({
      fixtureId: entry.fixtureId,
      date: entry.date,
      leagueName: entry.record?.leagueName || null,
      kickoff: entry.record?.kickoff || null,
      status: entry.record?.status || null,
      score: entry.record?.score || null,
      home: result.home,
      away: result.away,
      pick: result.pick,
      confidence: result.confidence,
      probabilities: result.probabilities,
      btts: result.btts,
      over25: result.over25,
      totalGoals: result.totalGoals,
      expected: result.expected,
      correctScore: result.correctScore,
    });
  }
  results.sort((a, b) =>
    a.date === b.date
      ? String(a.kickoff || '').localeCompare(String(b.kickoff || ''))
      : String(b.date).localeCompare(String(a.date))
  );

  res.set('Cache-Control', 'no-store');
  res.json({
    total: stored.length,
    predicted: results.length,
    model: predictionModelInfo(),
    results,
    skipped,
  });
});

/* ---------------- database ---------------- */

app.get('/api/database', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(databaseSummary());
});

app.get('/api/database/day', (req, res) => {
  const key = String(req.query.key || '').trim();
  const day = getDay(key);
  if (!day) {
    res.status(404).json({ error: 'No processed day stored under that key.' });
    return;
  }
  // Team and competition records are served by their own endpoints; repeating
  // full profiles inside every fixture made the day payload ~3x larger.
  const fixtures = (day.fixtures || []).map(({ teamProfiles, competition, ...fixture }) => fixture);
  res.set('Cache-Control', 'no-store');
  res.json({ ...day, fixtures });
});

app.delete('/api/database/day', (req, res) => {
  const key = String(req.query.key || '').trim();
  const deleted = key ? deleteDay(key) : null;
  if (!deleted) {
    res.status(404).json({ error: 'No processed day stored under that key.' });
    return;
  }
  res.json({ deleted: true, key, fixtures: deleted.fixtures?.length || 0, database: databaseSummary() });
});

app.delete('/api/database/fixture', (req, res) => {
  const key = String(req.query.key || '').trim();
  const fixtureId = String(req.query.fixture_id || req.query.fixture || '').trim();
  if (!key || !fixtureId) {
    res.status(400).json({ error: 'Pass key=<day key> and fixture_id=<number>.' });
    return;
  }
  const result = deleteFixture(key, fixtureId);
  if (!result) {
    res.status(404).json({ error: 'No stored match with that id on this day.' });
    return;
  }
  res.json({
    deleted: true,
    key,
    fixtureId,
    remaining: result.day?.fixtures?.length || 0,
    database: databaseSummary(),
  });
});

app.get('/api/database/team', (req, res) => {
  const key = String(req.query.key || '').trim();
  const team = getTeam(key);
  if (!team) {
    res.status(404).json({ error: 'No team stored under that key.' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json(team);
});

app.get('/api/database/competition', (req, res) => {
  const key = String(req.query.key || '').trim();
  const competition = getCompetition(key);
  if (!competition) {
    res.status(404).json({ error: 'No competition stored under that key.' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json(competition);
});

/* ---------------- machine learning ---------------- */

app.get('/api/ml', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(mlStatus());
});

app.post('/api/ml/train', (req, res) => {
  const sport = resolveSport(req.body?.sport || 'football', res);
  if (!sport) return;
  if (sport !== 'football') {
    res.status(400).json({ error: 'The ML model is currently trained on football only.' });
    return;
  }
  try {
    const epochs = Math.max(40, Math.min(600, Number(req.body?.epochs) || 140));
    const model = trainMl({ sport, epochs, folds: 5 });
    res.json({ trained: true, model, ...mlStatus() });
  } catch (error) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

const onDemandCache = new Map();
const ON_DEMAND_TTL_MS = 5 * 60 * 1000;

app.get('/api/ml/predict', async (req, res) => {
  const fixtureId = String(req.query.fixture_id || req.query.fixture || '').trim();
  const date = String(req.query.date || '').trim();
  const leagueId = String(req.query.league_id || req.query.league || '').trim() || null;
  const sport = readSport(req, res);
  if (!sport) return;
  if (!/^\d{1,12}$/.test(fixtureId)) {
    res.status(400).json({ error: 'Pass fixture_id=<number>.' });
    return;
  }

  let result = predictMl(fixtureId, sport);
  let collected = false;

  // Fixtures in the database are the training set. For any other clicked
  // fixture, run the single-fixture processing path first, then feed that
  // collected record to the model. The record is not added to training storage.
  if (!result.available && result.reason === 'not_in_database' && sport === 'football') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(404).json({
        ...result,
        error: 'This fixture is not in the training database. Open it with its date so its data can be collected for prediction.',
      });
      return;
    }
    const cacheKey = `${sport}|${fixtureId}|${date}|${leagueId || ''}`;
    const cached = onDemandCache.get(cacheKey);
    let record = cached && Date.now() - cached.at < ON_DEMAND_TTL_MS ? cached.record : null;
    if (!record) {
      try {
        record = await collectFixture({ fixtureId, date, sport, leagueId });
        onDemandCache.set(cacheKey, { at: Date.now(), record });
        collected = true;
      } catch (error) {
        res.status(502).json({
          ...result,
          error: `Could not collect this fixture for prediction: ${String(error?.message || error)}`,
        });
        return;
      }
    }
    result = predictMlRecord(record);
  }

  res.set('Cache-Control', 'no-store');
  if (!result.available) {
    const messages = {
      not_trained: 'No ML model has been trained yet. Open ML Training and train it first.',
      not_in_database: 'This match is not in the processed database, so it has no ML features yet.',
      incomplete_features: 'This match does not have enough pre-match features for the model. Its team or competition data may be unavailable.',
    };
    res.status(404).json({
      ...result,
      error: messages[result.reason] || 'ML prediction is not available for this match.',
    });
    return;
  }
  res.json({ ...result, collected });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), scrape: scrapeStats() });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API route.' });
});

app.listen(PORT, HOST, () => {
  console.log(`HoopsFixtures listening on http://${HOST}:${PORT}`);
});
