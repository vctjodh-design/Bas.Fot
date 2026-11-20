const els = {
  root: document.getElementById('matchRoot'),
  back: document.getElementById('backBtn'),
  stamp: document.getElementById('stamp'),
  liveDot: document.getElementById('liveDot'),
};

const params = new URLSearchParams(location.search);
const fixtureId = (params.get('fixture') || '').trim();
const leagueId = (params.get('league') || '').trim();
const dateParam = (params.get('date') || '').trim();
const statusHint = (params.get('status') || '').trim();
const sport = params.get('sport') === 'football' ? 'football' : 'basketball';
const isFootball = sport === 'football';
const UNIT = isFootball ? 'goals' : 'points';

const state = {
  payload: null,
  loading: true,
  error: null,
  tab: null,
  ml: null,
  mlNote: null,
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
  const back = new URLSearchParams({ date: dateParam });
  if (sport !== 'basketball') back.set('sport', sport);
  if (leagueId) back.set('league', leagueId);
  els.back.href = `/?${back.toString()}`;
}

/* The back link points straight at the fixtures URL for this match's date,
 * sport and competition. Relying on browser history landed people on whatever
 * was cached for an earlier visit — wrong sport tab, empty list — so the
 * explicit URL is used instead; app.js restores the exact match and scroll
 * position from the state it saved before navigating here. */

const brandSub = document.getElementById('brandSub');
if (brandSub) {
  brandSub.textContent = `${isFootball ? 'Football' : 'Basketball'} fixtures & results, any date`;
}

const timeAgo = (isoString) => {
  if (!isoString) return '';
  const diff = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  return `${Math.round(diff / 3600)} h ago`;
};

/* ---------------- scoreboard ---------------- */

const FORM_TITLES = { W: 'Win', D: 'Draw', L: 'Loss' };

function formDots(form = []) {
  if (!form.length) return '';
  return `<div class="form-dots">${form
    .map((r) => `<span class="form-dot ${String(r || 'L').toLowerCase()}" title="${FORM_TITLES[r] || 'Result'}"></span>`)
    .join('')}</div>`;
}

function teamBlock(team, side) {
  const logo = team.logo
    ? `<img src="${escapeHtml(team.logo)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
    : `<span class="team-logo-fallback">${isFootball ? '⚽' : '🏀'}</span>`;
  return `<div class="sb-team ${side}">
    ${logo}
    <span class="sb-team-name">${escapeHtml(team.name)}</span>
    ${formDots(team.form)}
  </div>`;
}

function statusPill(payload) {
  const status = statusHint || payload.status;
  if (status === 'finished') return '<span class="status-pill ft">FT</span>';
  if (status === 'live') return '<span class="status-pill live">Live</span>';
  if (status === 'scheduled') return '<span class="status-pill soon">Scheduled</span>';
  return `<span class="status-pill soon">${escapeHtml(status)}</span>`;
}

function scoreboard(payload) {
  const hasScore = payload.homeScore != null && payload.awayScore != null;
  const score = hasScore
    ? `<div class="sb-score"><span>${escapeHtml(payload.homeScore)}</span><i>:</i><span>${escapeHtml(payload.awayScore)}</span></div>`
    : '<div class="sb-score vs">vs</div>';

  const badges = [
    statusPill(payload),
    payload.badge && /tip/i.test(payload.badge) ? '<span class="sb-tip">TIP</span>' : '',
  ].join('');

  return `<section class="scoreboard">
    <div class="sb-top">
      <span class="sb-league">${escapeHtml(payload.leagueName || (isFootball ? 'Football' : 'Basketball'))}</span>
      <span class="sb-when">${escapeHtml(payload.dateLabel || '')}</span>
    </div>
    <div class="sb-grid">
      ${teamBlock(payload.home, 'home')}
      ${score}
      ${teamBlock(payload.away, 'away')}
    </div>
    <div class="sb-badges">${badges}</div>
  </section>`;
}

/* ---------------- analytics ---------------- */

function varBar(label, entry) {
  if (!entry) return '';
  const homePct = entry.homePct ?? 50;
  const awayPct = entry.awayPct ?? 50;
  return `<div class="var-row">
    <div class="var-head">
      <span class="var-home">${escapeHtml(entry.home ?? '–')}</span>
      <span class="var-label">${escapeHtml(label)}</span>
      <span class="var-away">${escapeHtml(entry.away ?? '–')}</span>
    </div>
    <div class="var-bar">
      <span class="var-bar-home" style="width:${Math.max(0, Math.min(100, Number(homePct)))}%"></span>
      <span class="var-bar-away" style="width:${Math.max(0, Math.min(100, Number(awayPct)))}%"></span>
    </div>
  </div>`;
}

function analyticsSection(analytics) {
  if (!analytics) return '';
  const estimated = Boolean(analytics.estimated);

  const probs = ['1', 'X', '2']
    .filter((key) => analytics.probabilities?.[key])
    .map((key) => `<div class="an-prob ${key === '1' ? 'p1' : key === 'X' ? 'px' : 'p2'}">
      <span>${key}</span>
      <strong>${escapeHtml(analytics.probabilities[key])}</strong>
      <i><b style="width:${Math.max(2, Math.min(100, Number.parseFloat(analytics.probabilities[key]) || 0))}%"></b></i>
    </div>`)
    .join('');

  const note = estimated
    ? `<p class="estimate-note">Vitibet publishes no analytics for this match, so these numbers are calculated here from the same inputs it uses:
        recent form (${escapeHtml(analytics.sample?.home ?? 0)} vs ${escapeHtml(analytics.sample?.away ?? 0)} games, newest weighted highest)
        and season home/away ${isFootball ? 'goal difference' : 'point differential'}. The probabilities follow Vitibet's published curve, but treat the result as an estimate.</p>`
    : '';

  return `<section class="detail-section">
    <h2 class="detail-title">Vitisport Analytics ${estimated ? '<span class="an-est">Calculated</span>' : ''}</h2>
    <div class="panel detail-card">
      <div class="an-head">
        <div class="an-index ${String(analytics.index || '').trim().startsWith('-') ? 'neg' : 'pos'}">
          <strong>${escapeHtml(analytics.index || '–')}</strong>
          <span>Index</span>
        </div>
        <div class="an-probs">${probs || '<span class="muted">No probabilities published for this match.</span>'}</div>
      </div>
      <div class="an-bars">
        ${varBar('Calculated Form', analytics.form)}
        ${varBar('Team Power', analytics.power)}
      </div>
      ${note}
    </div>
  </section>`;
}

function predictionSection(prediction, payload) {
  if (!prediction?.total) return '';

  const actual =
    payload?.status === 'finished' && payload.homeScore != null && payload.awayScore != null
      ? Number(payload.homeScore) + Number(payload.awayScore)
      : null;
  const delta = Number.isFinite(actual) ? Math.round(prediction.total - actual) : null;
  const verdict =
    delta == null ? null : delta === 0 ? 'exact' : `${Math.abs(delta)} ${UNIT} ${delta > 0 ? 'high' : 'low'}`;
  return `<section class="detail-section">
    <h2 class="detail-title">Predicted total ${UNIT} <span class="an-est">Calculated</span></h2>
    <div class="panel detail-card">
      <div class="an-total">
        <strong>≈${escapeHtml(String(prediction.total))}</strong>
        <span>${UNIT}</span>
      </div>
      <p class="an-total-note">Expected score ${escapeHtml(prediction.home)} : ${escapeHtml(prediction.away)}.
        Vitibet publishes no totals, so this is calculated from each team's ${UNIT} for and against per game
        (${escapeHtml(prediction.sample?.home ?? 0)} and ${escapeHtml(prediction.sample?.away ?? 0)} games)
        with ${isFootball ? 'home advantage' : 'home-court advantage'} split between the sides.
        ${isFootball ? 'Expect roughly a goal of error on a single match.' : 'Expect around ±12 points of error.'}</p>
      ${actual != null
        ? `<p class="an-total-result">Final total <strong>${escapeHtml(String(actual))}</strong> ${UNIT} · prediction <strong>${escapeHtml(verdict)}</strong></p>`
        : ''}
    </div>
  </section>`;
}

/* ---------------- machine learning ---------------- */

function mlPredictionSection(ml, note = '') {
  if (!ml?.available) {
    if (!note) return '';
    return `<section class="detail-section">
      <h2 class="detail-title">Machine learning prediction <span class="an-est">ML</span></h2>
      <div class="panel detail-card"><p class="rate-note">${escapeHtml(note)}</p></div>
    </section>`;
  }
  return `<section class="detail-section">
    <h2 class="detail-title">Machine learning prediction <span class="an-est">ML</span></h2>
    <div class="panel detail-card">
      <div class="ml-pred-grid">
        <div class="ml-pred">
          <span>1X2</span>
          <strong>${escapeHtml(ml.pick)}</strong>
          <small>1 ${escapeHtml(ml.probabilities['1'])}% · X ${escapeHtml(ml.probabilities.X)}% · 2 ${escapeHtml(ml.probabilities['2'])}%</small>
        </div>
        <div class="ml-pred">
          <span>BTTS</span>
          <strong>${escapeHtml(ml.btts.pick)}</strong>
          <small>Yes ${escapeHtml(ml.btts.yes)}% · No ${escapeHtml(ml.btts.no)}%</small>
        </div>
        <div class="ml-pred">
          <span>Total goals</span>
          <strong>${escapeHtml(ml.totalGoals)}</strong>
          <small>${escapeHtml(ml.over25.pick)} · ${escapeHtml(ml.over25.over)}% over</small>
        </div>
        <div class="ml-pred">
          <span>Correct score</span>
          <strong>${escapeHtml(ml.correctScore.score || '–')}</strong>
          <small>${escapeHtml(ml.correctScore.probability)}% probability</small>
        </div>
      </div>
      <div class="table-scroll"><table class="db-table ml-score-table">
        <thead><tr><th>Most likely scores</th><th>Probability</th></tr></thead>
        <tbody>${(ml.correctScore.top || [])
          .map((entry) => `<tr><td>${escapeHtml(entry.score)}</td><td>${escapeHtml(entry.probability)}%</td></tr>`)
          .join('')}</tbody>
      </table></div>
      <p class="an-total-note">Neural network trained on ${escapeHtml(ml.model.samples)} complete matches with ${escapeHtml(ml.model.features)} features and ${escapeHtml(ml.model.architecture?.hidden?.join(' → ') || '')} hidden units. Correct score comes from the Poisson goal layer. Treat this as a model estimate, not a guarantee.</p>
    </div>
  </section>`;
}

/* ---------------- recent matches ---------------- */

function recentSection(groups) {
  if (!groups.length) return '';
  const cards = groups
    .map((group) => `<div class="panel detail-card recent-card">
      <h3 class="recent-team">${escapeHtml(group.name)}</h3>
      <div class="recent-list">
        ${group.matches.length
          ? group.matches
              .map((m) => `<div class="recent-row">
                <span class="venue ${m.venue === 'H' ? 'h' : 'a'}">${escapeHtml(m.venue || '–')}</span>
                <span class="recent-date">${escapeHtml(m.date || '')}</span>
                <span class="recent-opponent">${escapeHtml(m.opponent || '–')}</span>
                <span class="recent-score ${m.result === 'W' ? 'w' : m.result === 'L' ? 'l' : m.result === 'D' ? 'd' : ''}">${escapeHtml(m.score || '–')}</span>
              </div>`)
              .join('')
          : '<p class="muted pad">No recent matches listed.</p>'}
      </div>
    </div>`)
    .join('');

  return `<section class="detail-section">
    <h2 class="detail-title">Recent matches</h2>
    <div class="recent-grid">${cards}</div>
  </section>`;
}

/* ---------------- head to head ---------------- */

function headToHeadSection(rows) {
  const body = rows.length
    ? `<div class="h2h-list">
        ${rows
          .map((m) => `<div class="h2h-row">
            <span class="h2h-date">${escapeHtml(m.date || '')}</span>
            <span class="h2h-team home ${m.homeWon ? 'won' : ''}">${escapeHtml(m.home)}</span>
            <span class="h2h-score">${escapeHtml(m.homeScore || '–')} : ${escapeHtml(m.awayScore || '–')}</span>
            <span class="h2h-team away ${m.awayWon ? 'won' : ''}">${escapeHtml(m.away)}</span>
          </div>`)
          .join('')}
      </div>`
    : `<p class="empty-note">Vitibet lists no previous meetings between these teams yet.</p>`;

  return `<section class="detail-section">
    <h2 class="detail-title">Head-to-head</h2>
    <div class="panel detail-card">${body}</div>
  </section>`;
}

/* ---------------- league table ---------------- */

function tableSection(table) {
  if (!table) return '';
  const active = table.tabs.find((t) => t.key === state.tab) || table.tabs[0];
  state.tab = active.key;

  const tabs = table.tabs
    .map((t) => `<button type="button" class="table-tab ${t.key === active.key ? 'active' : ''}" data-tab="${escapeHtml(t.key)}">${escapeHtml(t.label)}</button>`)
    .join('');

  const rows = active.rows
    .map((r) => `<tr class="${r.highlighted ? 'hl' : ''}">
      <td class="t-rank">${escapeHtml(r.rank || '')}</td>
      <td class="t-team">${escapeHtml(r.team)}</td>
      <td>${escapeHtml(r.played || '')}</td>
      <td>${escapeHtml(r.wins || '')}</td>
      ${isFootball ? `<td>${escapeHtml(r.draws || '')}</td>` : ''}
      <td>${escapeHtml(r.losses || '')}</td>
      <td class="t-score">${escapeHtml(r.score || '')}</td>
      <td class="t-pct">${escapeHtml(isFootball ? r.points || '' : r.pct || '')}</td>
    </tr>`)
    .join('');

  return `<section class="detail-section">
    <h2 class="detail-title">League table ${table.season ? `<span class="detail-sub">${escapeHtml(table.season)}</span>` : ''}</h2>
    <div class="panel detail-card">
      <div class="table-tabs">${tabs}</div>
      <div class="table-scroll">
        <table class="standings">
          <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th>${isFootball ? '<th>D</th>' : ''}<th>L</th><th>Score</th><th>${isFootball ? 'Pts' : '%'}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

/* ---------------- render ---------------- */

function renderSkeleton() {
  els.root.innerHTML = `<div class="detail-skeleton">
    <div class="sk-block" style="height:210px"></div>
    <div class="sk-block" style="height:150px"></div>
    <div class="sk-block" style="height:180px"></div>
  </div>`;
}

function render() {
  if (state.loading) {
    renderSkeleton();
    return;
  }

  if (state.error) {
    els.root.innerHTML = `<div class="state error detail-state">
      <span class="emoji">⚠️</span>
      <h3>Could not load this match</h3>
      <p>${escapeHtml(state.error)}</p>
      <button class="btn" type="button" id="retryBtn">Try again</button>
    </div>
    ${mlPredictionSection(state.ml, state.mlNote)}`;
    document.getElementById('retryBtn')?.addEventListener('click', load);
    return;
  }

  const p = state.payload;
  if (!p) return;

  document.title = `${p.home.name} vs ${p.away.name} — HoopsFixtures`;

  els.root.innerHTML = [
    scoreboard(p),
    analyticsSection(p.analytics),
    predictionSection(p.prediction, p),
    mlPredictionSection(state.ml, state.mlNote),
    recentSection(p.lastMatches || []),
    headToHeadSection(p.headToHead || []),
    tableSection(p.table),
    `<p class="source-note">Details scraped from
      <a href="${escapeHtml(p.detailUrl)}" target="_blank" rel="noreferrer noopener">the Vitibet match page</a>.
      Times are shown as published by the source.</p>`,
  ].join('');

  els.stamp.textContent = p.scrapedAt
    ? `Last scraped ${timeAgo(p.scrapedAt)}${p.cached ? ' · cached' : ''}`
    : '';
}

els.root.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  state.tab = tab.dataset.tab;
  render();
});

async function load() {
  state.loading = true;
  state.error = null;
  state.ml = null;
  state.mlNote = null;
  els.liveDot.classList.add('busy');
  render();

  if (!/^\d+$/.test(fixtureId)) {
    state.loading = false;
    state.error = 'No fixture id was passed in the address. Open a match from the fixtures list.';
    render();
    els.liveDot.classList.remove('busy');
    return;
  }

  try {
    const query = new URLSearchParams({ fixture_id: fixtureId, sport });
    if (leagueId) query.set('league_id', leagueId);
    const res = await fetch(`/api/match?${query.toString()}`, { headers: { Accept: 'application/json' } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.detail || json.error || `Request failed (${res.status})`);

    state.payload = json;
    state.loading = false;
    render();
    loadMlPrediction();
  } catch (error) {
    state.loading = false;
    state.error = error.message || 'Unknown error';
    render();
    loadMlPrediction();
  } finally {
    els.liveDot.classList.remove('busy');
  }
}

async function loadMlPrediction() {
  if (sport !== 'football') return;
  state.mlNote = 'Collecting the match data needed by the model…';
  render();
  try {
    const query = new URLSearchParams({ fixture_id: fixtureId, sport });
    if (dateParam) query.set('date', dateParam);
    if (leagueId) query.set('league_id', leagueId);
    const res = await fetch(`/api/ml/predict?${query.toString()}`, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      state.mlNote = data.error || 'No ML prediction is available for this match yet.';
      render();
      return;
    }
    state.ml = data;
    state.mlNote = null;
    render();
  } catch {
    state.mlNote = 'Could not load the ML prediction.';
    render();
  }
}

load();
