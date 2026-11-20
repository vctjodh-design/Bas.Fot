const els = {
  calMonth: document.getElementById('calMonth'),
  calGrid: document.getElementById('calGrid'),
  prevMonth: document.getElementById('prevMonth'),
  nextMonth: document.getElementById('nextMonth'),
  todayBtn: document.getElementById('todayBtn'),
  calToggle: document.getElementById('calToggle'),
  calendarPop: document.getElementById('calendarPop'),
  prevDay: document.getElementById('prevDay'),
  nextDay: document.getElementById('nextDay'),
  selectedLabel: document.getElementById('selectedLabel'),
  relativeLabel: document.getElementById('relativeLabel'),
  dayHeading: document.getElementById('dayHeading'),
  daySub: document.getElementById('daySub'),
  fixturesList: document.getElementById('fixturesList'),
  statusArea: document.getElementById('statusArea'),
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  filterRow: document.getElementById('filterRow'),
  refreshBtn: document.getElementById('refreshBtn'),
  liveDot: document.getElementById('liveDot'),
  statTotal: document.getElementById('statTotal'),
  statFinished: document.getElementById('statFinished'),
  statScheduled: document.getElementById('statScheduled'),
  statTipped: document.getElementById('statTipped'),
  stamp: document.getElementById('stamp'),
  sportSwitch: document.getElementById('sportSwitch'),
  leagueSelect: document.getElementById('leagueSelect'),
};

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const COLLAPSED = new Set();

const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fromISO = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const addDays = (iso, days) => {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
};

const SPORTS = {
  basketball: { label: 'Basketball', emoji: '🏀', unit: 'points' },
  football: { label: 'Football', emoji: '⚽', unit: 'goals' },
};

const TODAY = toISO(new Date());
const params = new URLSearchParams(location.search);
const initialDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : TODAY;

const stored = (key) => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};
const store = (key, value) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private mode: remembering the tab and competition is optional.
  }
};
const savedLeague = (sport) => stored(`hoops.league.${sport}`);

/* Remembering the list on the way to a match is what makes the browser's back
 * button land on the same date, competition, filter and scroll position. */
const RETURN_KEY = 'hoops.return';
const FILTERS = new Set(['all', 'results', 'upcoming', 'tipped', 'live']);

function saveReturnState(fixtureId) {
  try {
    sessionStorage.setItem(
      RETURN_KEY,
      JSON.stringify({
        fixtureId: fixtureId || '',
        sport: state.sport,
        date: state.selected,
        league: state.league,
        filter: state.filter,
        query: state.query,
        scrollY: window.scrollY,
        collapsed: [...COLLAPSED],
        at: Date.now(),
      })
    );
  } catch {
    // Private mode: the back button then just reloads the date.
  }
}

function takeReturnState() {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RETURN_KEY);
    const saved = JSON.parse(raw);
    if (!saved || Date.now() - Number(saved.at || 0) > 30 * 60 * 1000) return null;
    return saved;
  } catch {
    return null;
  }
}

function applyReturnState(saved) {
  if (SPORTS[saved.sport]) state.sport = saved.sport;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(saved.date || ''))) state.selected = saved.date;
  if (typeof saved.league === 'string') state.league = saved.league;
  if (FILTERS.has(saved.filter)) {
    state.filter = saved.filter;
    els.filterRow.querySelectorAll('.chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.filter === state.filter);
    });
  }
  state.query = typeof saved.query === 'string' ? saved.query : '';
  if (state.query) els.searchInput.value = state.query;
  if (Array.isArray(saved.collapsed)) saved.collapsed.forEach((key) => COLLAPSED.add(key));
  syncMonthToSelected();
  syncSportTabs();
}

/* The list is re-rendered as calculated picks stream in, which replaces the
 * match rows; the restored position is therefore re-applied after every render
 * until the list settles, without fighting the user's own scrolling. */
let pendingReturn = null;

function scheduleReturn(saved) {
  pendingReturn = {
    fixtureId: String(saved.fixtureId || '').replace(/[^\w-]/g, ''),
    scrollY: Number.isFinite(saved.scrollY) ? saved.scrollY : null,
    // The list can take a moment to arrive, so the highlight clock starts when
    // the row is actually found rather than when the page started loading.
    highlightFrom: null,
    positioned: false,
  };
  setTimeout(() => {
    pendingReturn = null;
  }, 45000);
}

function applyPendingReturn() {
  if (!pendingReturn || !state.payload) return;
  const { fixtureId, scrollY } = pendingReturn;
  const target = fixtureId
    ? els.fixturesList.querySelector(`[data-fixture="${fixtureId}"]`)
    : null;

  if (target) {
    if (!pendingReturn.highlightFrom) pendingReturn.highlightFrom = Date.now();
    if (Date.now() - pendingReturn.highlightFrom < 2600) target.classList.add('returned');
  }
  if (pendingReturn.positioned) return;

  if (target) target.scrollIntoView({ block: 'center' });
  else if (scrollY != null) window.scrollTo(0, scrollY);
  pendingReturn.positioned = true;
}

const initialSport = SPORTS[params.get('sport')]
  ? params.get('sport')
  : SPORTS[stored('hoops.sport')]
    ? stored('hoops.sport')
    : 'basketball';
const initialLeague = params.get('league') || savedLeague(initialSport);
const initDate = fromISO(initialDate);

const state = {
  sport: initialSport,
  league: initialLeague || '',
  selected: initialDate,
  cursor: { year: initDate.getFullYear(), month: initDate.getMonth() },
  payload: null,
  filter: 'all',
  query: '',
  loading: false,
  error: null,
  cache: new Map(),
  controller: null,
  picks: new Map(),
  picksProgress: null,
  pickRun: 0,
};

/* ---------------- helpers ---------------- */

const sportInfo = () => SPORTS[state.sport] || SPORTS.basketball;

function saveLeague() {
  store(`hoops.league.${state.sport}`, state.league);
}

/* Keep the competition picker in step with the loaded day. A saved league
 * that has no fixtures on this date falls back to all competitions. */
function syncLeagueOptions() {
  const payload = state.payload;
  const select = els.leagueSelect;
  if (!payload || !select) return;

  const seen = new Set();
  const options = [];
  for (const league of payload.leagues) {
    const value = String(league.id || league.name);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: league.name });
  }

  if (state.league && !seen.has(state.league)) state.league = '';

  select.innerHTML =
    '<option value="">All competitions</option>' +
    options
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
  select.value = state.league;
  saveLeague();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function longDate(iso) {
  const d = fromISO(iso);
  const wd = WEEKDAYS[(d.getDay() + 6) % 7];
  return `${wd} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function relativeLabel(iso) {
  const diff = Math.round((fromISO(iso) - fromISO(TODAY)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 0) return `In ${diff} days`;
  return `${Math.abs(diff)} days ago`;
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const diff = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  return `${Math.round(diff / 3600)} h ago`;
}

/* ---------------- calendar ---------------- */

function renderCalendar() {
  const { year, month } = state.cursor;
  els.calMonth.textContent = `${MONTHS[month]} ${year}`;

  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = '';
  for (let i = 0; i < offset; i += 1) html += '<span class="cal-day blank" aria-hidden="true"></span>';

  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = new Date(year, month, day).getDay();
    const classes = ['cal-day'];
    if (iso < TODAY) classes.push('past');
    if (dow === 0 || dow === 6) classes.push('weekend');
    if (iso === TODAY) classes.push('today');
    if (iso === state.selected) classes.push('selected');

    const isToday = iso === TODAY ? '<span class="today-dot"></span>' : '';
    html += `<button type="button" class="${classes.join(' ')}" data-date="${iso}" role="gridcell"
      aria-label="${longDate(iso)}" aria-selected="${iso === state.selected}">${day}${isToday}</button>`;
  }

  els.calGrid.innerHTML = html;
}

function syncMonthToSelected() {
  const d = fromISO(state.selected);
  state.cursor = { year: d.getFullYear(), month: d.getMonth() };
}

function setCalendarOpen(open) {
  els.calendarPop.hidden = !open;
  els.calToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    syncMonthToSelected();
    renderCalendar();
  }
}

/* ---------------- rendering fixtures ---------------- */

function statusClass(match) {
  if (match.status === 'live') return 'live';
  if (match.status === 'finished') return 'ft';
  return 'soon';
}

function matchStatusText(match) {
  if (match.status === 'finished') return 'FT';
  if (match.status === 'live') return match.statusLabel || 'Live';
  if (match.status === 'scheduled' && match.badge) return match.badge;
  return 'vs';
}

function teamRow(match, side) {
  const isHome = side === 'home';
  const name = isHome ? match.home : match.away;
  const logo = isHome ? match.homeLogo : match.awayLogo;

  let cls = 'team';
  if (match.status === 'finished' && match.homeScore != null && match.awayScore != null) {
    const h = Number(match.homeScore);
    const a = Number(match.awayScore);
    if (Number.isFinite(h) && Number.isFinite(a) && h !== a) {
      const won = isHome ? h > a : a > h;
      cls += won ? ' winner' : ' loser';
    }
  }

  const img = logo
    ? `<img src="${escapeHtml(logo)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
    : '<img src="data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E" alt="" />';

  return `<div class="${cls}">${img}<span class="team-name">${escapeHtml(name)}</span></div>`;
}

function scoreBox(match) {
  const hasScore = match.homeScore != null && match.awayScore != null;
  if (!hasScore) {
    return `<div class="score-box"><span class="score-row empty">–</span><span class="score-row empty">–</span></div>`;
  }
  let homeLost = false;
  let awayLost = false;
  if (match.status === 'finished') {
    const h = Number(match.homeScore);
    const a = Number(match.awayScore);
    if (Number.isFinite(h) && Number.isFinite(a) && h !== a) {
      homeLost = h < a;
      awayLost = a < h;
    }
  }
  return `<div class="score-box">
    <span class="score-row ${homeLost ? 'lost' : ''}">${escapeHtml(match.homeScore)}</span>
    <span class="score-row ${awayLost ? 'lost' : ''}">${escapeHtml(match.awayScore)}</span>
  </div>`;
}

function probsBlock(match) {
  const p = match.probabilities || {};
  const entries = [
    { key: '1', cls: 'p1', label: '1' },
    { key: 'X', cls: 'px', label: 'X' },
    { key: '2', cls: 'p2', label: '2' },
  ].filter((e) => p[e.key]);

  if (!entries.length) return '';

  const rows = entries
    .map((e) => {
      const num = Number.parseFloat(String(p[e.key])) || 0;
      return `<div class="prob-row ${e.cls}">
        <b>${e.label}</b>
        <span class="prob-bar"><span style="width:${Math.max(2, Math.min(100, num))}%"></span></span>
        <i>${escapeHtml(p[e.key])}</i>
      </div>`;
    })
    .join('');

  return `<div class="probs" title="Vitibet model probabilities">${rows}</div>`;
}

function totalChip(match) {
  const calc = state.picks.get(match.fixtureId);
  if (!calc?.total) return '';
  const info = sportInfo();
  const score = calc.score ? ` — expected ${calc.score.home} : ${calc.score.away}` : '';
  const chip = `<span class="total-chip" title="${escapeHtml(
    `Calculated total ${info.unit}${score}`
  )}">TOT ≈${escapeHtml(String(calc.total))}</span>`;

  const finished = match.status === 'finished' && match.homeScore != null && match.awayScore != null;
  const actual = finished ? Number(match.homeScore) + Number(match.awayScore) : null;
  if (!Number.isFinite(actual)) return chip;

  const delta = Math.round(calc.total - actual);
  const tolerance = state.sport === 'football' ? 1 : 10;
  const tone = Math.abs(delta) <= tolerance ? 'hit' : 'miss';
  const signed = delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${delta}`;
  return `${chip}<span class="actual-chip ${tone}" title="${escapeHtml(
    `Actual total ${info.unit} from the final score — prediction ${delta === 0 ? 'exact' : `${signed} ${info.unit}`}`
  )}">FT ${escapeHtml(String(actual))}<i>${escapeHtml(signed)}</i></span>`;
}

function bestChip(calc) {
  const best = calc?.best;
  if (!best?.label) return '';
  const markets = (calc.markets || []).map((market) => `${market.label} ${market.pct}%`).join(' · ');
  return `<span class="best-chip" title="${escapeHtml(
    `Best calculated pick across markets${markets ? ` — ${markets}` : ''}. Vitibet publishes no such market.`
  )}"><em>BEST</em><b>${escapeHtml(best.label)}</b><i>${escapeHtml(String(best.pct))}%</i></span>`;
}

function calcPickBlock(match) {
  const calc = state.picks.get(match.fixtureId);
  if (!calc) return '<span class="no-tip">No tip</span>';

  const best = state.sport === 'football' ? bestChip(calc) : '';
  if (best) {
    const idx = calc.index
      ? `<span class="index-chip ${String(calc.index).startsWith('-') ? 'neg' : 'pos'}" title="Calculated index">≈IDX ${escapeHtml(calc.index)}</span>`
      : '';
    return `${best}${idx}${totalChip(match)}`;
  }

  if (!calc.pick) return totalChip(match) || '<span class="no-tip">No tip</span>';

  const tip = String(calc.pick || '').toUpperCase();
  const cls = tip === 'X' ? 'x' : tip === '2' ? 'two' : '';
  const p = calc.probabilities || {};
  const title = [
    'Calculated pick — Vitibet publishes no tip for this match.',
    `Index ${calc.index ?? '–'}`,
    `1 ${p['1'] || '–'} · X ${p.X || '–'} · 2 ${p['2'] || '–'}`,
  ].join(' ');

  return `<span class="calc-chip ${cls}" title="${escapeHtml(title)}">
      <em>CALC</em><b>${escapeHtml(tip)}</b><i>${escapeHtml(calc.pct || '')}</i>
    </span>
    <span class="index-chip ${String(calc.index || '').startsWith('-') ? 'neg' : 'pos'}" title="Calculated index">≈IDX ${escapeHtml(calc.index || '–')}</span>
    ${totalChip(match)}`;
}

function tipBlock(match) {
  const idx = match.index
    ? `<span class="index-chip ${String(match.index).trim().startsWith('-') ? 'neg' : 'pos'}">IDX ${escapeHtml(match.index)}</span>`
    : '';

  if (!match.tip) {
    return `<div class="tip-box">${calcPickBlock(match)}</div>`;
  }

  const tip = String(match.tip).trim().toUpperCase();
  const cls = tip === 'X' ? 'x' : tip === '2' ? 'two' : '';
  return `<div class="tip-box">
    ${probsBlock(match)}
    <span class="tip-chip ${cls}" title="Vitibet tip">${escapeHtml(tip)}</span>
    ${idx}
    ${state.sport === 'football' ? bestChip(state.picks.get(match.fixtureId)) : ''}
    ${totalChip(match)}
  </div>`;
}

function matchRow(match) {
  const cls = ['match'];
  if (match.status === 'live') cls.push('is-live');

  let href = '';
  if (match.fixtureId) {
    const params = new URLSearchParams({ fixture: match.fixtureId, date: state.selected });
    if (match.leagueId) params.set('league', match.leagueId);
    if (match.status) params.set('status', match.status);
    if (state.sport !== 'basketball') params.set('sport', state.sport);
    href = `href="/match.html?${escapeHtml(params.toString())}"`;
  } else if (match.detailUrl) {
    href = `href="${escapeHtml(match.detailUrl)}" target="_blank" rel="noreferrer noopener"`;
  }

  return `<a class="${cls.join(' ')}" data-fixture="${escapeHtml(match.fixtureId || '')}" ${href}>
    <div class="match-time">
      <span>${escapeHtml(match.kickoff || '–')}</span>
      <span class="status-pill ${statusClass(match)}">${escapeHtml(matchStatusText(match))}</span>
    </div>
    <div class="match-teams">
      ${teamRow(match, 'home')}
      ${teamRow(match, 'away')}
    </div>
    <div class="match-side">
      ${scoreBox(match)}
      ${tipBlock(match)}
    </div>
  </a>`;
}

function passesFilter(match) {
  if (state.filter === 'results' && match.status !== 'finished') return false;
  if (state.filter === 'upcoming' && match.status !== 'scheduled') return false;
  if (state.filter === 'live' && match.status !== 'live') return false;
  if (state.filter === 'tipped' && !match.tip) return false;

  if (state.query) {
    const haystack = `${match.home} ${match.away} ${match.leagueName}`.toLowerCase();
    if (!haystack.includes(state.query)) return false;
  }
  return true;
}

function renderFixtures() {
  const payload = state.payload;
  els.statusArea.innerHTML = '';
  els.fixturesList.innerHTML = '';

  if (state.loading) {
    els.fixturesList.innerHTML = `<div class="skeleton">
      ${Array.from({ length: 3 }).map(() => `<div class="sk-league">
        <div class="sk-line" style="width:38%"></div>
        <div class="sk-line" style="width:72%"></div>
        <div class="sk-line" style="width:64%"></div>
        <div class="sk-line" style="width:69%"></div>
      </div>`).join('')}
    </div>`;
    return;
  }

  if (state.error) {
    els.statusArea.innerHTML = `<div class="state error">
      <span class="emoji">⚠️</span>
      <h3>Could not load this date</h3>
      <p>${escapeHtml(state.error)}</p>
      <button class="btn" type="button" id="retryBtn">Try again</button>
    </div>`;
    const retry = document.getElementById('retryBtn');
    if (retry) retry.addEventListener('click', () => loadDate(state.selected, { force: true }));
    return;
  }

  if (!payload) return;

  const groups = payload.leagues
    .filter((league) => !state.league || String(league.id || league.name) === state.league)
    .map((league) => ({ ...league, matches: league.matches.filter(passesFilter) }))
    .filter((league) => league.matches.length);

  if (!groups.length) {
    const info = sportInfo();
    const none = payload.counts?.total
      ? 'No fixtures match your filter on this date. Try clearing the search or switching back to “All”.'
      : `Vitibet lists no ${info.label.toLowerCase()} fixtures for this date. Pick another day from the calendar.`;
    els.statusArea.innerHTML = `<div class="state">
      <span class="emoji">${info.emoji}</span>
      <h3>Nothing to show</h3>
      <p>${none}</p>
    </div>`;
    applyPendingReturn();
    return;
  }

  els.fixturesList.innerHTML = groups
    .map((league) => {
      const key = `${state.sport}:${league.id || league.name}`;
      const collapsed = COLLAPSED.has(key);
      const flag = league.flag
        ? `<img class="league-flag" src="${escapeHtml(league.flag)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
        : '';
      return `<section class="league ${collapsed ? 'collapsed' : ''}" data-key="${escapeHtml(key)}">
        <button class="league-head" type="button" data-toggle="${escapeHtml(key)}" aria-expanded="${!collapsed}">
          ${flag}
          <span class="league-name">${escapeHtml(league.name)}</span>
          <span class="league-count">${league.matches.length}</span>
          <svg class="league-chevron" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div class="league-body">${league.matches.map(matchRow).join('')}</div>
      </section>`;
    })
    .join('');

  applyPendingReturn();
}

function renderHeader() {
  els.selectedLabel.textContent = longDate(state.selected);
  els.relativeLabel.textContent = relativeLabel(state.selected);
  els.dayHeading.textContent = relativeLabel(state.selected) === 'Today'
    ? 'Today’s fixtures'
    : `${relativeLabel(state.selected)} · fixtures`;

  const c = state.payload?.counts;
  if (c) {
    const leagues = state.payload.leagues.length;
    els.daySub.textContent = `${c.total} ${sportInfo().label.toLowerCase()} fixture${c.total === 1 ? '' : 's'} across ${leagues} league${leagues === 1 ? '' : 's'} · ${c.finished} finished · ${c.scheduled} upcoming`;
    els.statTotal.textContent = c.total ?? '–';
    els.statFinished.textContent = c.finished ?? '–';
    els.statScheduled.textContent = c.scheduled ?? '–';
    els.statTipped.textContent = c.tipped ?? '–';
  } else if (state.error) {
    els.daySub.textContent = 'Vitibet could not be reached — try refreshing.';
  } else {
    els.daySub.textContent = `Loading ${sportInfo().label.toLowerCase()} fixtures…`;
    els.statTotal.textContent = '–';
    els.statFinished.textContent = '–';
    els.statScheduled.textContent = '–';
    els.statTipped.textContent = '–';
  }
}

/* ---------------- data loading ---------------- */

async function loadDate(date, { force = false } = {}) {
  const sport = state.sport;
  const dayKey = `${sport}|${date}`;
  state.selected = date;
  state.error = null;
  state.pickRun += 1;
  state.picks = new Map();
  state.picksProgress = null;
  syncMonthToSelected();
  renderCalendar();
  renderHeader();

  if (!force && state.cache.has(dayKey)) {
    state.payload = state.cache.get(dayKey);
    state.loading = false;
    syncLeagueOptions();
    updateUrl(date);
    renderHeader();
    renderFixtures();
    renderStamp();
    startPicks(date);
    return;
  }

  if (state.controller) state.controller.abort();
  state.controller = new AbortController();

  state.loading = true;
  state.payload = null;
  els.liveDot.classList.add('busy');
  renderFixtures();

  try {
    const res = await fetch(`/api/fixtures?date=${encodeURIComponent(date)}&sport=${encodeURIComponent(sport)}`, {
      signal: state.controller.signal,
      headers: { Accept: 'application/json' },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.detail || json.error || `Request failed (${res.status})`);

    state.cache.set(dayKey, json);
    if (state.selected !== date || state.sport !== sport) return;
    state.payload = json;
    state.loading = false;
    syncLeagueOptions();
    updateUrl(date);
    renderHeader();
    renderFixtures();
    renderStamp();
    startPicks(date);
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.loading = false;
    if (state.sport !== sport) return;
    state.error = error.message || 'Unknown error';
    renderHeader();
    renderFixtures();
  } finally {
    els.liveDot.classList.remove('busy');
  }
}

function updateUrl(date) {
  const url = new URL(location.href);
  url.searchParams.set('date', date);
  if (state.sport === 'basketball') url.searchParams.delete('sport');
  else url.searchParams.set('sport', state.sport);
  if (state.league) url.searchParams.set('league', state.league);
  else url.searchParams.delete('league');
  history.replaceState({ date, sport: state.sport, league: state.league }, '', url);
}

function renderStamp() {
  const when = state.payload?.scrapedAt;
  const parts = [];
  if (when) parts.push(`Last scraped ${timeAgo(when)}${state.payload?.cached ? ' · cached' : ''}`);
  if (state.picksProgress) {
    const { done, total } = state.picksProgress;
    parts.push(total ? `Calculating totals & picks ${Math.min(done, total)}/${total}` : 'Calculating totals & picks…');
  }
  els.stamp.textContent = parts.join(' · ');
}

const PICK_BATCH = 12;

/*
 * Fill in calculated picks and predicted totals for the day's matches. Each
 * match needs its own detail page, so the server serves them in small batches
 * and the list is re-rendered as results arrive. Totals are a prediction for
 * every fixture, including ones that already have a final score.
 */
async function startPicks(date) {
  const run = state.pickRun;
  const sport = state.sport;
  state.picks = new Map();
  state.picksProgress = { done: 0, total: null };
  renderStamp();

  let cursor = 0;
  try {
    for (;;) {
      const res = await fetch(
        `/api/picks?date=${encodeURIComponent(date)}&sport=${encodeURIComponent(sport)}&cursor=${cursor}&limit=${PICK_BATCH}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) break;
      const json = await res.json().catch(() => null);
      if (!json || state.pickRun !== run) return;

      for (const [id, pick] of Object.entries(json.picks || {})) state.picks.set(id, pick);
      cursor = Number.isFinite(json.nextCursor) ? json.nextCursor : cursor;
      if (json.done) break;

      state.picksProgress = { done: cursor, total: json.total };
      if (state.selected === date) {
        renderFixtures();
        renderStamp();
      }
    }
  } catch {
    // Picks are an extra: the published list still works without them.
  } finally {
    if (state.pickRun === run) {
      state.picksProgress = null;
      if (state.selected === date) {
        renderFixtures();
        renderStamp();
      }
    }
  }
}

/* ---------------- events ---------------- */

function syncSportTabs() {
  els.sportSwitch.querySelectorAll('[data-sport]').forEach((btn) => {
    const on = btn.dataset.sport === state.sport;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  });
}

els.sportSwitch.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-sport]');
  if (!btn || btn.dataset.sport === state.sport || !SPORTS[btn.dataset.sport]) return;

  if (state.controller) state.controller.abort();
  state.sport = btn.dataset.sport;
  state.league = savedLeague(state.sport);
  store('hoops.sport', state.sport);
  state.filter = 'all';
  COLLAPSED.clear();
  els.filterRow.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === 'all');
  });
  syncSportTabs();
  updateUrl(state.selected);
  loadDate(state.selected);
});

els.calToggle.addEventListener('click', () => {
  setCalendarOpen(els.calendarPop.hidden);
});

els.calGrid.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-date]');
  if (!btn) return;
  setCalendarOpen(false);
  loadDate(btn.dataset.date);
});

document.addEventListener('click', (event) => {
  if (els.calendarPop.hidden) return;
  if (event.target.closest('.date-picker')) return;
  setCalendarOpen(false);
});

els.fixturesList.addEventListener('click', (event) => {
  const matchLink = event.target.closest('a.match[data-fixture]');
  if (matchLink?.dataset.fixture) saveReturnState(matchLink.dataset.fixture);

  const toggle = event.target.closest('[data-toggle]');
  if (!toggle) return;
  const key = toggle.dataset.toggle;
  if (COLLAPSED.has(key)) COLLAPSED.delete(key);
  else COLLAPSED.add(key);
  renderFixtures();
});

els.prevMonth.addEventListener('click', () => {
  const { year, month } = state.cursor;
  state.cursor = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
  renderCalendar();
});

els.nextMonth.addEventListener('click', () => {
  const { year, month } = state.cursor;
  state.cursor = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
  renderCalendar();
});

els.todayBtn.addEventListener('click', () => {
  setCalendarOpen(false);
  loadDate(TODAY);
});
els.prevDay.addEventListener('click', () => loadDate(addDays(state.selected, -1)));
els.nextDay.addEventListener('click', () => loadDate(addDays(state.selected, 1)));
els.refreshBtn.addEventListener('click', () => loadDate(state.selected, { force: true }));

els.filterRow.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-filter]');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  els.filterRow.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderFixtures();
});

els.leagueSelect.addEventListener('change', (event) => {
  state.league = event.target.value || '';
  saveLeague();
  updateUrl(state.selected);
  renderFixtures();
});

/* ---------------- search ---------------- */

function hideSearchResults() {
  if (!els.searchResults) return;
  els.searchResults.hidden = true;
  els.searchResults.innerHTML = '';
  els.searchInput.setAttribute('aria-expanded', 'false');
}

function showSearchResults(html) {
  if (!els.searchResults) return;
  els.searchResults.innerHTML = html;
  els.searchResults.hidden = false;
  els.searchInput.setAttribute('aria-expanded', 'true');
}

function matchResultRow(match) {
  const query = new URLSearchParams({ fixture: match.fixtureId, date: match.date });
  if (match.leagueId) query.set('league', match.leagueId);
  if (match.status) query.set('status', match.status);
  if (match.sport && match.sport !== 'basketball') query.set('sport', match.sport);

  const scored = match.score && match.score.home != null && match.score.away != null;
  const side = scored ? `${match.score.home}–${match.score.away}` : match.kickoff || 'vs';
  const sportHint =
    match.sport && match.sport !== state.sport ? `${sportLabelOf(match.sport)} · ` : '';

  return `<a class="search-item" role="option" data-search-fixture="${escapeHtml(match.fixtureId)}"
      href="/match.html?${escapeHtml(query.toString())}">
    <span class="si-main">
      <strong>${escapeHtml(match.home)} <i>vs</i> ${escapeHtml(match.away)}</strong>
      <span class="si-sub">${escapeHtml(sportHint)}${escapeHtml(match.leagueName || 'Competition')} · ${escapeHtml(match.date)}</span>
    </span>
    <span class="si-side">${escapeHtml(String(side))}</span>
  </a>`;
}

function competitionResultRow(competition) {
  return `<button class="search-item" type="button" role="option"
      data-search-date="${escapeHtml(competition.date)}"
      data-search-league="${escapeHtml(competition.leagueId || competition.name)}"
      data-search-sport="${escapeHtml(competition.sport)}">
    <span class="si-main">
      <strong>${escapeHtml(competition.name)}</strong>
      <span class="si-sub">${escapeHtml(sportLabelOf(competition.sport))} competition</span>
    </span>
    <span class="si-side">${escapeHtml(String(competition.fixtures))} stored</span>
  </button>`;
}

function sportLabelOf(sport) {
  return (SPORTS[sport] || SPORTS.basketball).label;
}

function renderSearchResults(data, query) {
  const matches = data.matches || [];
  const competitions = data.competitions || [];

  if (!matches.length && !competitions.length) {
    showSearchResults(
      `<p class="search-empty">Nothing stored matches “${escapeHtml(query)}”. Matches show up here once their date has been processed in the Processing tab.</p>`
    );
    return;
  }

  const groups = [];
  if (matches.length) {
    groups.push(`<p class="search-group">Stored matches</p>${matches.map(matchResultRow).join('')}`);
  }
  if (competitions.length) {
    groups.push(
      `<p class="search-group">Competitions</p>${competitions.map(competitionResultRow).join('')}`
    );
  }
  showSearchResults(groups.join(''));
}

let searchController = null;

async function loadSearchResults(query) {
  if (!query || query.length < 2) {
    hideSearchResults();
    return;
  }
  if (searchController) searchController.abort();
  searchController = new AbortController();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      signal: searchController.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();
    if (els.searchInput.value.trim().toLowerCase() !== query) return;
    renderSearchResults(data, query);
  } catch (error) {
    if (error.name !== 'AbortError') hideSearchResults();
  }
}

let searchTimer;
els.searchInput.addEventListener('input', (event) => {
  const raw = event.target.value.trim();
  const value = raw.toLowerCase();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = value;
    renderFixtures();
    loadSearchResults(value);
  }, 160);
});

els.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideSearchResults();
    els.searchInput.blur();
    return;
  }
  if (event.key === 'Enter' && els.searchResults && !els.searchResults.hidden) {
    const first = els.searchResults.querySelector('a[href], [data-search-date]');
    if (first) {
      event.preventDefault();
      first.click();
    }
  }
});

// A cached page shell can predate the results panel; a missing element must
// never stop the rest of the script (date loading) from running.
els.searchResults?.addEventListener('click', (event) => {
  const match = event.target.closest('[data-search-fixture]');
  if (match) {
    saveReturnState(match.dataset.searchFixture);
    hideSearchResults();
    return;
  }

  const competition = event.target.closest('[data-search-date]');
  if (!competition) return;
  const { searchDate: date, searchLeague: league, searchSport: sport } = competition.dataset;
  hideSearchResults();

  if (SPORTS[sport] && sport !== state.sport) {
    state.sport = sport;
    store('hoops.sport', sport);
    COLLAPSED.clear();
    syncSportTabs();
  }
  state.league = league || '';
  saveLeague();
  state.filter = 'all';
  state.query = '';
  els.searchInput.value = '';
  els.filterRow.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === 'all');
  });
  loadDate(date);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#searchBox')) hideSearchResults();
});

els.searchInput.addEventListener('focus', () => {
  const value = els.searchInput.value.trim().toLowerCase();
  if (value.length >= 2) loadSearchResults(value);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.calendarPop.hidden) {
    setCalendarOpen(false);
    return;
  }
  if (event.target.tagName === 'INPUT') return;
  if (event.key === 'ArrowLeft') loadDate(addDays(state.selected, -1));
  if (event.key === 'ArrowRight') loadDate(addDays(state.selected, 1));
  if (event.key.toLowerCase() === 't') loadDate(TODAY);
});

/* ---------------- boot ---------------- */

store('hoops.sport', state.sport);

const returning = takeReturnState();
if (returning) {
  // Restoring what was on screen is a convenience; it must never be able to
  // stop the fixtures for this date from loading.
  try {
    applyReturnState(returning);
  } catch (error) {
    console.error('[restore] could not restore the previous view:', error);
  }
}

syncSportTabs();
renderCalendar();

if (returning) scheduleReturn(returning);
loadDate(state.selected);
