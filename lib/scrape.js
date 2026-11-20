import * as cheerio from 'cheerio';
import { estimateAnalytics, pickFromProbabilities, predictTotal } from './analytics.js';
import { getHtml } from './http.js';
import { parseMatchExtras } from './profile.js';

const SITE = 'https://www.vitibet.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SPORTS = {
  basketball: {
    key: 'basketball',
    label: 'Basketball',
    emoji: '🏀',
    sekce: 'basket',
    detailClanek: 'basket-match-detail',
  },
  football: {
    key: 'football',
    label: 'Football',
    emoji: '⚽',
    sekce: 'fotbal',
    detailClanek: 'match-detail',
  },
};

const ALIASES = {
  basketball: 'basketball',
  basket: 'basketball',
  football: 'football',
  fotbal: 'football',
  soccer: 'football',
};

export const SUPPORTED_SPORTS = Object.keys(SPORTS);

export function normalizeSport(value) {
  return ALIASES[String(value || '').trim().toLowerCase()] || 'basketball';
}

const sportConfig = (sport) => SPORTS[normalizeSport(sport)];

const PAGE = (sport, date) =>
  `${SITE}/index.php?clanek=quicktips&sekce=${sportConfig(sport).sekce}&lang=en&date=${date}`;
const DETAIL = (sport, fixtureId, leagueId) =>
  `${SITE}/index.php?clanek=${sportConfig(sport).detailClanek}&sekce=${sportConfig(sport).sekce}&lang=en` +
  `&fixture_id=${fixtureId}` +
  (leagueId ? `&league_id=${leagueId}` : '');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const inFlight = new Map();
const matchCache = new Map();
const matchInFlight = new Map();

const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

function parseScores($, $row, selector) {
  return $row
    .find(selector)
    .map((_, el) => clean($(el).text()))
    .get()
    .filter(Boolean);
}

function scoreParts(text) {
  const match = /(\d+)\s*[:\-–]\s*(\d+)/.exec(clean(text));
  return match ? [match[1], match[2]] : [];
}

function toNumber(value) {
  const n = Number.parseFloat(String(value).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseMatch($, el, league, sport) {
  const $row = $(el);
  const football = normalizeSport(sport) === 'football';

  const kickoff = clean($row.find('.local-time').first().text());
  const dateTime = clean($row.find('.local-time').first().attr('data-time') || '');
  const teams = $row
    .find('.livescore-team-name')
    .map((_, t) => clean($(t).text()))
    .get();

  const logos = $row
    .find('.livescore-team-logo')
    .map((_, img) => clean($(img).attr('src') || ''))
    .get()
    .map((src) => (src ? new URL(src, SITE).toString() : null));

  const status = clean($row.attr('data-status') || '');
  const badge = clean($row.find('.act-badge').first().text());
  const mobileStatus = clean($row.find('.indoor-ft-status-badge').first().text());

  let actual = parseScores($, $row, '.act-scores .act-score-line');
  if (!actual.length && football) {
    actual = scoreParts($row.find('.actual-score-row').first().text());
  }

  let predicted = parseScores($, $row, '.livescore-score-col .livescore-score-line');
  if (!predicted.length) {
    predicted = scoreParts($row.find('.livescore-score-combined').first().text());
  }

  const index = clean($row.find('.idx-val').first().text());
  const probabilities = {};
  $row.find('.prob-stat-box > div').each((_, box) => {
    const label = clean($(box).find('.prob-head').first().text()).toUpperCase();
    const pct = clean($(box).find('.prob-val').first().text()).replace(/\s+/g, '');
    if (!label || label === 'INDEX' || !pct) return;
    probabilities[label === '0' ? 'X' : label] = pct;
  });

  const tip = clean($row.find('.tip-indicator-circle').first().text()) || null;

  const homeScore = actual[0] ?? null;
  const awayScore = actual[1] ?? null;
  const isFinished = status === 'finished';
  const isLive = status && !isFinished && status !== 'scheduled';

  let statusLabel = 'Scheduled';
  if (isFinished) statusLabel = 'Full time';
  else if (isLive) statusLabel = badge || mobileStatus || 'Live';

  const href = clean($row.attr('href') || '');
  const fixtureId = clean($row.attr('data-fid') || $row.attr('id') || '').replace(/^match-/, '') || null;

  return {
    id: fixtureId,
    fixtureId,
    home: teams[0] || 'Home',
    away: teams[1] || 'Away',
    homeLogo: logos[0] || null,
    awayLogo: logos[1] || null,
    kickoff,
    startsAt: dateTime || null,
    status: isFinished ? 'finished' : isLive ? 'live' : 'scheduled',
    statusLabel,
    badge: badge || mobileStatus || null,
    homeScore: isFinished || isLive ? homeScore : null,
    awayScore: isFinished || isLive ? awayScore : null,
    index: index || null,
    indexValue: toNumber(index),
    probabilities,
    tip,
    predictedHome: predicted[0] && predicted[0] !== '-' ? predicted[0] : null,
    predictedAway: predicted[1] && predicted[1] !== '-' ? predicted[1] : null,
    leagueId: league.id,
    leagueName: league.name,
    leagueFlag: league.flag,
    detailUrl: href ? new URL(href, SITE).toString() : null,
  };
}

function parsePage(html, date, sport) {
  const cfg = sportConfig(sport);
  const $ = cheerio.load(html);
  const leagues = [];
  const seen = new Map();

  const pushLeague = (league) => {
    const key = league.id || league.name;
    if (seen.has(key)) {
      const existing = seen.get(key);
      existing.matches.push(...league.matches);
      return;
    }
    const entry = { ...league };
    seen.set(key, entry);
    leagues.push(entry);
  };

  const leagueBlocks = $('.livescore-league');

  if (leagueBlocks.length) {
    leagueBlocks.each((_, el) => {
      const $league = $(el);
      const name = clean($league.find('.league-title').first().text());
      const flagPath = clean($league.find('img.league-flag').first().attr('src') || '');
      const href = clean(
        $league.find('a[href*="/tips/"], a[href*="clanek=leagues"]').first().attr('href') || ''
      );
      const league = {
        id: clean($league.attr('data-lid') || ''),
        name: name || cfg.label,
        flag: flagPath ? new URL(flagPath, SITE).toString() : null,
        url: href ? new URL(href, SITE).toString() : null,
        matches: [],
      };
      $league.find('.livescore-match-row').each((__, row) => {
        league.matches.push(parseMatch($, row, league, sport));
      });
      if (league.matches.length) pushLeague(league);
    });
  } else {
    // Fallback for pages rendered in the flat (by INDEX) layout.
    const byLeague = new Map();
    $('.livescore-match-row').each((_, row) => {
      const $row = $(row);
      const lid = clean($row.attr('data-lid') || '');
      const banner = clean($row.closest('.flat-league-banner').first().text());
      if (!byLeague.has(lid)) {
        byLeague.set(lid, {
          id: lid,
          name: banner || `League ${lid || 'unknown'}`,
          flag: null,
          url: null,
          matches: [],
        });
      }
      byLeague.get(lid).matches.push(parseMatch($, row, byLeague.get(lid), sport));
    });
    for (const league of byLeague.values()) if (league.matches.length) pushLeague(league);
  }

  leagues.sort((a, b) => {
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length;
    return a.name.localeCompare(b.name);
  });

  const matches = leagues.flatMap((l) => l.matches);
  const counts = matches.reduce(
    (acc, m) => {
      acc.total += 1;
      acc[m.status] = (acc[m.status] || 0) + 1;
      return acc;
    },
    { total: 0, finished: 0, live: 0, scheduled: 0 }
  );

  const tipped = matches.filter((m) => m.tip).length;

  return {
    date,
    sport: cfg.key,
    sportLabel: cfg.label,
    source: `${PAGE(sport, date)}`,
    scrapedAt: new Date().toISOString(),
    pageTitle: clean($('title').first().text()) || null,
    counts: { ...counts, tipped },
    leagues,
  };
}

/* ---------------- match detail ---------------- */

const pctFromStyle = (style) => {
  const m = /width:\s*([\d.]+)%/.exec(style || '');
  return m ? Number(m[1]) : null;
};

function parseDetailDate(text) {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})?\s*\|\s*(\d{1,2}:\d{2})/.exec(text || '');
  if (!m) return { date: null, kickoff: null, dateLabel: null };

  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  let year = m[3];
  let dateLabel = `${day}.${month}.${year} · ${m[4]}`;

  if (!year) {
    // Football prints the date without a year; match pages are always close to
    // the fixture, so pick the year that puts the day nearest to today.
    const now = new Date();
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), Number(month) - 1, Number(day)));
    const drift = candidate.getTime() - now.getTime();
    if (drift > 183 * 86400000) candidate.setUTCFullYear(candidate.getUTCFullYear() - 1);
    else if (drift < -183 * 86400000) candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
    year = String(candidate.getUTCFullYear());
    dateLabel = `${day}.${month}. · ${m[4]}`;
  }

  return {
    date: `${year}-${month}-${day}`,
    kickoff: m[4],
    dateLabel,
  };
}

function parseFormDots($team, $) {
  return $team
    .find('.form-dot')
    .map((__, dot) => {
      const cls = clean($(dot).attr('class'));
      if (cls.includes('form-dot-w')) return 'W';
      if (cls.includes('form-dot-d')) return 'D';
      return 'L';
    })
    .get();
}

function parseScoreboard($, sport) {
  const football = normalizeSport(sport) === 'football';
  const $board = $('.match-scoreboard').first();
  const teams = [];

  $board.find('.match-scoreboard-team').each((_, el) => {
    const $team = $(el);
    const logo = clean($team.find('img').first().attr('src') || '');
    teams.push({
      name: clean($team.find('span').first().text()) || 'Team',
      logo: logo ? new URL(logo, SITE).toString() : null,
      form: parseFormDots($team, $),
    });
  });

  const scoreText = clean($board.find('.match-scoreboard-score').first().text());
  const scoreMatch = /(\d+)\s*[:\-–]\s*(\d+)/.exec(scoreText);
  const when = parseDetailDate(
    clean($board.find('.match-scoreboard-time').first().text()) || clean($board.text())
  );

  // Both sports print the model's exact-score guess in the same slot as the
  // result; the label ("FT", "HT", "67'", "Q2 8'", "TIP") says which it is.
  const rawLabel = clean(
    football ? $board.find('.match-tip-label').first().text() : $board.find('.sb-badge').first().text()
  );
  const badge = /our tip/i.test(rawLabel) ? 'TIP' : rawLabel;
  const scheduled = /tip|scheduled|vs/i.test(badge || '');
  const isActual = Boolean(scoreMatch) && !scheduled;
  const isLive = isActual && (/^(ht|live)/i.test(badge) || /'\s*$/.test(badge) || /^q\d/i.test(badge));
  const isFinal = isActual && !isLive;

  const headerStats = $('.hdr-stat-row')
    .map((_, el) => {
      const $row = $(el);
      const label = clean($row.find('.hdr-stat-label').first().text());
      const values = $row
        .children('span')
        .map((__, span) => clean($(span).text()))
        .get()
        .filter((value) => value && value !== label);
      return label && values.length >= 2
        ? { label, home: values[0], away: values[1] }
        : null;
    })
    .get()
    .filter(Boolean);

  return {
    leagueName: clean(
      football
        ? $board.find('.match-scoreboard-league').first().text()
        : $('.top-nav-bar span').first().text()
    ) || null,
    headerStats: headerStats.length ? headerStats : null,
    ...when,
    home: teams[0] || { name: 'Home', logo: null, form: [] },
    away: teams[1] || { name: 'Away', logo: null, form: [] },
    homeScore: isActual ? scoreMatch[1] : null,
    awayScore: isActual ? scoreMatch[2] : null,
    predictedHome: !isActual && scoreMatch ? scoreMatch[1] : null,
    predictedAway: !isActual && scoreMatch ? scoreMatch[2] : null,
    status: isLive ? 'live' : isFinal ? 'finished' : 'scheduled',
    badge: badge || null,
  };
}

function parseAnalytics($) {
  const $header = $('.analytics-header-row').first();
  if (!$header.length) return null;

  const card = $header.closest('.match-card');
  const index =
    clean($header.find('.analytics-index-val').first().text()) ||
    clean($header.find('.analytics-index-box div').first().text()) ||
    null;

  const $labels = $header.find('.prob-header-row .prob-cell');
  const $values = $header.find('.prob-val-row .prob-cell-val');
  const $footLabels = $header.find('.prob-col .prob-header');
  const $footValues = $header.find('.prob-col .prob-val');

  const labels = ($labels.length ? $labels : $footLabels)
    .map((_, el) => clean($(el).text()))
    .get();
  const values = ($values.length ? $values : $footValues)
    .map((_, el) => clean($(el).text()).replace(/\s+/g, ''))
    .get();

  const probabilities = {};
  labels.forEach((label, i) => {
    if (!label || !values[i]) return;
    const key = label.toUpperCase() === '0' ? 'X' : label.toUpperCase();
    probabilities[key] = values[i];
  });

  const bars = [];
  card.find('.stat-row, [style*="justify-content:space-between"]').each((_, row) => {
    const $row = $(row);
    const spans = $row.children('span');
    if (spans.length !== 3) return;
    const $bar = $row.nextAll('.possession-bar').first();
    bars.push({
      label: clean(spans.eq(1).text()),
      home: clean(spans.eq(0).text()) || null,
      away: clean(spans.eq(2).text()) || null,
      homePct: pctFromStyle($bar.find('.bar-home').first().attr('style')),
      awayPct: pctFromStyle($bar.find('.bar-away').first().attr('style')),
    });
  });

  const find = (needle) => bars.find((b) => b.label.toLowerCase().includes(needle)) || null;

  return { index, probabilities, form: find('form'), power: find('power') };
}

function parseLastMatchesBasketball($) {
  const teams = [];
  $('.last-matches-container .match-card').each((_, card) => {
    const $card = $(card);
    const name = clean($card.children('div').first().text());
    if (!name) return;

    const matches = $card
      .find('.last-match-item')
      .map((__, item) => {
        const $item = $(item);
        const spans = $item.find('div').first().find('span');
        const $score = $item.find('.score-indicator').first();
        const scoreClass = clean($score.attr('class') || '');
        const venue = clean($item.find('.match-loc-badge').first().text()).toUpperCase();
        return {
          venue: venue === 'H' ? 'H' : venue === 'A' ? 'A' : null,
          date: clean(spans.eq(1).text()) || null,
          opponent: clean(spans.eq(2).text()) || null,
          score: clean($score.text()) || null,
          result: scoreClass.includes('score-w') ? 'W' : scoreClass.includes('score-l') ? 'L' : null,
        };
      })
      .get()
      .filter((m) => m.opponent || m.score);

    teams.push({ name, matches });
  });
  return teams;
}

/**
 * Football's recent-results card. Only the "Total" panel is read so the
 * home/away split panels do not repeat the same matches. Scores are printed
 * from the listed team's point of view ("1:6" for an away 1-6 loss).
 */
function parseLastMatchesFootball($) {
  const teams = [];
  $('.lf-panel-all .lf-col').each((_, col) => {
    const $col = $(col);
    const name =
      clean($col.find('.lf-head .lf-team b').first().text()) ||
      clean($col.find('.lf-team span').first().text());
    if (!name) return;

    const matches = $col
      .find('.lf-list .lf-r')
      .map((__, item) => {
        const $item = $(item);
        const venue = clean($item.find('.lf-m').first().text()).toLowerCase();
        const $score = $item.find('.lf-s').first();
        const scoreClass = clean($score.attr('class') || '');
        return {
          venue: venue.startsWith('h') ? 'H' : venue.startsWith('a') ? 'A' : null,
          date: clean($item.find('.lf-d').first().text()) || null,
          opponent: clean($item.find('.lf-o').first().text()) || null,
          score: clean($score.text()) || null,
          result: /lf-xw/.test(scoreClass)
            ? 'W'
            : /lf-xl/.test(scoreClass)
              ? 'L'
              : /lf-xd/.test(scoreClass)
                ? 'D'
                : null,
        };
      })
      .get()
      .filter((m) => m.opponent || m.score);

    teams.push({ name, matches });
  });
  return teams;
}

function parseHeadToHeadBasketball($) {
  const $title = $('h3.section-title')
    .filter((_, el) => /head-to-head/i.test($(el).text()))
    .first();
  if (!$title.length) return [];
  const $card = $title.nextAll('.match-card').first();
  if (!$card.length) return [];

  return $card
    .find('div')
    .filter((_, row) => $(row).children('span').length >= 4)
    .map((_, row) => {
      const spans = $(row).children('span');
      const score = clean(spans.eq(2).text());
      const home = clean(spans.eq(1).text());
      const away = clean(spans.eq(3).text());
      if (!score || !home || !away) return null;
      const homeStrong = /font-weight:\s*800/.test(spans.eq(1).attr('style') || '');
      const awayStrong = /font-weight:\s*800/.test(spans.eq(3).attr('style') || '');
      const [homeScore, awayScore] = score.split(/\s*[:\-–]\s*/);
      return {
        date: clean(spans.eq(0).text()) || null,
        home,
        away,
        homeScore: homeScore || null,
        awayScore: awayScore || null,
        homeWon: homeStrong || (!awayStrong && Number(homeScore) > Number(awayScore)),
        awayWon: awayStrong,
      };
    })
    .get()
    .filter(Boolean);
}

function parseHeadToHeadFootball($) {
  const $title = $('h3.section-title')
    .filter((_, el) => /head-to-head/i.test($(el).text()))
    .first();
  if (!$title.length) return [];
  const $card = $title.nextAll('.lf-card').first();
  if (!$card.length) return [];

  return $card
    .find('.h2-r')
    .map((_, row) => {
      const $row = $(row);
      const home = clean($row.find('.h2-h').first().text());
      const away = clean($row.find('.h2-a').first().text());
      const score = clean($row.find('.h2-sc').first().text());
      if (!home || !away || !score) return null;
      const [homeScore, awayScore] = score.split(/\s*[:\-–]\s*/);
      return {
        date: clean($row.find('.lf-d').first().text()) || null,
        home,
        away,
        homeScore: homeScore || null,
        awayScore: awayScore || null,
        homeWon: /h2-win/.test(clean($row.find('.h2-h').attr('class') || '')),
        awayWon: /h2-win/.test(clean($row.find('.h2-a').attr('class') || '')),
      };
    })
    .get()
    .filter(Boolean);
}

function parseTable($, sport) {
  const football = normalizeSport(sport) === 'football';
  const $title = $('h3.section-title')
    .filter((_, el) => /league table|overall table/i.test($(el).text()))
    .first();
  if (!$title.length) return null;
  const $wrap = $title.nextAll('.lh-tables').first();
  if (!$wrap.length) return null;

  const season = clean($wrap.find('.lh-season').first().text()) || null;
  const tabs = [];

  $wrap.find('.lh-panel').each((_, panel) => {
    const $panel = $(panel);
    const raw = (/lh-panel-([a-z0-9]+)/.exec(clean($panel.attr('class') || '')) || [])[1];
    if (!raw) return;
    const key = raw === 'all' ? 'total' : raw;
    const label = clean($wrap.find(`.lh-tabs label[for$="-${raw}"]`).first().text()) || key;

    const rows = [];
    $panel.find('tbody tr').each((__, tr) => {
      const $tr = $(tr);
      const cells = $tr.children('td');
      if (cells.length < 6) return;
      const cell = (i) => clean(cells.eq(i).text()) || null;
      const row = {
        rank: cell(0),
        team: clean($tr.find('.lh-name').first().text()) || clean(cells.eq(1).text()),
        played: cell(2),
        wins: cell(3),
        draws: null,
        losses: null,
        score: null,
        pct: null,
        points: null,
        highlighted: clean($tr.attr('class') || '').includes('lh-hl'),
      };
      if (football) {
        row.draws = cell(4);
        row.losses = cell(5);
        row.score = (/(\d+)\s*:\s*(\d+)/.exec(cell(6) || '') || [])[0] || cell(6);
        row.points = cell(7);
      } else {
        row.losses = cell(4);
        row.score = cell(5);
        row.pct = cell(6);
      }
      rows.push(row);
    });

    if (!rows.length) return;
    tabs.push({ key, label, rows });
  });

  return tabs.length ? { season, tabs } : null;
}

const normTeam = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Drop the fixture being priced from a team's recent-results list. Vitibet's
 * panels are historical already, but the model must never see the match it is
 * predicting, so this guards the input by opponent and exact score.
 */
function withoutCurrentMatch(matches = [], opponent, scored, conceded) {
  let dropped = false;
  return matches.filter((match) => {
    if (dropped || !opponent) return true;
    if (normTeam(match.opponent) !== normTeam(opponent)) return true;
    const parts = /(\d+)\s*[:\-]\s*(\d+)/.exec(String(match.score ?? ''));
    if (!parts || Number(parts[1]) !== scored || Number(parts[2]) !== conceded) return true;
    dropped = true;
    return false;
  });
}

function withoutCurrentH2H(rows = [], homeName, awayName, finalScore) {
  if (!finalScore) return rows;
  let dropped = false;
  return rows.filter((row) => {
    if (dropped) return true;
    const direct = normTeam(row.home) === normTeam(homeName) && normTeam(row.away) === normTeam(awayName);
    const reverse = normTeam(row.home) === normTeam(awayName) && normTeam(row.away) === normTeam(homeName);
    if (!direct && !reverse) return true;
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    const looksCurrent =
      (hs === finalScore.home && as === finalScore.away) || (hs === finalScore.away && as === finalScore.home);
    if (!looksCurrent) return true;
    dropped = true;
    return false;
  });
}

/**
 * Standings fetched after a match include its result. The model is a
 * pre-match model, so take that one game back out of the two teams' rows for
 * the copy used by analytics; the table shown in the UI keeps the real
 * standings. Rows that do not carry a played count (unfilled group tables) are
 * left alone rather than pushed negative.
 */
function tableWithoutCurrent(table, { sport, homeName, awayName, finalScore }) {
  if (!table || !finalScore || !homeName || !awayName) return table;
  if (!Number.isFinite(finalScore.home) || !Number.isFinite(finalScore.away)) return table;

  const football = normalizeSport(sport) === 'football';
  const rowsByTab = new Map(table.tabs.map((tab) => [tab.key, tab.rows.map((row) => ({ ...row }))]));
  const homeWon = finalScore.home > finalScore.away;
  const draw = finalScore.home === finalScore.away;

  const adjust = (tabKey, teamName, scored, conceded, outcome) => {
    const row = (rowsByTab.get(tabKey) || []).find((entry) => normTeam(entry.team) === normTeam(teamName));
    if (!row) return;
    const played = Number.parseInt(String(row.played ?? ''), 10);
    if (!Number.isFinite(played) || played < 1) return;
    row.played = String(played - 1);
    const bucket = outcome === 'W' ? 'wins' : outcome === 'L' ? 'losses' : 'draws';
    const games = Number.parseInt(String(row[bucket] ?? ''), 10);
    if (Number.isFinite(games) && games > 0) row[bucket] = String(games - 1);
    const goals = /(\d+)\s*:\s*(\d+)/.exec(String(row.score ?? ''));
    if (goals) {
      const gf = Math.max(0, Number(goals[1]) - scored);
      const ga = Math.max(0, Number(goals[2]) - conceded);
      row.score = String(row.score).replace(goals[0], `${gf}:${ga}`);
    }
    if (football && row.points != null) {
      const points = Number.parseInt(String(row.points), 10);
      const delta = outcome === 'W' ? 3 : outcome === 'D' ? 1 : 0;
      if (Number.isFinite(points) && points >= delta) row.points = String(points - delta);
    }
  };

  adjust('total', homeName, finalScore.home, finalScore.away, draw ? 'D' : homeWon ? 'W' : 'L');
  adjust('total', awayName, finalScore.away, finalScore.home, draw ? 'D' : homeWon ? 'L' : 'W');
  adjust('home', homeName, finalScore.home, finalScore.away, draw ? 'D' : homeWon ? 'W' : 'L');
  adjust('away', awayName, finalScore.away, finalScore.home, draw ? 'D' : homeWon ? 'L' : 'W');

  return { ...table, tabs: table.tabs.map((tab) => ({ ...tab, rows: rowsByTab.get(tab.key) })) };
}

function parseMatchDetail(html, fixtureId, leagueId, sport) {
  const cfg = sportConfig(sport);
  const football = cfg.key === 'football';
  const $ = cheerio.load(html);
  const scoreboard = parseScoreboard($, sport);
  const extras = parseMatchExtras($);
  const homeName = scoreboard.home?.name ?? null;
  const awayName = scoreboard.away?.name ?? null;
  // Comparison cards are missing on thin league pages, but the page still
  // links both clubs from the recent-results and table sections.
  const linkFor = (name) =>
    extras.links.find((link) => link.name && normTeam(link.name) === normTeam(name)) || null;
  const homeLink = extras.homeLink || linkFor(homeName);
  const awayLink = extras.awayLink || linkFor(awayName);
  const finalScore =
    scoreboard.status === 'finished' && scoreboard.homeScore != null && scoreboard.awayScore != null
      ? { home: Number(scoreboard.homeScore), away: Number(scoreboard.awayScore) }
      : null;

  const recent = football ? parseLastMatchesFootball($) : parseLastMatchesBasketball($);
  const lastMatches = finalScore
    ? recent.map((team) => {
        const isHome = normTeam(team.name) === normTeam(homeName);
        const opponent = isHome ? awayName : homeName;
        return {
          ...team,
          matches: withoutCurrentMatch(
            team.matches,
            opponent,
            isHome ? finalScore.home : finalScore.away,
            isHome ? finalScore.away : finalScore.home
          ),
        };
      })
    : recent;
  const headToHead = withoutCurrentH2H(
    football ? parseHeadToHeadFootball($) : parseHeadToHeadBasketball($),
    homeName,
    awayName,
    finalScore
  );
  const table = parseTable($, sport);
  const modelTable = tableWithoutCurrent(table, { sport: cfg.key, homeName, awayName, finalScore });
  const prediction = predictTotal({
    table: modelTable,
    lastMatches,
    leagueId: leagueId ? String(leagueId) : null,
    homeName,
    awayName,
    sport: cfg.key,
  });
  const published = parseAnalytics($);
  const publishedProbs = Object.values(published?.probabilities || {}).reduce(
    (sum, pct) => sum + (Number.parseFloat(pct) || 0),
    0
  );
  const hasPublished = Boolean(published && (Number(published.index) !== 0 || publishedProbs > 0));

  // Our own analytics, calculated even when Vitibet published a block, because
  // the extra markets (double chance, goals, BTTS) exist only in this model.
  const calculated =
    estimateAnalytics({
      lastMatches,
      table: modelTable,
      leagueId: leagueId ? String(leagueId) : null,
      homeName,
      awayName,
      sport: cfg.key,
      prediction,
    }) || null;

  return {
    fixtureId: String(fixtureId),
    leagueId: leagueId ? String(leagueId) : null,
    sport: cfg.key,
    sportLabel: cfg.label,
    ...scoreboard,
    status: scoreboard.status,
    analytics: hasPublished ? published : calculated,
    calculated,
    published: hasPublished ? published : null,
    prediction,
    homeTeamId: homeLink?.teamId ?? null,
    awayTeamId: awayLink?.teamId ?? null,
    homeProfileUrl: homeLink?.url ?? null,
    awayProfileUrl: awayLink?.url ?? null,
    odds: extras.odds,
    community: extras.community,
    bars: extras.bars,
    vstQuery: extras.vstQuery,
    lastMatches,
    headToHead,
    table,
    modelTable,
    detailUrl: DETAIL(sport, fixtureId, leagueId),
  };
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function download(url, sport) {
  const cfg = sportConfig(sport);
  return getHtml(url, { referer: `${SITE}/index.php?clanek=quicktips&sekce=${cfg.sekce}&lang=en` });
}

export async function fetchDay(date, sport = 'basketball') {
  const cfg = sportConfig(sport);
  const key = `${cfg.key}:${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.payload, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    // getHtml already retries with backoff; a second wrapper here would double
    // the request count exactly when the site is throttling us. When the day is
    // already cached, serve that copy rather than failing the page.
    let html;
    try {
      html = await download(PAGE(cfg.key, date), cfg.key);
    } catch (error) {
      if (hit) return { ...hit.payload, cached: true, stale: true };
      throw error;
    }

    if (!/livescore-match-row|livescore-sys-wrapper/.test(html)) {
      throw new Error('Unexpected page layout from Vitibet');
    }

    const payload = parsePage(html, date, cfg.key);
    payload.previousDate = addDays(date, -1);
    payload.nextDate = addDays(date, 1);
    cache.set(key, { at: Date.now(), payload });
    return { ...payload, cached: false };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/**
 * Calculated picks and predicted totals for a day's matches.
 *
 * Vitibet prints no analytics (and no tip) for matches without enough league
 * games, and never publishes a total, so both numbers have to be rebuilt from
 * each match page. Every fixture is included — tipped, finished or not — since
 * the total is a prediction about the match, never the published score. The
 * walk is cursor-sized so the client can fill the list in progressively
 * instead of blocking on ~100 match pages at once.
 */
export async function fetchPicks(date, { sport = 'basketball', cursor = 0, limit = 6 } = {}) {
  const cfg = sportConfig(sport);
  const day = await fetchDay(date, cfg.key);
  const needs = day.leagues.flatMap((league) => league.matches).filter((match) => match.fixtureId);

  const start = Math.max(0, Math.min(Math.trunc(cursor) || 0, needs.length));
  const size = Math.max(1, Math.min(Math.trunc(limit) || 6, 12));
  const batch = needs.slice(start, start + size);

  const picks = {};
  await Promise.all(
    batch.map(async (match) => {
      try {
        const detail = await fetchMatch(match.fixtureId, match.leagueId, cfg.key);
        const calculated = detail?.calculated;
        const analytics = calculated || detail?.analytics;
        const pick = analytics ? analytics.pick || pickFromProbabilities(analytics.probabilities) : null;
        const prediction = detail?.prediction || null;
        if (!pick && !prediction) return;
        picks[match.fixtureId] = {
          pick: pick?.key ?? null,
          pct: pick?.pct ?? null,
          margin: pick?.margin ?? null,
          index: analytics?.index ?? null,
          probabilities: analytics?.probabilities ?? null,
          best: calculated?.best ?? null,
          markets: calculated?.markets ?? null,
          estimated: true,
          total: prediction?.total ?? null,
          score: prediction ? { home: prediction.home, away: prediction.away } : null,
        };
      } catch {
        // One unreadable match page should not sink the batch.
      }
    })
  );

  const nextCursor = start + batch.length;
  return {
    date,
    sport: cfg.key,
    total: needs.length,
    cursor: start,
    nextCursor,
    done: nextCursor >= needs.length,
    picks,
  };
}

/**
 * A real match page carries at least one of: the Vitibet analytics block, the
 * Calculated Form / Team Power bars, or a predicted score. A page with none of
 * the three came back stripped rather than belonging to a competition the site
 * simply does not cover, so it is worth re-asking. Thin cup pages still carry
 * a prediction, so they are not treated this way.
 */
const looksDegraded = (payload) =>
  Boolean(payload) &&
  payload.sport === 'football' &&
  !payload.bars?.length &&
  !payload.published?.probabilities &&
  !payload.prediction;

export async function fetchMatch(fixtureId, leagueId, sport = 'basketball') {
  const cfg = sportConfig(sport);
  const key = `${cfg.key}:${fixtureId}:${leagueId || ''}`;
  const hit = matchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.payload, cached: true };
  if (matchInFlight.has(key)) return matchInFlight.get(key);

  const url = DETAIL(cfg.key, fixtureId, leagueId);
  const job = (async () => {
    let payload = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let html;
      try {
        html = await download(url, cfg.key);
      } catch (error) {
        // A previously scraped match page is better than an error page while the
        // source is rate-limiting us.
        if (hit) return { ...hit.payload, cached: true, stale: true };
        throw error;
      }

      if (!/match-scoreboard/.test(html)) {
        if (attempt === 0) continue;
        throw new Error('Unexpected match page layout from Vitibet');
      }

      payload = parseMatchDetail(html, fixtureId, leagueId, cfg.key);
      payload.scrapedAt = new Date().toISOString();
      if (!looksDegraded(payload)) break;
      // Give the source a moment and ask again rather than recording the
      // fixture as one that has no pre-match data.
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // A league-filtered page shows only that competition's recent results. For
    // cup ties that can leave a team with a single game, which is not enough to
    // predict a total. Ask once without the filter and keep its prediction; the
    // filtered page is still the better one for the table and league context.
    if (payload && !payload.prediction && leagueId) {
      try {
        const altHtml = await download(DETAIL(cfg.key, fixtureId, null), cfg.key);
        if (/match-scoreboard/.test(altHtml)) {
          const alt = parseMatchDetail(altHtml, fixtureId, null, cfg.key);
          if (alt.prediction) payload.prediction = alt.prediction;
        }
      } catch {
        // Everything except the total still comes from the filtered page.
      }
    }

    const degraded = looksDegraded(payload);
    if (degraded && hit) return { ...hit.payload, cached: true, stale: true };
    // A stripped page is never cached, so the next attempt can still succeed.
    if (!degraded) matchCache.set(key, { at: Date.now(), payload });
    return { ...payload, cached: false, degraded };
  })().finally(() => matchInFlight.delete(key));

  matchInFlight.set(key, job);
  return job;
}
