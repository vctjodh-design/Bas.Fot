/**
 * Parsers for the two Vitibet pages the processing tab collects:
 *
 *   club profile  /index.php?clanek=club-profile&team_id=…  (team season stats)
 *   competition   /football/tips/<league>/<country>/<id>/   (standings, goals)
 *
 * Plus the match-page extras that are not part of the match model: stake
 * shares + odds ("where the money goes"), the community box and the free
 * corners table that Vitibet loads as an HTML fragment.
 *
 * Everything here is source data, stored as-is. Calculated numbers live in
 * lib/analytics.js and are always labelled as calculated in the UI.
 */

import * as cheerio from 'cheerio';
import { absolute, getHtml, SITE } from './http.js';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const num = (value) => {
  const n = Number.parseFloat(String(value ?? '').replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const normTeam = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const teamIdFromHref = (href) => {
  const match = /[?&]team_id=(\d+)/.exec(String(href || ''));
  return match ? match[1] : null;
};

/* ---------------- club profile ---------------- */

function parseStatsTable($, $table) {
  const columns = $table
    .find('thead tr')
    .first()
    .children('th')
    .map((_, el) => clean($(el).text()))
    .get();
  const rows = [];
  const sections = [];
  let section = null;

  $table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (!cells.length) return;
    const texts = cells.map((__, td) => clean($(td).text())).get();
    const rest = texts.slice(1).filter(Boolean);
    if (!rest.length) {
      section = texts[0];
      sections.push(section);
      return;
    }
    const row = { label: texts[0], section };
    columns.slice(1).forEach((column, i) => {
      row[column] = texts[i + 1] ?? null;
    });
    if (!columns.length) {
      row.Home = texts[1] ?? null;
      row.Away = texts[2] ?? null;
      row.Total = texts[3] ?? null;
    }
    rows.push(row);
  });

  return { columns, rows, sections };
}

const statRow = (table, label) =>
  table?.rows.find((row) => row.label.toLowerCase() === String(label).toLowerCase()) || null;

const statNum = (table, label, column = 'Total') => num(statRow(table, label)?.[column]);

function parseRecord(value) {
  const parts = String(value || '').split(/\s*[-–]\s*/).map((part) => num(part));
  if (parts.length < 3 || parts.some((part) => part == null)) return null;
  return { wins: parts[0], draws: parts[1], losses: parts[2] };
}

function parseGoals(value) {
  const match = /(\d+)\s*[:–-]\s*(\d+)/.exec(String(value || ''));
  return match ? { for: Number(match[1]), against: Number(match[2]) } : null;
}

function clubForm($, $box) {
  return $box
    .find('.form-badge')
    .map((_, dot) => {
      const cls = clean($(dot).attr('class'));
      if (/form-w/.test(cls)) return 'W';
      if (/form-d/.test(cls)) return 'D';
      if (/form-l/.test(cls)) return 'L';
      return null;
    })
    .get()
    .filter(Boolean);
}

const stylePct = (style) => {
  const match = /(\d+(?:\.\d+)?)%/.exec(String(style || ''));
  return match ? Number(match[1]) : null;
};

const sectionTitleCard = ($, pattern) => {
  const $title = $('h3.section-title')
    .filter((_, el) => pattern.test(clean($(el).text())))
    .first();
  return $title.length ? $title.nextAll('.match-card').first() : $();
};

/** "Led at Halftime" / "Trailed at Halftime" cards on the club page. */
function parseHalftime($) {
  const $card = sectionTitleCard($, /halftime/i);
  if (!$card.length) return null;
  const boxes = $card
    .find('.stat-box')
    .map((_, el) => {
      const $box = $(el);
      return {
        title: clean($box.find('.stat-box-title').first().text()) || null,
        value: clean($box.find('.stat-box-value').first().text()) || null,
        notes: $box
          .find('.stat-box-sub')
          .map((__, note) => clean($(note).text()))
          .get()
          .filter(Boolean),
        pct: stylePct($box.find('.prog-fill').first().attr('style')),
      };
    })
    .get();
  return boxes.length ? boxes : null;
}

/** Points Accumulation Trend SVG: cumulative points after each league match. */
function parsePointsTrend($) {
  const $svg = $('.chart-container svg.chart-svg').first();
  if (!$svg.length) return null;
  const $lines = $svg.find('line');
  const yTop = num($lines.eq(0).attr('y1'));
  const yBottom = num($lines.eq(1).attr('y1'));
  const topValue = num($svg.find('text').first().text());
  if (!Number.isFinite(yTop) || !Number.isFinite(yBottom) || !Number.isFinite(topValue)) return null;

  const points = [];
  $svg.find('circle').each((_, el) => {
    const cy = num($(el).attr('cy'));
    const match = num($(el).next('text').text());
    if (cy == null || match == null) return;
    const value = Math.round(((yBottom - cy) / (yBottom - yTop)) * topValue);
    points.push({ match, points: value });
  });
  return points.length ? points : null;
}

/** Team Streaks card: current form plus the three longest run values. */
function parseStreaks($) {
  const $card = sectionTitleCard($, /team streaks/i);
  if (!$card.length) return null;
  const out = { currentForm: clubForm($, $card) };
  $card.find('.stat-box').each((_, el) => {
    const $box = $(el);
    const title = clean($box.find('.stat-box-title').first().text()).toLowerCase();
    const value = clean($box.find('.stat-box-value').first().text());
    if (!value) return;
    if (/win streak/.test(title)) out.longestWinStreak = value;
    else if (/unbeaten/.test(title)) out.longestUnbeatenRun = value;
    else if (/conceding|clean sheet/.test(title)) out.longestCleanSheetRun = value;
  });
  return Object.keys(out).length > 1 ? out : null;
}

export function parseClubProfile(html, { teamId = null, name = null, url = null, sport = 'football' } = {}) {
  const $ = cheerio.load(html);
  const header = $('.club-header-info h1').first();

  // Smaller leagues often have no profile data at all; Vitibet answers with
  // "No matches found in database for this team." Keep the URL and record the
  // empty state instead of treating it as a broken page.
  if (!header.length) {
    const body = clean($('body').text());
    const pageName = clean($('title').text()).split(/[–-]/)[0].trim();
    return {
      teamId: teamId || teamIdFromHref(url),
      sport,
      name: name || pageName || 'Team',
      url: url || null,
      logo: null,
      season: null,
      matches: null,
      form: [],
      highlights: [],
      overall: null,
      halves: null,
      summary: {},
      recentMatches: [],
      standings: [],
      available: false,
      note: /no matches found in database/i.test(body)
        ? 'Vitibet has no stats for this team (its database holds no matches for it).'
        : 'Vitibet returned a club page without the profile sections.',
      scrapedAt: new Date().toISOString(),
    };
  }

  const teamName = clean(header.text()) || name || 'Team';
  const meta = clean($('.club-header-info p').first().text());
  const logo = absolute($('.club-header img').first().attr('src'));
  const season = (/Season\s+([0-9]{4}(?:\/[0-9]{4})?)/i.exec(meta) || [])[1] || null;
  const matches = num((/(\d+)\s+Matches/i.exec(meta) || [])[1]);

  const highlights = [];
  let form = [];
  $('.stat-box').each((_, el) => {
    const $box = $(el);
    const title = clean($box.find('.stat-box-title').first().text());
    const letters = clubForm($, $box);
    if (letters.length) form = letters;
    highlights.push({
      title,
      value: clean($box.find('.stat-box-value').first().text()) || letters.join(''),
      note: clean($box.find('.stat-box-sub').first().text()) || null,
    });
  });

  const tables = $('table.stats-table')
    .map((_, table) => parseStatsTable($, $(table)))
    .get();
  const overall = tables[0] || null;
  const halves = tables[1] || null;

  const record = parseRecord(statRow(overall, 'Wins / Draws / Losses')?.Total);
  const goals = parseGoals(statRow(overall, 'Goals')?.Total);
  const homeRecord = parseRecord(statRow(overall, 'Wins / Draws / Losses')?.Home);
  const awayRecord = parseRecord(statRow(overall, 'Wins / Draws / Losses')?.Away);

  const recentMatches = [];
  $('.match-list-item').each((_, el) => {
    const $item = $(el);
    const links = $item.find('.match-teams a');
    const home = clean(links.eq(0).text());
    const away = clean(links.eq(1).text());
    const score = clean($item.find('.match-score').first().text());
    const parts = /(\d+)\s*[:–-]\s*(\d+)/.exec(score);
    const badge = clean($item.find('.form-badge').last().attr('class'));
    const isHome = normTeam(home) === normTeam(teamName);
    const scored = parts ? Number(isHome ? parts[1] : parts[2]) : null;
    const conceded = parts ? Number(isHome ? parts[2] : parts[1]) : null;
    const result = /form-w/.test(badge)
      ? 'W'
      : /form-l/.test(badge)
        ? 'L'
        : /form-d/.test(badge)
          ? 'D'
          : scored != null && conceded != null
            ? scored > conceded
              ? 'W'
              : scored < conceded
                ? 'L'
                : 'D'
            : null;

    recentMatches.push({
      date: clean($item.find('.match-date').first().text()) || null,
      home: home || null,
      away: away || null,
      opponent: isHome ? away || null : home || null,
      venue: isHome ? 'H' : 'A',
      score: score || null,
      scored,
      conceded,
      result,
      homeTeamId: teamIdFromHref(links.eq(0).attr('href')),
      awayTeamId: teamIdFromHref(links.eq(1).attr('href')),
    });
  });

  const miniTables = [];
  $('.mini-table').each((_, el) => {
    const $mini = $(el);
    const label = clean($mini.find('.mini-table-title').first().text()) || 'Table';
    const rows = [];
    $mini.find('table.standings-table tbody tr').each((__, tr) => {
      const $tr = $(tr);
      const cells = $tr.children('td');
      if (cells.length < 4) return;
      const teamCell = $tr.find('td.s-team');
      const $teamClone = teamCell.clone();
      $teamClone.find('.lhf-sub').remove();
      const team = clean($teamClone.text()) || clean(cells.eq(1).text());
      rows.push({
        rank: clean(cells.eq(0).text()) || null,
        team,
        played: clean(cells.eq(2).text()) || null,
        wins: clean(cells.eq(3).text()) || null,
        draws: clean(cells.eq(4).text()) || null,
        losses: clean(cells.eq(5).text()) || null,
        goals: clean(cells.eq(6).text()) || null,
        points: clean(cells.eq(7).text()) || null,
        active: clean($tr.attr('class') || '').includes('row-active'),
      });
    });
    const own = rows.find((row) => row.active) || rows.find((row) => normTeam(row.team) === normTeam(teamName));
    miniTables.push({ label, position: own || null, teams: rows.length });
  });

  const teamIdFromPage = teamId || teamIdFromHref(url);

  return {
    teamId: teamIdFromPage,
    sport,
    name: teamName,
    url: url || null,
    logo,
    season,
    matches,
    form,
    highlights,
    overall: overall ? { columns: overall.columns, rows: overall.rows, sections: overall.sections } : null,
    halves: halves ? { columns: halves.columns, rows: halves.rows, sections: halves.sections } : null,
    summary: {
      played: matches,
      record,
      homeRecord,
      awayRecord,
      goals,
      avgScored: statNum(overall, 'Avg Scored'),
      avgConceded: statNum(overall, 'Avg Conceded'),
      winRate: statNum(overall, 'Win Rate'),
      bttsPct: statNum(overall, 'Both Teams Scored'),
      cleanSheetPct: statNum(overall, 'Clean Sheets'),
      failedToScorePct: statNum(overall, 'Failed to Score'),
      over15Pct: statNum(overall, 'Over 1.5 Goals'),
      over25Pct: statNum(overall, 'Over 2.5 Goals'),
      over35Pct: statNum(overall, 'Over 3.5 Goals'),
      firstHalf: halves ? statRow(halves, 'Avg Scored') || null : null,
      firstHalfGoals: halves ? parseGoals(statRow(halves, 'Goals')?.['1st Half']) : null,
      secondHalfGoals: halves ? parseGoals(statRow(halves, 'Goals')?.['2nd Half']) : null,
    },
    recentMatches,
    standings: miniTables,
    halftime: parseHalftime($),
    streaks: parseStreaks($),
    pointsTrend: parsePointsTrend($),
    available: true,
    note: null,
    scrapedAt: new Date().toISOString(),
  };
}

/* ---------------- competition page ---------------- */

function parseStandings($, $table) {
  const headers = $table
    .find('thead th')
    .map((_, el) => clean($(el).text()))
    .get();
  const index = (needle) => headers.findIndex((header) => needle.test(header));

  const rankAt = index(/^#$/);
  const teamAt = index(/team|tým/i);
  const playedAt = index(/^p$/i);
  const winsAt = index(/^w$/i);
  const drawsAt = index(/^d$/i);
  const lossesAt = index(/^l$/i);
  const goalsAt = index(/goals|score|\+\/-/i);
  const pointsAt = index(/pts/i);
  const pctAt = index(/^%$/);

  const rows = [];
  $table.find('tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.children('td');
    if (!cells.length) return;
    const $teamClone = (teamAt >= 0 ? cells.eq(teamAt) : cells.eq(1)).clone();
    $teamClone.find('.lhf-sub').remove();
    const team = clean($teamClone.text());
    if (!team) return;
    const text = (i) => (i >= 0 ? clean(cells.eq(i).text()) : null);
    rows.push({
      rank: text(rankAt) || clean(cells.eq(0).text()) || null,
      team,
      played: text(playedAt),
      wins: text(winsAt),
      draws: text(drawsAt),
      losses: text(lossesAt),
      goals: text(goalsAt),
      points: text(pointsAt),
      pct: text(pctAt),
      form: $tr
        .find('.form-badge')
        .map((__, dot) => clean($(dot).text()) || (/(form-[wdl])/.exec(clean($(dot).attr('class') || '')) || [])[1]?.slice(-1).toUpperCase() || null)
        .get()
        .filter(Boolean),
    });
  });

  return { headers, rows };
}

function sectionTable($, $heading) {
  const siblings = $heading.nextUntil('h3');
  return siblings.find('table').first().length ? siblings.find('table').first() : siblings.find('.table-container table').first();
}

/**
 * Basketball competition pages have no modern-standings tables; they use the
 * tabbed .lh-tables card (total / home / away / form / quarters).
 */
function parseLegacyTables($, tables) {
  const map = {
    total: 'all',
    home: 'home',
    away: 'away',
    form: 'form',
    q1: 'firstQuarter',
    q2: 'secondQuarter',
  };

  $('.lh-panel').each((_, panel) => {
    const raw = (/lh-panel-([a-z0-9]+)/.exec(clean($(panel).attr('class') || '')) || [])[1];
    const key = map[raw];
    if (!key) return;
    const rows = [];
    $(panel).find('tbody tr').each((__, tr) => {
      const $tr = $(tr);
      const cells = $tr.children('td');
      if (cells.length < 6) return;
      const team = clean($tr.find('.lh-name').first().text()) || clean(cells.eq(1).text());
      if (!team) return;
      rows.push({
        rank: clean(cells.eq(0).text()) || null,
        team,
        played: clean(cells.eq(2).text()) || null,
        wins: clean(cells.eq(3).text()) || null,
        draws: null,
        losses: clean(cells.eq(4).text()) || null,
        goals: clean(cells.eq(5).text()) || null,
        points: null,
        pct: clean(cells.eq(6).text()) || null,
        form: $tr
          .find('.form-badge')
          .map((___, dot) => clean($(dot).text()) || null)
          .get()
          .filter(Boolean),
      });
    });
    if (rows.length) tables[key] = { headers: ['#', 'Team', 'P', 'W', 'L', 'Score', '%'], rows };
  });
}

function parseGoalDistribution($, $table) {
  const headers = $table
    .find('thead th')
    .map((_, el) => clean($(el).text()))
    .get();
  const avgAt = headers.findIndex((header) => /avg/i.test(header));
  const rows = [];
  $table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (!cells.length) return;
    const team = clean(cells.eq(0).text());
    if (!team) return;
    const buckets = {};
    headers.forEach((header, i) => {
      if (/^\d+\+?$/.test(header)) buckets[header] = num(cells.eq(i).text());
    });
    rows.push({
      team,
      played: num(cells.eq(1).text()),
      average: num(cells.eq(avgAt >= 0 ? avgAt : 2).text()),
      buckets,
    });
  });
  return rows;
}

function parseOverUnder($, $table) {
  const rows = [];
  $table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (!cells.length) return;
    const team = clean(cells.eq(0).text());
    if (!team) return;
    const over = /(\d+)%\s*\((\d+)\)/.exec(clean(cells.eq(2).text()));
    const under = /(\d+)%\s*\((\d+)\)/.exec(clean(cells.eq(3).text()));
    rows.push({
      team,
      played: num(cells.eq(1).text()),
      overPct: over ? Number(over[1]) : null,
      overCount: over ? Number(over[2]) : null,
      underPct: under ? Number(under[1]) : null,
      underCount: under ? Number(under[2]) : null,
    });
  });
  return rows;
}

function parseScorerRows($, $heading) {
  return $heading
    .nextUntil('h3')
    .find('.scorer-row')
    .map((_, el) => {
      const $row = $(el);
      return {
        name: clean($row.find('.scorer-name').first().text()) || null,
        team: clean($row.find('.scorer-team').first().text()) || null,
        value:
          clean($row.find('.stat-badge-goals').first().text()) ||
          clean($row.find('.stat-badge-assists').first().text()) ||
          clean($row.find('.stat-badge').first().text()) ||
          null,
      };
    })
    .get();
}

/** Recent Results card on the competition page (last 10 played matches). */
function parseRecentMatches($) {
  const rows = [];
  $('.match-grid .match-card-modern').each((_, el) => {
    const $card = $(el);
    const href = $card.attr('href') || '';
    const names = $card
      .find('.mc-team span')
      .map((__, span) => clean($(span).text()))
      .get();
    if (names.length < 2) return;
    const score = clean($card.find('.mc-score').first().text());
    const parts = /(\d+)\s*[:–-]\s*(\d+)/.exec(score);
    const time = clean($card.find('.mc-time').first().text()) || null;
    rows.push({
      fixtureId: (/([?&]fixture_id=(\d+))/.exec(href) || [])[2] || null,
      url: href ? absolute(href) : null,
      date: (/(\d{1,2}\.\d{1,2}\.)/.exec(time || '') || [])[1] || null,
      time,
      status: clean($card.find('.mc-center div').last().text()) || null,
      home: names[0],
      away: names[1],
      score: score || null,
      homeScore: parts ? Number(parts[1]) : null,
      awayScore: parts ? Number(parts[2]) : null,
    });
  });
  return rows;
}

/** League-wide widget: average goals per match plus the home/away points split. */
function parseLeagueStats($) {
  const $widget = $('.league-stats-widget').first();
  if (!$widget.length) return null;
  const stats = {};
  $widget.find('.stat-card').each((_, el) => {
    const $card = $(el);
    const label = clean($card.find('.stat-label').first().text()).toLowerCase();
    if (/avg goals/.test(label)) {
      const value = num($card.find('.stat-value').first().text());
      if (value > 0) stats.avgGoalsPerMatch = value;
    }
    if (/points won/.test(label)) {
      const text = clean($card.text());
      const home = num((/Home:\s*([\d.]+)%/i.exec(text) || [])[1]);
      const away = num((/Away:\s*([\d.]+)%/i.exec(text) || [])[1]);
      if (home > 0) stats.pointsWonHomePct = home;
      if (away > 0) stats.pointsWonAwayPct = away;
    }
  });
  return Object.keys(stats).length ? stats : null;
}

/** Market rates from the competition's recent results (counts over matches). */
export function ratesFromMatches(matches = []) {
  const played = matches.filter(
    (match) => Number.isFinite(match.homeScore) && Number.isFinite(match.awayScore)
  );
  if (!played.length) return null;

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let btts = 0;
  let over25 = 0;
  let cleanSheets = 0;
  let goals = 0;
  for (const match of played) {
    const home = match.homeScore;
    const away = match.awayScore;
    const total = home + away;
    goals += total;
    if (home > away) homeWins += 1;
    else if (home === away) draws += 1;
    else awayWins += 1;
    if (home > 0 && away > 0) btts += 1;
    if (total > 2.5) over25 += 1;
    if (home === 0) cleanSheets += 1;
    if (away === 0) cleanSheets += 1;
  }
  const sample = played.length;
  return {
    sample,
    goals,
    homeWins,
    draws,
    awayWins,
    btts,
    over25,
    cleanSheets,
    avgGoals: round(goals / sample, 2),
    homeWinPct: round((100 * homeWins) / sample, 1),
    drawPct: round((100 * draws) / sample, 1),
    awayWinPct: round((100 * awayWins) / sample, 1),
    bttsPct: round((100 * btts) / sample, 1),
    over25Pct: round((100 * over25) / sample, 1),
    cleanSheetPct: round((100 * cleanSheets) / (2 * sample), 1),
  };
}

/** Season rates taken from the home/away tables and the Under/Over 2.5 table. */
function seasonRatesFromTables(tables = {}, overUnder = []) {
  const sum = (rows, key) => rows.reduce((total, row) => total + (num(row[key]) || 0), 0);
  const homeRows = tables.home?.rows || [];
  const awayRows = tables.away?.rows || [];
  const played = sum(homeRows, 'played');
  const homeWins = sum(homeRows, 'wins');
  const draws = sum(homeRows, 'draws');
  const awayWins = sum(awayRows, 'wins');
  const ouPlayed = sum(overUnder, 'played');
  const over25 = sum(overUnder, 'overCount');
  const under25 = sum(overUnder, 'underCount');

  const out = {};
  if (played) {
    Object.assign(out, {
      sample: played,
      homeWins,
      draws,
      awayWins,
      homeWinPct: round((100 * homeWins) / played, 1),
      drawPct: round((100 * draws) / played, 1),
      awayWinPct: round((100 * awayWins) / played, 1),
    });
  }
  if (ouPlayed) {
    Object.assign(out, {
      over25Count: Math.round(over25 / 2),
      under25Count: Math.round(under25 / 2),
      over25Pct: round((100 * over25) / ouPlayed, 1),
    });
  }
  return Object.keys(out).length ? out : null;
}

export function parseCompetitionPage(html, { leagueId = null, name = null, url = null, sport = 'football' } = {}) {
  const $ = cheerio.load(html);
  const h1 = clean($('h1').first().text());
  if (!h1 && !$('table.modern-standings, table.standings-table, .lh-tables').length) {
    throw new Error('Unexpected competition page layout');
  }

  const leagueName = (h1.split(/\s+[-–]\s+/)[0] || name || 'Competition').trim();
  const sections = {};
  const tables = {};
  const groups = [];

  $('h3').each((_, el) => {
    const $heading = $(el);
    const rawLabel = clean($heading.text());
    const label = rawLabel.toLowerCase();
    let key = null;
    if (/^all\b/.test(label)) key = 'all';
    else if (/^home\b/.test(label)) key = 'home';
    else if (/^away\b/.test(label)) key = 'away';
    else if (/^1st half/.test(label)) key = 'firstHalf';
    else if (/^2nd half/.test(label)) key = 'secondHalf';
    else if (/^form/.test(label)) key = 'form';
    else if (/under\/over/.test(label)) key = 'overUnder';
    else if (/goal distribution/.test(label)) key = 'goalDistribution';
    else if (/top scorers/.test(label)) key = 'topScorers';
    else if (/top assists/.test(label)) key = 'topAssists';
    else if (/cards/.test(label)) key = 'cards';
    if (!key) return;

    if (key === 'topScorers' || key === 'topAssists' || key === 'cards') {
      sections[key] = parseScorerRows($, $heading);
      return;
    }
    const $table = sectionTable($, $heading);
    if (!$table.length) return;
    if (key === 'goalDistribution') sections[key] = parseGoalDistribution($, $table);
    else if (key === 'overUnder') sections[key] = parseOverUnder($, $table);
    else {
      const parsed = parseStandings($, $table);
      // Grouped divisions print one table per group under "All - Group …".
      if (/\s[-–]\s/.test(rawLabel)) {
        groups.push({ label: rawLabel, kind: key, table: parsed });
        if (!tables[key]) tables[key] = parsed;
      } else {
        tables[key] = parsed;
      }
    }
  });

  if (!tables.all) parseLegacyTables($, tables);

  const goalDistribution = sections.goalDistribution || [];
  const averages = goalDistribution.map((row) => row.average).filter((value) => Number.isFinite(value) && value > 0);
  const leagueAverageGoals = averages.length ? round(averages.reduce((a, b) => a + b, 0) / averages.length, 2) : null;

  const all = tables.all?.rows || [];
  let goalsFor = 0;
  let played = 0;
  for (const row of all) {
    const match = /(\d+)\s*[:–-]\s*(\d+)/.exec(row.goals || '');
    const games = num(row.played);
    if (!match || !games) continue;
    goalsFor += Number(match[1]);
    played += games;
  }
  const goalsPerGame = played ? round(goalsFor / (played / 2), 2) : null;

  const trends = $('.trend-card')
    .map((_, el) => {
      const $card = $(el);
      const team = clean($card.find('.trend-team').first().text()) || null;
      const title = clean($card.find('.trend-title').first().text()) || null;
      const description = clean($card.find('.trend-desc').first().text()) || null;
      return { team, title, description, text: clean($card.text()) || null };
    })
    .get();

  const recentMatches = parseRecentMatches($);
  const leagueStats = parseLeagueStats($);

  return {
    leagueId: leagueId || null,
    sport,
    name: leagueName,
    title: h1 || null,
    url: url || null,
    season: clean($('.lh-season').first().text()) || null,
    tables,
    groups,
    corners: parseCornersFragment(html),
    leagueAverageGoals,
    goalsPerGame,
    recentMatches,
    leagueStats,
    recentRates: ratesFromMatches(recentMatches),
    seasonRates: seasonRatesFromTables(tables, sections.overUnder || []),
    overUnder: sections.overUnder || [],
    goalDistribution,
    topScorers: sections.topScorers || [],
    topAssists: sections.topAssists || [],
    cards: sections.cards || [],
    trends: trends.slice(0, 12),
    scrapedAt: new Date().toISOString(),
  };
}

/* ---------------- corners fragment ---------------- */

export function parseCornersFragment(html) {
  const $ = cheerio.load(html);
  const $fragment = $('#vst-odpoved');
  const $table = ($fragment.length ? $fragment.find('table') : $('table.vst-t')).first();
  if (!$table.length) return null;

  const headers = $table
    .find('thead th')
    .map((_, el) => clean($(el).text()))
    .get();
  const rows = [];
  $table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (!cells.length) return;
    const $teamClone = (cells.eq(1).length ? cells.eq(1) : cells.eq(0)).clone();
    $teamClone.find('.vst-sub').remove();
    const team = clean($teamClone.text());
    if (!team) return;
    rows.push({
      rank: clean(cells.eq(0).text()) || null,
      team,
      played: num(cells.eq(2).text()),
      for: num(cells.eq(3).text()),
      against: num(cells.eq(4).text()),
      match: num(cells.eq(5).text()),
      over95Pct: num(cells.eq(6).text()),
    });
  });

  if (!rows.length) return null;
  return { label: headers[headers.length - 1] || 'Corners', rows, scrapedAt: new Date().toISOString() };
}

/* ---------------- match-page extras ---------------- */

function parseMoney($) {
  const $wrap = $('.vc-wrap').first();
  if (!$wrap.length) return null;

  const shares = { '1': null, X: null, '2': null };
  const segments = $wrap
    .find('.vc-pruh .vc-seg')
    .map((_, el) => num($(el).text()))
    .get();
  if (segments.length >= 3) {
    shares['1'] = segments[0];
    shares.X = segments[1];
    shares['2'] = segments[2];
  }

  const outcomes = $wrap
    .find('.vc-bunka')
    .map((_, el) => {
      const $row = $(el);
      const $current = $row.find('.vc-kurz').first().clone();
      $current.find('s, i').remove();
      const cls = clean($row.find('.vc-kurz').attr('class'));
      return {
        name: clean($row.find('.vc-nazev').first().text()) || null,
        open: num($row.find('.vc-open').first().text()),
        current: num($current.text()),
        direction: /vc-nahoru/.test(cls) ? 'up' : /vc-dolu/.test(cls) ? 'down' : null,
      };
    })
    .get();

  return {
    source: clean($wrap.find('.vc-zdroj').first().text()) || null,
    shares,
    outcomes,
  };
}

function parseCommunity($) {
  const $box = $('.vk-karta').first();
  const text = clean($box.text());
  if (!text) {
    return {
      available: false,
      reason: 'Vitibet shows community picks only to signed-in users.',
    };
  }
  return { available: true, text };
}

/** Calculated Form / Team Power bars rendered under Match Statistics. */
function parseMatchBars($) {
  const bars = [];
  $('.stat-bar-container .stat-row').each((_, el) => {
    const $row = $(el);
    const spans = $row.children('span');
    if (spans.length < 3) return;
    const label = clean(spans.eq(1).text());
    if (!/calculated form|team power/i.test(label)) return;
    const $bar = $row.nextAll('.possession-bar').first();
    bars.push({
      label,
      home: clean(spans.eq(0).text()) || null,
      away: clean(spans.eq(2).text()) || null,
      homePct: stylePct($bar.find('.bar-home').first().attr('style')),
      awayPct: stylePct($bar.find('.bar-away').first().attr('style')),
    });
  });
  return bars.length ? bars : null;
}

export function parseMatchExtras($) {
  const cards = $('.stat-comp-header-main a.club-link');
  const links = [];
  $('a.club-link').each((_, el) => {
    const href = $(el).attr('href') || '';
    const teamId = teamIdFromHref(href);
    if (!teamId) return;
    links.push({ teamId, name: clean($(el).text()) || null, url: absolute(href) });
  });

  const pick = (i) => {
    const href = cards.eq(i).attr('href');
    const teamId = teamIdFromHref(href);
    return teamId ? { teamId, name: clean(cards.eq(i).text()), url: absolute(href) } : null;
  };

  return {
    homeLink: pick(0),
    awayLink: pick(1),
    links,
    odds: parseMoney($),
    community: parseCommunity($),
    bars: parseMatchBars($),
    vstQuery: clean($('.vst[data-vst]').first().attr('data-q')) || null,
  };
}

/**
 * Community picks live behind /komunita-api.php. Anonymous visitors only get
 * the total number of picks; the 1/X/2 split is for signed-in users.
 */
export async function fetchCommunity(fixtureId, sport = 'football') {
  const sekce = String(sport).toLowerCase() === 'football' ? 'fotbal' : 'basket';
  const url = `${SITE}/komunita-api.php?sport=${sekce}&fid=${encodeURIComponent(fixtureId)}&lang=en`;
  const raw = await getHtml(url, { referer: `${SITE}/` });
  const data = JSON.parse(raw);
  if (!data?.ok || data.skryt) {
    return { available: false, reason: 'Vitibet hides the community box for this match.' };
  }
  if (data.anon) {
    return {
      available: false,
      totalPicks: Number(data.celkem) || 0,
      reason: 'Vitibet shows the community split only to signed-in users.',
    };
  }
  return {
    available: true,
    totalPicks: data.pocty?.celkem ?? data.celkem ?? null,
    pct: data.pocty?.p ?? null,
    model: data.model ?? null,
    odds: data.kurzy ?? null,
  };
}

/* ---------------- fetchers ---------------- */

export async function fetchClubProfile(url) {
  const html = await getHtml(url, { referer: SITE + '/' });
  if (!/club-header/.test(html)) throw new Error('Unexpected club profile layout from Vitibet');
  return parseClubProfile(html, { url });
}

export async function fetchCompetitionPage(url, { leagueId = null, name = null, sport = 'football' } = {}) {
  const html = await getHtml(url, { referer: SITE + '/' });
  return parseCompetitionPage(html, { leagueId, name, url, sport });
}

export async function fetchLeagueCorners(url) {
  const separator = url.includes('?') ? '&' : '?';
  const html = await getHtml(`${url}${separator}lh_xg=1`, { referer: url });
  return parseCornersFragment(html);
}

export { num, round };
