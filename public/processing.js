/* Processing + Database tabs.
 *
 * Wrapped in an IIFE because app.js already declares its own top-level
 * `state`/`els` bindings in the same classic-script scope.
 */
(() => {
  const byId = (id) => document.getElementById(id);

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const round = (value, digits = 2) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '–';
    const factor = 10 ** digits;
    return String(Math.round(n * factor) / factor);
  };

  const pct = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return '–';
    return /%$/.test(text) ? text : `${text}%`;
  };

  const dateLabel = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  };

  const sportLabel = (sport) => (sport === 'football' ? '⚽ Football' : '🏀 Basketball');

  const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const formBadges = (form) =>
    (form || []).length
      ? `<span class="mini-form-row">${form
          .map((letter) => `<span class="mini-form ${String(letter).toLowerCase()}">${esc(letter)}</span>`)
          .join('')}</span>`
      : '<span class="muted">–</span>';

  const statusPill = (status) => {
    const tone =
      status === 'done' ? 'ok' : status === 'partial' ? 'warn' : status === 'error' ? 'err' : status === 'running' ? 'run' : 'muted';
    return `<span class="pill ${tone}">${esc(status)}</span>`;
  };

  const state = {
    view: 'fixtures',
    jobId: null,
    timer: null,
    db: null,
    dbTab: 'days',
    query: '',
    details: new Map(),
    viewingFixture: null,
    stack: [],
    current: null,
    procDate: null,
    procSport: 'football',
    procCursor: null,
    predDate: null,
    predSport: 'football',
    predCursor: null,
    predTimer: null,
    predData: null,
  };

  const els = {
    tabs: byId('viewTabs'),
    fixturesView: byId('fixturesView'),
    processingView: byId('processingView'),
    databaseView: byId('databaseView'),
    predictionView: byId('predictionView'),
    predCalMonth: byId('predCalMonth'),
    predCalGrid: byId('predCalGrid'),
    predPrevMonth: byId('predPrevMonth'),
    predNextMonth: byId('predNextMonth'),
    predSelected: byId('predSelected'),
    predSportSwitch: byId('predSportSwitch'),
    predBtn: byId('predBtn'),
    predStatus: byId('predStatus'),
    predPill: byId('predPill'),
    predSummary: byId('predSummary'),
    predRunBtn: byId('predRunBtn'),
    predResults: byId('predResults'),
    mlView: byId('mlView'),
    mlContent: byId('mlContent'),
    mlPill: byId('mlPill'),
    procCalMonth: byId('procCalMonth'),
    procCalGrid: byId('procCalGrid'),
    procPrevMonth: byId('procPrevMonth'),
    procNextMonth: byId('procNextMonth'),
    procSelected: byId('procSelected'),
    procSportSwitch: byId('procSportSwitch'),
    procBtn: byId('procBtn'),
    procStatus: byId('procStatus'),
    procRuns: byId('procRuns'),
    dbStats: byId('dbStats'),
    dbList: byId('dbList'),
    dbDetail: byId('dbDetail'),
    dbTabs: byId('dbTabs'),
    dbSearch: byId('dbSearch'),
    dbUpdated: byId('dbUpdated'),
  };

  /* ---------------- views ---------------- */

  function setView(view) {
    state.view = view;
    for (const tab of els.tabs.querySelectorAll('[data-view]')) {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    els.fixturesView.hidden = view !== 'fixtures';
    els.processingView.hidden = view !== 'processing';
    els.databaseView.hidden = view !== 'database';
    els.predictionView.hidden = view !== 'prediction';
    els.mlView.hidden = view !== 'ml';

    if (view === 'processing') loadRuns();
    if (view === 'prediction') loadPredictions();
    if (view === 'database') loadDatabase();
    if (view === 'ml') loadMl();
  }

  els.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-view]');
    if (tab) setView(tab.dataset.view);
  });

  /* ---------------- processing ---------------- */

  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const toISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fromISO = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const longDate = (iso) => {
    const d = fromISO(iso);
    return `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  };

  const today = toISO(new Date());
  const yesterday = toISO(new Date(Date.now() - 86400000));
  state.procDate = yesterday;
  state.procCursor = { year: fromISO(yesterday).getFullYear(), month: fromISO(yesterday).getMonth() };
  state.predDate = today;
  state.predCursor = { year: fromISO(today).getFullYear(), month: fromISO(today).getMonth() };

  /* One date grid for both calendar panels; `attr` keeps their clicks apart. */
  function calendarMarkup(cursor, selected, attr) {
    const { year, month } = cursor;
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let html = '';
    for (let i = 0; i < offset; i += 1) html += '<span class="cal-day blank" aria-hidden="true"></span>';

    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dow = new Date(year, month, day).getDay();
      const future = iso > today;
      const classes = ['cal-day'];
      if (future) classes.push('future');
      if (dow === 0 || dow === 6) classes.push('weekend');
      if (iso === today) classes.push('today');
      if (iso === selected) classes.push('selected');
      html += `<button type="button" class="${classes.join(' ')}" data-${attr}="${iso}"
        ${future ? 'disabled' : ''} role="gridcell" aria-selected="${iso === selected}"
        aria-label="${longDate(iso)}">${day}${iso === today ? '<span class="today-dot"></span>' : ''}</button>`;
    }
    return html;
  }

  function renderProcCalendar() {
    const { year, month } = state.procCursor;
    els.procCalMonth.textContent = `${MONTHS[month]} ${year}`;

    const now = fromISO(today);
    const atCurrentMonth = year === now.getFullYear() && month === now.getMonth();
    els.procNextMonth.disabled = atCurrentMonth;

    els.procCalGrid.innerHTML = calendarMarkup(state.procCursor, state.procDate, 'proc-date');
    els.procSelected.textContent = longDate(state.procDate);
  }

  els.procCalGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-proc-date]');
    if (!button || button.disabled) return;
    state.procDate = button.dataset.procDate;
    const d = fromISO(state.procDate);
    state.procCursor = { year: d.getFullYear(), month: d.getMonth() };
    renderProcCalendar();
  });

  els.procPrevMonth.addEventListener('click', () => {
    const { year, month } = state.procCursor;
    state.procCursor = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
    renderProcCalendar();
  });

  els.procNextMonth.addEventListener('click', () => {
    const { year, month } = state.procCursor;
    const now = fromISO(today);
    if (year === now.getFullYear() && month === now.getMonth()) return;
    state.procCursor = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
    renderProcCalendar();
  });

  els.procSportSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-proc-sport]');
    if (!button || button.dataset.procSport === state.procSport) return;
    state.procSport = button.dataset.procSport;
    for (const tab of els.procSportSwitch.querySelectorAll('[data-proc-sport]')) {
      const active = tab.dataset.procSport === state.procSport;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
  });

  renderProcCalendar();

  function progressBar(job) {
    const { done = 0, total = 0 } = job.progress || {};
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return `<div class="progress"><span style="width:${percent}%"></span></div>`;
  }

  function renderJob(job, target = els.procStatus) {
    const counts = job.counts || {};
    const errors = job.errors || [];
    const ready = job.mode === 'prediction';
    target.hidden = false;
    target.innerHTML = `
      <div class="proc-live-head">
        <div>
          <strong>${esc(job.date)} · ${sportLabel(job.sport)}</strong>
          ${ready ? '<span class="pill muted">prediction</span>' : ''}
          <span class="muted">${statusPill(job.status)} ${job.status === 'running' ? `${job.progress?.done || 0}/${job.progress?.total || 0} fixtures` : ''}</span>
        </div>
        <span class="muted">${esc(job.progress?.stage || '')}</span>
      </div>
      ${job.status === 'running' ? progressBar(job) : ''}
      <div class="proc-counts">
        <span><b>${counts.fixtures ?? job.progress?.done ?? 0}</b> ${ready ? 'ready' : 'fixtures'}</span>
        <span><b>${counts.skipped ?? 0}</b> skipped</span>
        <span><b>${counts.teams ?? job.progress?.teams ?? 0}</b> teams</span>
        <span><b>${counts.competitions ?? job.progress?.competitions ?? 0}</b> competitions</span>
        <span><b>${counts.errors ?? errors.length}</b> errors</span>
      </div>
      ${job.error ? `<p class="proc-error">${esc(job.error)}</p>` : ''}
      ${(job.log || []).length ? `<pre class="proc-log">${esc(job.log.slice(-40).join('\n'))}</pre>` : ''}
    `;
  }

  /* A run lives in server memory. If the server is restarted the id stops
   * existing, so say that plainly instead of leaving a frozen RUNNING card. */
  function abandonJob(message) {
    clearInterval(state.timer);
    state.timer = null;
    els.procBtn.disabled = false;
    els.procBtn.textContent = 'Process date';
    const note = document.createElement('p');
    note.className = 'proc-done';
    note.textContent = message;
    els.procStatus.appendChild(note);
    loadRuns();
  }

  async function pollJob(id) {
    clearInterval(state.timer);
    let misses = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/process/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) {
          clearInterval(state.timer);
          state.timer = null;
          abandonJob(
            res.status === 404
              ? 'This run is no longer on the server (it was restarted). Anything already collected is kept — start processing that date again.'
              : `Lost track of this run (HTTP ${res.status}). Start processing that date again.`
          );
          return;
        }
        misses = 0;
        const { job } = await res.json();
        renderJob(job);
        if (job.status !== 'running' && job.status !== 'queued') {
          clearInterval(state.timer);
          state.timer = null;
          els.procBtn.disabled = false;
          els.procBtn.textContent = 'Process date';
          loadRuns();
          state.db = null;
          state.details.clear();
          const day = job.status === 'done' || job.status === 'partial';
          if (day) {
            const note = document.createElement('p');
            note.className = 'proc-done';
            note.innerHTML = `Saved. <button class="btn tiny" type="button" id="openDayFromJob">Open in Database</button>`;
            els.procStatus.appendChild(note);
            byId('openDayFromJob')?.addEventListener('click', () =>
              openDay(`${job.sport}|${job.date}`, { jump: true })
            );
          }
        }
      } catch {
        // Tolerate a brief network blip before declaring the run lost.
        misses += 1;
        if (misses < 4) return;
        clearInterval(state.timer);
        state.timer = null;
        abandonJob('Lost contact with the server, so this run can no longer be followed. Start processing that date again.');
      }
    };
    await tick();
    state.timer = setInterval(tick, 1500);
  }

  els.procBtn.addEventListener('click', async () => {
    const date = state.procDate;
    const sport = state.procSport;
    if (!date || date > today) return;

    els.procBtn.disabled = true;
    els.procBtn.textContent = 'Processing…';
    els.procStatus.hidden = false;
    els.procStatus.innerHTML = '<p class="muted">Starting…</p>';

    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ date, sport }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      state.jobId = json.job.id;
      renderJob({ ...json.job, log: ['Started'], counts: {}, progress: json.job.progress || {} });
      pollJob(state.jobId);
    } catch (error) {
      els.procBtn.disabled = false;
      els.procBtn.textContent = 'Process date';
      els.procStatus.innerHTML = `<p class="proc-error">${esc(error.message || error)}</p>`;
    }
  });

  async function loadRuns() {
    try {
      const res = await fetch('/api/process', { cache: 'no-store' });
      if (!res.ok) return;
      const { jobs } = await res.json();
      if (!jobs.length) {
        els.procRuns.innerHTML = '<p class="muted pad">No processing runs yet. Pick a date above and press Process.</p>';
        return;
      }
      els.procRuns.innerHTML = jobs
        .map((job) => {
          const counts = job.counts || {};
          return `<div class="run-row">
            <div class="run-main">
              <strong>${esc(job.date)}</strong>
              <span class="muted">${sportLabel(job.sport)}</span>
              ${statusPill(job.status)}
            </div>
            <div class="run-meta muted">
              ${counts.fixtures ?? job.progress?.done ?? 0} fixtures ·
              ${counts.skipped ?? 0} skipped ·
              ${counts.teams ?? job.progress?.teams ?? 0} teams ·
              ${counts.competitions ?? job.progress?.competitions ?? 0} competitions
              ${job.error ? ` · ${esc(job.error)}` : ''}
            </div>
            <div class="run-side">
              <span class="muted">${esc(dateLabel(job.startedAt))}</span>
              ${job.status === 'done' || job.status === 'partial'
                ? `<button class="btn tiny" type="button" data-open-day="${esc(`${job.sport}|${job.date}`)}">Open</button>`
                : ''}
            </div>
          </div>`;
        })
        .join('');
    } catch {
      els.procRuns.innerHTML = '<p class="muted pad">Could not read processing history.</p>';
    }
  }

  els.procRuns.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-day]');
    if (button) openDay(button.dataset.openDay, { jump: true });
  });

  /* ---------------- prediction ---------------- */

  function renderPredCalendar() {
    const { year, month } = state.predCursor;
    els.predCalMonth.textContent = `${MONTHS[month]} ${year}`;
    const now = fromISO(today);
    els.predNextMonth.disabled = year === now.getFullYear() && month === now.getMonth();
    els.predCalGrid.innerHTML = calendarMarkup(state.predCursor, state.predDate, 'pred-date');
    els.predSelected.textContent = longDate(state.predDate);
  }

  els.predCalGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pred-date]');
    if (!button || button.disabled) return;
    state.predDate = button.dataset.predDate;
    const d = fromISO(state.predDate);
    state.predCursor = { year: d.getFullYear(), month: d.getMonth() };
    renderPredCalendar();
  });

  els.predPrevMonth.addEventListener('click', () => {
    const { year, month } = state.predCursor;
    state.predCursor = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
    renderPredCalendar();
  });

  els.predNextMonth.addEventListener('click', () => {
    const { year, month } = state.predCursor;
    const now = fromISO(today);
    if (year === now.getFullYear() && month === now.getMonth()) return;
    state.predCursor = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
    renderPredCalendar();
  });

  els.predSportSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pred-sport]');
    if (!button || button.dataset.predSport === state.predSport) return;
    state.predSport = button.dataset.predSport;
    for (const tab of els.predSportSwitch.querySelectorAll('[data-pred-sport]')) {
      const active = tab.dataset.predSport === state.predSport;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
  });

  renderPredCalendar();

  function predAbandon(message) {
    clearInterval(state.predTimer);
    state.predTimer = null;
    els.predBtn.disabled = false;
    els.predBtn.textContent = 'Process for prediction';
    els.predStatus.hidden = false;
    els.predStatus.insertAdjacentHTML('beforeend', `<p class="proc-done">${esc(message)}</p>`);
  }

  async function pollPredictionJob(id) {
    clearInterval(state.predTimer);
    let misses = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/process/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) {
          clearInterval(state.predTimer);
          state.predTimer = null;
          predAbandon(
            res.status === 404
              ? 'This run is no longer on the server (it was restarted). Anything already stored is kept — process that date again.'
              : `Lost track of this run (HTTP ${res.status}). Process that date again.`
          );
          return;
        }
        misses = 0;
        const { job } = await res.json();
        renderJob(job, els.predStatus);
        if (job.status !== 'running' && job.status !== 'queued') {
          clearInterval(state.predTimer);
          state.predTimer = null;
          els.predBtn.disabled = false;
          els.predBtn.textContent = 'Process for prediction';
          await loadPredictions();
        }
      } catch {
        misses += 1;
        if (misses < 4) return;
        clearInterval(state.predTimer);
        state.predTimer = null;
        predAbandon('Lost contact with the server, so this run can no longer be followed. Process that date again.');
      }
    };
    await tick();
    state.predTimer = setInterval(tick, 1500);
  }

  els.predBtn.addEventListener('click', async () => {
    const date = state.predDate;
    const sport = state.predSport;
    if (!date || date > today) return;

    els.predBtn.disabled = true;
    els.predBtn.textContent = 'Preparing…';
    els.predStatus.hidden = false;
    els.predStatus.innerHTML = '<p class="muted">Starting…</p>';

    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ date, sport, mode: 'prediction' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      els.predStatus.innerHTML = '';
      renderJob(
        { ...json.job, mode: 'prediction', log: ['Started'], counts: {}, progress: json.job.progress || {} },
        els.predStatus
      );
      pollPredictionJob(json.job.id);
    } catch (error) {
      els.predBtn.disabled = false;
      els.predBtn.textContent = 'Process for prediction';
      els.predStatus.innerHTML = `<p class="proc-error">${esc(error.message || error)}</p>`;
    }
  });

  function storedPredictionTable(fixtures) {
    const rows = fixtures
      .map(
        (fx) => `<tr>
          <td>${esc(fx.date)}</td>
          <td class="pred-match"><strong>${esc(fx.home)}</strong><span>${esc(fx.away)}</span><span class="muted">${esc(fx.leagueName || '–')}</span></td>
          <td>${esc(fx.kickoff || '–')}</td>
          <td>${fx.score ? `${esc(fx.score.home)}–${esc(fx.score.away)}` : `<span class="muted">${esc(fx.status || 'scheduled')}</span>`}</td>
        </tr>`
      )
      .join('');
    return `<div class="table-scroll"><table class="db-table pred-table">
      <thead><tr><th>Date</th><th>Match</th><th>Kickoff</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  async function loadPredictions() {
    if (!els.predResults) return;
    try {
      const res = await fetch('/api/predictions', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      state.predData = data;
      const trained = Boolean(data.model);
      const total = data.total || 0;
      els.predPill.textContent = `${total} ready`;
      els.predPill.className = `pill ${total ? 'ok' : 'muted'}`;
      els.predRunBtn.disabled = !total || !trained;
      els.predSummary.textContent = !total
        ? 'No matches stored for prediction yet. Pick a date above and process it.'
        : `${total} matches ready across ${data.dates.length} ${data.dates.length === 1 ? 'date' : 'dates'} (${data.dates.slice(0, 4).join(', ')}${data.dates.length > 4 ? '…' : ''}).${trained ? '' : ' Train the model in ML Training before predicting.'}`;
      els.predResults.innerHTML = total
        ? storedPredictionTable(data.fixtures)
        : '<p class="muted pad">Process a date above to store matches ready for prediction.</p>';
    } catch (error) {
      els.predResults.innerHTML = `<p class="proc-error">${esc(error.message || 'Could not load prediction data.')}</p>`;
    }
  }

  function renderPredictionResults(data) {
    const results = data.results || [];
    const skipped = data.skipped || [];
    const rows = results
      .map((row) => {
        const probs = row.probabilities || {};
        const btts = row.btts || {};
        const over = row.over25 || {};
        const score = row.correctScore || {};
        return `<tr>
          <td>${esc(row.date)}</td>
          <td class="pred-match"><strong>${esc(row.home)}</strong><span>${esc(row.away)}</span><span class="muted">${esc(row.leagueName || '–')}</span></td>
          <td><span class="pred-pick">${esc(row.pick)}</span><span class="pred-probs">1 ${esc(probs['1'])}% · X ${esc(probs.X)}% · 2 ${esc(probs['2'])}%</span></td>
          <td><span class="pred-pick">${esc(btts.pick || '–')}</span><span class="pred-probs">${esc(btts.yes)}% / ${esc(btts.no)}%</span></td>
          <td><span class="pred-pick">${esc(over.pick || '–')}</span><span class="pred-probs">${esc(over.over)}% / ${esc(over.under)}%</span></td>
          <td class="pred-score">${esc(row.totalGoals)}</td>
          <td class="pred-score">${esc(score.score || '–')}<span class="pred-probs">${esc(score.probability)}%</span></td>
        </tr>`;
      })
      .join('');

    const skippedNote = skipped.length
      ? `<p class="rate-note">${skipped.length} stored ${skipped.length === 1 ? 'match' : 'matches'} could not be scored (${esc(
          [...new Set(skipped.map((entry) => entry.reason))].join(', ')
        )}). Process that date again to refresh the data.</p>`
      : '';

    els.predResults.innerHTML =
      `<p class="rate-note">Predicted <strong>${data.predicted}</strong> of ${data.total} stored matches${data.model ? ` · model trained ${esc(dateLabel(data.model.trainedAt))}` : ''}.</p>` +
      `<div class="table-scroll"><table class="db-table pred-table">
        <thead><tr><th>Date</th><th>Match</th><th>1X2</th><th>BTTS</th><th>O/U 2.5</th><th>Goals</th><th>Score</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">Nothing could be predicted.</td></tr>'}</tbody>
      </table></div>` +
      skippedNote;
  }

  els.predRunBtn.addEventListener('click', async () => {
    els.predRunBtn.disabled = true;
    els.predRunBtn.textContent = 'Predicting…';
    els.predResults.innerHTML = '<p class="muted pad">Running the model over every stored match…</p>';
    try {
      const res = await fetch('/api/predictions/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sport: state.predSport }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      renderPredictionResults(data);
    } catch (error) {
      els.predResults.innerHTML = `<p class="proc-error">${esc(error.message || 'Prediction failed.')}</p>`;
    } finally {
      els.predRunBtn.textContent = 'Predict all';
      els.predRunBtn.disabled = !state.predData?.total || !state.predData?.model;
    }
  });

  /* ---------------- database ---------------- */

  async function loadDatabase(force = false) {
    if (state.db && !force) {
      renderDatabase();
      return;
    }
    els.dbList.innerHTML = '<p class="muted pad">Loading database…</p>';
    try {
      const res = await fetch('/api/database', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      state.db = await res.json();
      renderDatabase();
      // Open the newest processed day straight away so the tab lands on match
      // records and outcomes rather than an empty panel.
      if (!state.current && state.db.days?.length) openDay(state.db.days[0].key);
    } catch (error) {
      els.dbList.innerHTML = `<p class="proc-error">${esc(error.message || error)}</p>`;
    }
  }

  function renderDatabase() {
    const db = state.db;
    if (!db) return;

    els.dbUpdated.textContent = db.updatedAt ? `Updated ${dateLabel(db.updatedAt)}` : 'Nothing stored yet';
    els.dbStats.innerHTML = [
      ['Processed days', db.counts.days],
      ['Fixtures', db.counts.fixtures],
      ['Teams', db.counts.teams],
      ['Competitions', db.counts.competitions],
    ]
      .map(([label, value]) => `<div class="db-stat"><strong>${value}</strong><span>${label}</span></div>`)
      .join('');

    for (const tab of els.dbTabs.querySelectorAll('[data-db]')) {
      tab.classList.toggle('active', tab.dataset.db === state.dbTab);
    }
    renderList();
  }

  function renderList() {
    const db = state.db;
    if (!db) return;
    const query = state.query;

    if (state.dbTab === 'days') {
      const days = db.days.filter((day) =>
        !query || `${day.date} ${day.sport}`.toLowerCase().includes(query)
      );
      if (!days.length) {
        els.dbList.innerHTML = '<p class="muted pad">No processed dates yet. Run the Processing tab first.</p>';
        return;
      }
      els.dbList.innerHTML = days
        .map((day) => `<button class="db-row" type="button" data-day="${esc(day.key)}">
          <span class="db-row-main"><strong>${esc(day.date)}</strong> ${sportLabel(day.sport)}</span>
          <span class="muted">${day.fixtures} fixtures${day.skipped ? ` · ${day.skipped} skipped` : ''} · ${day.teams} teams · ${day.competitions} competitions</span>
          <span class="db-row-side">${statusPill(day.status)}<span class="muted">${esc(dateLabel(day.updatedAt))}</span></span>
        </button>`)
        .join('');
      return;
    }

    if (state.dbTab === 'teams') {
      const teams = db.teams.filter((team) =>
        !query || `${team.name} ${team.sport} ${team.teamId || ''}`.toLowerCase().includes(query)
      );
      if (!teams.length) {
        els.dbList.innerHTML = '<p class="muted pad">No teams stored yet.</p>';
        return;
      }
      els.dbList.innerHTML = teams
        .map((team) => `<button class="db-row" type="button" data-team="${esc(team.key)}">
          <span class="db-row-main"><strong>${esc(team.name)}</strong>
            <span class="muted">${team.sport}${team.teamId ? ` · id ${team.teamId}` : ''}</span>
            ${team.hasProfile ? '' : '<span class="pill muted">no profile</span>'}
          </span>
          <span class="muted">${team.position ? `#${esc(team.position)}` : '–'} ·
            ${team.avgScored != null ? `${round(team.avgScored)} scored` : 'no averages'} ·
            ${team.avgConceded != null ? `${round(team.avgConceded)} conceded` : ''}</span>
          <span class="db-row-side">${formBadges(team.form)}<span class="muted">${team.fixtures} fixtures</span></span>
        </button>`)
        .join('');
      return;
    }

    const competitions = db.competitions.filter((competition) =>
      !query || `${competition.name} ${competition.sport} ${competition.leagueId || ''}`.toLowerCase().includes(query)
    );
    if (!competitions.length) {
      els.dbList.innerHTML = '<p class="muted pad">No competitions stored yet.</p>';
      return;
    }
    els.dbList.innerHTML = competitions
      .map((competition) => `<button class="db-row" type="button" data-competition="${esc(competition.key)}">
        <span class="db-row-main"><strong>${esc(competition.name)}</strong>
          <span class="muted">${competition.sport}${competition.leagueId ? ` · league ${competition.leagueId}` : ''}</span>
        </span>
        <span class="muted">${competition.teams} teams ·
          league avg goals ${competition.leagueAverageGoals != null ? round(competition.leagueAverageGoals) : '–'}</span>
        <span class="db-row-side muted">${esc(dateLabel(competition.updatedAt))}</span>
      </button>`)
      .join('');
  }

  els.dbTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-db]');
    if (!tab) return;
    state.dbTab = tab.dataset.db;
    state.query = els.dbSearch.value.trim().toLowerCase();
    renderDatabase();
  });

  els.dbSearch.addEventListener('input', () => {
    state.query = els.dbSearch.value.trim().toLowerCase();
    renderList();
  });

  els.dbList.addEventListener('click', (event) => {
    const day = event.target.closest('[data-day]');
    if (day) return openDay(day.dataset.day);
    const team = event.target.closest('[data-team]');
    if (team) return openTeam(team.dataset.team);
    const competition = event.target.closest('[data-competition]');
    if (competition) return openCompetition(competition.dataset.competition);
  });

  els.dbDetail.addEventListener('click', (event) => {
    const backDay = event.target.closest('[data-back-day]');
    if (backDay) return backToDay();
    const openFixtureButton = event.target.closest('[data-open-fixture]');
    if (openFixtureButton) return openFixture(openFixtureButton.dataset.openFixture);
    const deleteDayButton = event.target.closest('[data-delete-day]');
    if (deleteDayButton) return removeDay(deleteDayButton.dataset.deleteDay);
    const deleteFixtureButton = event.target.closest('[data-delete-fixture]');
    if (deleteFixtureButton) return removeFixture(deleteFixtureButton.dataset.deleteFixture);
    const back = event.target.closest('[data-back]');
    if (back) {
      const previous = state.stack.pop();
      if (!previous) {
        state.current = null;
        els.dbDetail.innerHTML = '';
        return;
      }
      return showDetail(previous.kind, previous.key, { mode: 'restore' });
    }
    const team = event.target.closest('[data-team-link]');
    if (team) return showDetail('team', team.dataset.teamLink);
    const competition = event.target.closest('[data-comp-link]');
    if (competition) return showDetail('competition', competition.dataset.compLink);
    const tableTab = event.target.closest('[data-table-tab]');
    if (tableTab) {
      const holder = tableTab.closest('[data-tables]');
      if (holder) {
        holder.querySelectorAll('[data-table-tab]').forEach((tab) => tab.classList.toggle('active', tab === tableTab));
        holder.querySelectorAll('[data-table-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.tablePanel !== tableTab.dataset.tableTab;
        });
      }
    }
  });

  async function fetchDetail(kind, key) {
    const cacheKey = `${kind}|${key}`;
    if (state.details.has(cacheKey)) return state.details.get(cacheKey);
    const url = `/api/database/${kind}?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    state.details.set(cacheKey, json);
    return json;
  }

  function backButton(label) {
    return `<button class="btn tiny back-btn" type="button" data-back>← ${esc(label || 'Back')}</button>`;
  }

  async function showDetail(kind, key, { mode = 'push' } = {}) {
    if (mode === 'reset') state.stack = [];
    else if (mode === 'push' && state.current) state.stack.push(state.current);
    state.current = { kind, key };
    state.viewingFixture = null;

    els.dbDetail.innerHTML = `<p class="muted pad">Loading ${kind}…</p>`;
    try {
      const data = await fetchDetail(kind, key);
      if (kind === 'day') els.dbDetail.innerHTML = renderDay(data);
      else if (kind === 'team') els.dbDetail.innerHTML = renderTeam(data);
      else els.dbDetail.innerHTML = renderCompetition(data);
    } catch (error) {
      console.error('[database] detail failed', error);
      const message =
        error?.message || (typeof error === 'string' ? error : JSON.stringify(error)) || 'Could not load this record.';
      els.dbDetail.innerHTML = `<p class="proc-error">${esc(message)}</p>`;
    }
  }

  const openDay = (key, { jump = false } = {}) => {
    if (jump) setView('database');
    return showDetail('day', key, { mode: 'reset' });
  };

  const openTeam = (key) => showDetail('team', key);
  const openCompetition = (key) => showDetail('competition', key);

  function openFixture(fixtureId) {
    if (state.current?.kind !== 'day') return;
    const day = state.details.get(`day|${state.current.key}`);
    const fixture = day?.fixtures?.find(
      (entry) => String(entry.fixtureId) === String(fixtureId)
    );
    if (!fixture) return;
    state.viewingFixture = String(fixtureId);
    els.dbDetail.innerHTML = renderFixture(fixture, day);
    els.dbDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadFixtureMl(String(fixtureId));
  }

  async function loadFixtureMl(fixtureId) {
    const slot = Array.from(document.querySelectorAll('[data-ml-slot]')).find(
      (element) => element.dataset.mlSlot === String(fixtureId)
    );
    if (!slot) return;
    const sport = slot.dataset.mlSport || 'football';
    if (sport !== 'football') {
      slot.innerHTML = `<h4>Machine learning prediction</h4><p class="rate-note">The ML model is trained on football matches only.</p>`;
      return;
    }
    try {
      const query = new URLSearchParams({ fixture_id: fixtureId, sport });
      if (slot.dataset.mlDate) query.set('date', slot.dataset.mlDate);
      if (slot.dataset.mlLeague) query.set('league_id', slot.dataset.mlLeague);
      const res = await fetch(`/api/ml/predict?${query.toString()}`, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.available) {
        slot.innerHTML = `<h4>Machine learning prediction</h4><p class="rate-note">${esc(data.error || 'No prediction is available for this match.')}</p>`;
        return;
      }
      slot.innerHTML = `<h4>Machine learning prediction <span class="muted">ML</span></h4>
        <div class="ml-pred-grid">
          <div class="ml-pred"><span>1X2</span><strong>${esc(data.pick)}</strong><small>1 ${esc(data.probabilities['1'])}% · X ${esc(data.probabilities.X)}% · 2 ${esc(data.probabilities['2'])}%</small></div>
          <div class="ml-pred"><span>BTTS</span><strong>${esc(data.btts.pick)}</strong><small>Yes ${esc(data.btts.yes)}% · No ${esc(data.btts.no)}%</small></div>
          <div class="ml-pred"><span>Total goals</span><strong>${esc(data.totalGoals)}</strong><small>${esc(data.over25.pick)} · ${esc(data.over25.over)}% over</small></div>
          <div class="ml-pred"><span>Correct score</span><strong>${esc(data.correctScore.score || '–')}</strong><small>${esc(data.correctScore.probability)}% probability</small></div>
        </div>
        <div class="table-scroll"><table class="db-table comparison-table ml-score-table">
          <thead><tr><th>Most likely scores</th><th>Probability</th></tr></thead>
          <tbody>${(data.correctScore.top || []).map((entry) => `<tr><td>${esc(entry.score)}</td><td>${esc(entry.probability)}%</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="rate-note">Trained on ${esc(data.model.samples)} complete matches. Model estimate, not a guarantee.</p>`;
    } catch {
      slot.innerHTML = '<h4>Machine learning prediction</h4><p class="rate-note">Could not load the ML prediction.</p>';
    }
  }

  function backToDay() {
    if (state.current?.kind !== 'day') return;
    const day = state.details.get(`day|${state.current.key}`);
    state.viewingFixture = null;
    if (day) els.dbDetail.innerHTML = renderDay(day);
  }

  async function removeDay(key) {
    if (!window.confirm('Delete every stored match and outcome for this day? This cannot be undone.')) return;
    const res = await fetch(`/api/database/day?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.alert(json.error || 'Could not delete this day.');
      return;
    }
    state.details.delete(`day|${key}`);

    state.current = null;
    state.stack = [];
    state.viewingFixture = null;
    els.dbDetail.innerHTML = '';
    await loadDatabase(true);
  }

  async function removeFixture(fixtureId) {
    if (state.current?.kind !== 'day') return;
    const key = state.current.key;
    if (!window.confirm('Delete this stored match and its outcome?')) return;
    const res = await fetch(
      `/api/database/fixture?key=${encodeURIComponent(key)}&fixture_id=${encodeURIComponent(fixtureId)}`,
      { method: 'DELETE' }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.alert(json.error || 'Could not delete this match.');
      return;
    }
    state.details.delete(`day|${key}`);
    await loadDatabase(true);
    if ((json.remaining ?? 0) > 0) {
      await showDetail('day', key, { mode: 'reset' });
    } else {
      state.current = null;
      els.dbDetail.innerHTML = '';
    }
  }

  function actualOutcome(fx) {
    const home = Number(fx.score?.home);
    const away = Number(fx.score?.away);
    if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
    const total = home + away;
    return {
      home,
      away,
      total,
      result: home > away ? '1' : home === away ? 'X' : '2',
      overUnder: total > 2.5 ? 'Over' : 'Under',
      btts: home > 0 && away > 0 ? 'Yes' : 'No',
    };
  }

  function renderDay(day) {
    const settled = day.fixtures.filter((fx) => fx.score).length;
    const header = `<div class="detail-head">
      <div>
        <h3>${esc(day.date)} · ${sportLabel(day.sport)}</h3>
        <p class="muted">${day.fixtures.length} match records · ${settled} settled
          ${day.skipped?.length ? ` · ${day.skipped.length} incomplete not stored` : ''}
          ${day.errors?.length ? ` · ${day.errors.length} errors` : ''} · processed ${esc(dateLabel(day.processedAt))}</p>
      </div>
      <div class="detail-actions">
        ${statusPill(day.status)}
        <button class="btn tiny danger" type="button" data-delete-day="${esc(day.key)}">Delete stored matches</button>
      </div>
    </div>
    <p class="muted pad">Outcomes are the actual result. “Ours” shows what the model priced before kick-off.
      Open a row for the full dossier: league averages, market rates, form, streaks, standings, community picks and the model split.
      The community 1/X/2 split needs a Vitibet sign-in; the pick count is stored.</p>`;

    const skipped = Array.isArray(day.skipped) ? day.skipped : [];
    const skippedBox = skipped.length
      ? `<details class="skipped-box"><summary>${skipped.length} match${skipped.length === 1 ? '' : 'es'} skipped for incomplete stats or result</summary>
          <ul>${skipped
            .slice(0, 60)
            .map((item) => `<li><strong>${esc(item.home)} v ${esc(item.away)}</strong> <span class="muted">${esc(item.leagueName || '')} · ${esc((item.reasons || []).join(', '))}</span></li>`)
            .join('')}</ul>
          ${skipped.length > 60 ? `<p class="muted">…and ${skipped.length - 60} more.</p>` : ''}
        </details>`
      : '';

    if (!day.fixtures.length) {
      return `${header}${skippedBox}<p class="muted pad">No complete matches were stored for this day.</p>`;
    }

    const rows = day.fixtures
      .map((fx) => {
        const o = actualOutcome(fx);
        const calc = fx.calculated || {};
        const vitibet = fx.vitibet || {};
        const markets = Object.fromEntries((calc.markets || []).map((market) => [market.key, market]));
        const probs = calc.probabilities || {};
        const best = calc.best;

        const missed = fx.bestResult === 'lost';
        return `<tr>
          <td class="t-time">${esc(fx.kickoff || '–')}</td>
          <td class="t-match">
            <div class="t-teams">
              ${fx.homeTeamKey ? `<button type="button" class="linkish" data-team-link="${esc(fx.homeTeamKey)}">${esc(fx.home)}</button>` : esc(fx.home)}
              <i>v</i>
              ${fx.awayTeamKey ? `<button type="button" class="linkish" data-team-link="${esc(fx.awayTeamKey)}">${esc(fx.away)}</button>` : esc(fx.away)}
            </div>
            <div class="t-comp">
              ${fx.competitionKey
                ? `<button type="button" class="linkish" data-comp-link="${esc(fx.competitionKey)}">${esc(fx.leagueName || 'Competition')}</button>`
                : esc(fx.leagueName || 'Competition')}
            </div>
          </td>
          <td class="t-score">${o ? `${o.home} : ${o.away}` : '—'}</td>
          <td class="t-out">
            ${o ? `<span class="out out-${o.result.toLowerCase()}">${o.result}</span>` : '<span class="muted">—</span>'}
            <small>ours 1 ${pct(probs['1'])} · X ${pct(probs.X)} · 2 ${pct(probs['2'])}</small>
          </td>
          <td class="t-out">
            ${o ? `<b>${o.total}</b>` : '<span class="muted">—</span>'}
            <small>${calc.total != null ? `pred ${esc(calc.total)}${fx.totalDelta != null ? ` (${fx.totalDelta > 0 ? '+' : ''}${esc(fx.totalDelta)})` : ''}` : 'no prediction'}</small>
          </td>
          <td class="t-out">
            ${o ? `<span class="out out-${o.overUnder.toLowerCase()}">${o.overUnder}</span>` : '<span class="muted">—</span>'}
            <small>O2.5 ${markets['O2.5'] ? pct(markets['O2.5'].pct) : '–'}</small>
          </td>
          <td class="t-out">
            ${o ? `<span class="out out-${o.btts.toLowerCase()}">${o.btts}</span>` : '<span class="muted">—</span>'}
            <small>GG ${markets.GG ? pct(markets.GG.pct) : '–'}</small>
          </td>
          <td class="t-out">
            ${best ? `<span class="best-chip"><em>BEST</em><b>${esc(best.label)}</b><i>${esc(best.pct)}%</i></span>` : '<span class="muted">–</span>'}
            <small class="${missed ? 'bad' : fx.bestResult === 'won' ? 'good' : ''}">${fx.bestResult ? esc(fx.bestResult) : 'not settled'}</small>
          </td>
          <td class="t-out">
            <span class="mono">${calc.form ? `${esc(calc.form.home)} / ${esc(calc.form.away)}` : '–'}</span>
            <small>power ${calc.power ? `${esc(calc.power.home)} / ${esc(calc.power.away)}` : '–'}</small>
          </td>
          <td class="t-out">
            ${vitibet.published
              ? `<b>${esc(vitibet.tip || '–')}</b><small>idx ${esc(vitibet.index ?? '–')}</small>`
              : '<span class="muted">no tip</span>'}
          </td>
          <td class="t-open">
            <button class="btn tiny" type="button" data-open-fixture="${esc(fx.fixtureId)}">Open</button>
          </td>
        </tr>`;
      })
      .join('');

    return `${header}${skippedBox}
      <div class="table-scroll">
        <table class="db-table outcome-table">
          <thead><tr>
            <th>Time</th><th>Match</th><th>Score</th><th>1X2</th><th>Total goals</th>
            <th>O/U 2.5</th><th>BTTS</th><th>Best pick</th><th>Form / Power</th><th>Vitibet</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function competitionTable(rates, league) {
    const recent = rates.recent || {};
    const season = rates.season || {};
    const teams = rates.teams || {};
    const recentMatches = (league.recentMatches || []).slice(0, 10);
    const countPct = (count, percent) =>
      count != null ? `${count} · ${pct(percent)}` : pct(percent);
    const average = (value) => (Number.isFinite(Number(value)) ? round(value) : '–');
    const rows = [
      ['Matches', recent.sample ?? recent.matches ?? '–', season.sample ?? season.matches ?? '–', teams.matches ?? '–'],
      ['Home wins', countPct(recent.homeWins, recent.homeWinPct), countPct(season.homeWins, season.homeWinPct), '–'],
      ['Draws', countPct(recent.draws, recent.drawPct), countPct(season.draws, season.drawPct), pct(teams.drawPct)],
      ['Away wins', countPct(recent.awayWins, recent.awayWinPct), countPct(season.awayWins, season.awayWinPct), '–'],
      ['Team wins', '–', '–', pct(teams.winPct)],
      ['Team losses', '–', '–', pct(teams.lossPct)],
      ['BTTS', countPct(recent.btts, recent.bttsPct), '–', pct(teams.bttsPct)],
      ['Over 2.5', countPct(recent.over25, recent.over25Pct), countPct(season.over25Count, season.over25Pct), pct(teams.over25Pct)],
      ['Clean sheets', countPct(recent.cleanSheets, recent.cleanSheetPct), '–', pct(teams.cleanSheetPct)],
      ['Avg goals/match', average(recent.avgGoals), '–', average(teams.avgGoals)],
    ];
    return `<p class="rate-note">League average goals: <strong>${league.averageGoals != null ? round(league.averageGoals) : '–'}</strong>${league.goalsPerGame != null ? ` · standings ${round(league.goalsPerGame)}/game` : ''}</p>
      <div class="table-scroll"><table class="db-table comparison-table">
        <thead><tr><th>Metric</th><th>Last-10 rates</th><th>Season table</th><th>Team profiles</th></tr></thead>
        <tbody>${rows
          .map(([label, a, b, c]) => `<tr><th>${esc(label)}</th><td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(c)}</td></tr>`)
          .join('')}</tbody>
      </table></div>
      <p class="rate-note">Last-10 rates: aggregate of the competition's ten most recent completed matches. Season: full competition table. Team profiles: pooled club-profile averages, not one team.</p>
      ${recentMatches.length
        ? `<h5>Last ${recentMatches.length} competition matches</h5>
          <div class="table-scroll"><table class="db-table comparison-table recent-competition-table">
            <thead><tr><th>Date</th><th>Home</th><th>Away</th><th>Score</th></tr></thead>
            <tbody>${recentMatches
              .map((match) => {
                const home = match.url
                  ? `<a href="${esc(match.url)}" target="_blank" rel="noreferrer noopener">${esc(match.home || '–')}</a>`
                  : esc(match.home || '–');
                const away = match.url
                  ? `<a href="${esc(match.url)}" target="_blank" rel="noreferrer noopener">${esc(match.away || '–')}</a>`
                  : esc(match.away || '–');
                return `<tr><td>${esc(match.date || '–')}</td><td>${home}</td><td>${away}</td><td>${esc(match.score || '–')}</td></tr>`;
              })
              .join('')}</tbody>
          </table></div>`
        : '<p class="rate-note">No recent competition match list is stored.</p>'}`;
  }

  function teamDossier(team, fallback) {
    const t = team || { name: fallback };
    const stats = [
      ['Position', t.position || '–'],
      ['Points', t.points ?? '–'],
      ['Played', t.played ?? '–'],
      ['Record', t.wins != null ? `${t.wins}-${t.draws}-${t.losses}` : '–'],
      ['Goals', t.goals || '–'],
      ['Avg scored', t.avgScored != null ? round(t.avgScored) : '–'],
      ['Avg conceded', t.avgConceded != null ? round(t.avgConceded) : '–'],
      ['Win rate', t.winRate != null ? pct(t.winRate) : '–'],
      ['BTTS', t.bttsPct != null ? pct(t.bttsPct) : '–'],
      ['Clean sheets', t.cleanSheetPct != null ? pct(t.cleanSheetPct) : '–'],
      ['Over 2.5', t.over25Pct != null ? pct(t.over25Pct) : '–'],
    ];
    const streaks = t.streaks || {};
    const halves = Array.isArray(t.halftime) ? t.halftime : [];
    const recent = t.recent || [];
    const halfRows = (t.halves?.rows || []).filter((row) =>
      ['wins / draws / losses', 'goals', 'avg scored', 'avg conceded'].includes(
        String(row.label || '').toLowerCase()
      )
    );
    const pointsSeries = (t.pointsTrend || []).map((point) => point.points).filter((value) => Number.isFinite(value));
    return `<section class="dossier-card">
      <div class="dossier-head">
        ${t.key ? `<button type="button" class="linkish" data-team-link="${esc(t.key)}"><h4>${esc(t.name || fallback)}</h4></button>` : `<h4>${esc(t.name || fallback)}</h4>`}
        ${formBadges(t.form)}
      </div>
      ${t.available === false ? '<p class="muted">Vitibet stores no club profile for this team.</p>' : ''}
      <div class="kv-grid tight">${stats
        .map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`)
        .join('')}</div>
      <p class="mini-meta">Position, points and record come from the league table on Vitibet; scoring averages cover the team's full season profile.</p>
      ${streaks.longestWinStreak || streaks.longestUnbeatenRun || streaks.longestCleanSheetRun
        ? `<p class="mini-meta">Streaks: ${[
            streaks.longestWinStreak ? `win ${esc(streaks.longestWinStreak)}` : '',
            streaks.longestUnbeatenRun ? `unbeaten ${esc(streaks.longestUnbeatenRun)}` : '',
            streaks.longestCleanSheetRun ? `no goal ${esc(streaks.longestCleanSheetRun)}` : '',
          ]
            .filter(Boolean)
            .join(' · ')}</p>`
        : ''}
      ${halves.length
        ? `<div class="half-grid">${halves
            .map((box) => `<div class="half-box"><span>${esc(box.title || '')}</span><strong>${esc(box.value || '–')}</strong>${(box.notes || [])
              .map((note) => `<small>${esc(note)}</small>`)
              .join('')}</div>`)
            .join('')}</div>`
        : ''}
      ${halfRows.length
        ? `<div class="table-scroll"><table class="db-table compact"><thead><tr><th>Half split</th><th>1st half</th><th>2nd half</th></tr></thead><tbody>${halfRows
            .map((row) => `<tr><td>${esc(row.label)}</td><td>${esc(row['1st Half'] ?? '–')}</td><td>${esc(row['2nd Half'] ?? '–')}</td></tr>`)
            .join('')}</tbody></table></div>`
        : ''}
      ${pointsSeries.length ? `<p class="mini-meta">Points trend: ${pointsSeries.map((value) => esc(value)).join(' → ')}</p>` : ''}
      ${recent.length
        ? `<div class="recent-list">${recent
            .map((match) => `<div class="recent-row"><span>${esc(match.date || '–')}</span><span>${esc(match.venue || '')} ${esc(match.opponent || '')}</span><strong class="${match.result === 'W' ? 'good' : match.result === 'L' ? 'bad' : ''}">${esc(match.score || '–')}</strong></div>`)
            .join('')}</div>`
        : ''}
    </section>`;
  }

  function teamComparison(homeTeam, awayTeam) {
    const teams = [homeTeam || {}, awayTeam || {}];
    const name = (team, index) => team.name || (index === 0 ? 'Home team' : 'Away team');
    const form = (team) => formBadges(team.form) || '–';
    const record = (team) =>
      team.wins != null ? `${team.wins}-${team.draws}-${team.losses}` : '–';
    const goals = (team) => team.goals || '–';
    const avg = (value) => (value != null ? round(value) : '–');
    const percent = (value) => (value != null ? pct(value) : '–');
    const half = (team, label, side) => {
      const row = (team.halves?.rows || []).find(
        (item) => String(item.label || '').toLowerCase() === label
      );
      return row ? row[side] ?? '–' : '–';
    };
    const trend = (team) =>
      (team.pointsTrend || [])
        .map((point) => point.points)
        .filter((value) => Number.isFinite(value))
        .join(' → ') || '–';
    const streaks = (team) => {
      const s = team.streaks || {};
      return (
        [
          s.longestWinStreak ? `win ${s.longestWinStreak}` : '',
          s.longestUnbeatenRun ? `unbeaten ${s.longestUnbeatenRun}` : '',
          s.longestCleanSheetRun ? `no goal ${s.longestCleanSheetRun}` : '',
        ]
          .filter(Boolean)
          .join(' · ') || '–'
      );
    };
    const rows = [
      ['Position', (team) => team.position || '–'],
      ['Points', (team) => team.points ?? '–'],
      ['Played', (team) => team.played ?? '–'],
      ['Record', record],
      ['Goals', goals],
      ['Avg scored', (team) => avg(team.avgScored)],
      ['Avg conceded', (team) => avg(team.avgConceded)],
      ['Win rate', (team) => percent(team.winRate)],
      ['BTTS', (team) => percent(team.bttsPct)],
      ['Clean sheets', (team) => percent(team.cleanSheetPct)],
      ['Over 2.5', (team) => percent(team.over25Pct)],
      ['Streaks', streaks],
      ['1st-half W-D-L', (team) => half(team, 'wins / draws / losses', '1st Half')],
      ['2nd-half W-D-L', (team) => half(team, 'wins / draws / losses', '2nd Half')],
      ['1st-half goals', (team) => half(team, 'goals', '1st Half')],
      ['2nd-half goals', (team) => half(team, 'goals', '2nd Half')],
      ['Points trend', trend],
    ];
    const heads = teams
      .map((team, index) =>
        team.key
          ? `<th><button type="button" class="linkish" data-team-link="${esc(team.key)}">${esc(name(team, index))}</button></th>`
          : `<th>${esc(name(team, index))}</th>`
      )
      .join('');
    const body = rows
      .map(
        ([label, read]) =>
          `<tr><th>${esc(label)}</th><td>${esc(read(teams[0]))}</td><td>${esc(read(teams[1]))}</td></tr>`
      )
      .join('');
    const formRow = `<tr><th>Form</th><td>${form(teams[0])}</td><td>${form(teams[1])}</td></tr>`;
    const recentRows = teams
      .map((team, index) => {
        const matches = (team.recent || [])
          .map(
            (match) =>
              `<tr><td>${esc(match.date || '–')}</td><td>${esc(`${match.venue || ''} ${match.opponent || ''}`.trim() || '–')}</td><td>${esc(match.score || '–')}</td><td class="${match.result === 'W' ? 'good' : match.result === 'L' ? 'bad' : ''}">${esc(match.result || '–')}</td></tr>`
          )
          .join('');
        return matches
          ? `<tr class="section-row"><td colspan="4">${esc(name(team, index))}</td></tr>${matches}`
          : '';
      })
      .join('');
    return `<h4>Team comparison</h4>
      ${teams.some((team) => team.available === false) ? '<p class="rate-note">One or both clubs have no Vitibet profile.</p>' : ''}
      <div class="table-scroll"><table class="db-table comparison-table team-comparison">
        <thead><tr><th>Stat</th>${heads}</tr></thead>
        <tbody>${formRow}${body}</tbody>
      </table></div>
      <p class="rate-note">Position, points and record come from the league table; scoring averages cover each club's full season profile.</p>
      ${recentRows ? `<h4>Recent matches</h4><div class="table-scroll"><table class="db-table comparison-table"><thead><tr><th>Date</th><th>Opponent</th><th>Score</th><th>Result</th></tr></thead><tbody>${recentRows}</tbody></table></div>` : ''}`;
  }

  function renderFixture(fx, day) {
    const o = actualOutcome(fx);
    const calc = fx.calculated || {};
    const vitibet = fx.vitibet || {};
    const community = fx.community || {};
    const league = fx.league || {};
    const rates = league.rates || {};
    const model = vitibet.probabilities || {};
    const ours = calc.probabilities || {};
    const communityText =
      community.available && community.pct
        ? ['1', 'X', '2'].map((key) => `${key} ${pct(community.pct[key])}`).join(' · ')
        : community.totalPicks != null
          ? `${community.totalPicks} pick(s) · split needs a Vitibet sign-in`
          : community.reason || 'Not available.';

    const predictions = [
      ['Vitibet model', model['1'], model.X, model['2']],
      ['Our calculated', ours['1'], ours.X, ours['2']],
    ]
      .map(([label, a, b, c]) => `<tr><td>${esc(label)}</td><td>${pct(a)}</td><td>${pct(b)}</td><td>${pct(c)}</td></tr>`)
      .join('');

    const summary = [
      ['Actual 1X2', o ? o.result : '–'],
      ['Total goals', o ? o.total : '–'],
      ['Over / Under 2.5', o ? o.overUnder : '–'],
      ['BTTS', o ? o.btts : '–'],
      ['Best pick', calc.best ? `${calc.best.label} ${pct(calc.best.pct)} · ${fx.bestResult || 'not settled'}` : '–'],
      ['Vitibet tip', vitibet.published ? `${vitibet.tip || '–'} · index ${vitibet.index ?? '–'}` : 'no tip'],
      ['Our index', calc.index ?? '–'],
      ['Calculated form', calc.form ? `${calc.form.home} / ${calc.form.away}` : '–'],
      ['Team power', calc.power ? `${calc.power.home} / ${calc.power.away}` : '–'],
    ];

    const bars = (fx.bars || [])
      .map(
        (bar) => `<div class="bar-row"><div class="bar-meta"><span>${esc(bar.home ?? '–')}</span><em>${esc(bar.label)}</em><span>${esc(bar.away ?? '–')}</span></div><div class="bar-track"><i style="width:${Number(bar.homePct) || 50}%"></i></div></div>`
      )
      .join('');

    return `<div class="detail-head">
      <button class="btn tiny" type="button" data-back-day>← Back to day</button>
      <div>
        <h3>${esc(fx.home)} v ${esc(fx.away)}</h3>
        <p class="muted">${esc(day.date)} · ${esc(fx.leagueName || 'Competition')}
          ${fx.kickoff ? ` · ${esc(fx.kickoff)}` : ''} · ${esc(fx.status || '–')}
          ${fx.detailUrl ? ` · <a href="${esc(fx.detailUrl)}" target="_blank" rel="noreferrer noopener">Vitibet match</a>` : ''}</p>
      </div>
      <button class="btn tiny danger" type="button" data-delete-fixture="${esc(fx.fixtureId)}">Delete this match</button>
    </div>

    <div class="kv-grid">${summary
      .map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`)
      .join('')}</div>

    <div class="ml-inline" data-ml-slot="${esc(fx.fixtureId)}" data-ml-sport="${esc(day.sport || 'football')}" data-ml-date="${esc(day.date || '')}" data-ml-league="${esc(fx.leagueId || '')}"><p class="muted pad">Loading ML prediction…</p></div>

    ${fx.headerStats?.length
      ? `<h4>Scoreboard stats</h4><div class="table-scroll"><table class="db-table compact">
          <thead><tr><th>Stat</th><th>${esc(fx.home)}</th><th>${esc(fx.away)}</th></tr></thead>
          <tbody>${fx.headerStats
            .map((row) => `<tr><td>${esc(row.label)}</td><td>${esc(row.home)}</td><td>${esc(row.away)}</td></tr>`)
            .join('')}</tbody>
        </table></div>`
      : ''}

    <h4>Predictions &amp; community</h4>
    <div class="table-scroll"><table class="db-table compact">
      <thead><tr><th>Source</th><th>1</th><th>X</th><th>2</th></tr></thead>
      <tbody>${predictions}
        <tr><td>Community</td><td colspan="3">${esc(communityText)}</td></tr>
      </tbody>
    </table></div>

    ${teamComparison(fx.teamContext?.home, fx.teamContext?.away)}

    <h4>Competition context ${league.name ? `<span class="muted">${esc(league.name)}</span>` : ''}</h4>
    ${competitionTable(rates, league)}

    ${bars ? `<h4>Calculated form &amp; team power</h4><div class="bar-list">${bars}</div>` : ''}`;
  }

  function statsTable(table) {
    if (!table?.rows?.length) return '<p class="muted pad">No stats table published.</p>';
    const columns = ['Home', 'Away', 'Total'].filter((column) =>
      table.rows.some((row) => row[column])
    );
    if (!columns.length) return '<p class="muted pad">No stats table published.</p>';

    let lastSection = null;
    const rows = table.rows
      .map((row) => {
        const section = row.section !== lastSection
          ? `<tr class="section-row"><td colspan="${columns.length + 1}">${esc(row.section || '')}</td></tr>`
          : '';
        lastSection = row.section;
        return `${section}<tr>
          <td>${esc(row.label)}</td>
          ${columns.map((column) => `<td>${esc(row[column] ?? '–')}</td>`).join('')}
        </tr>`;
      })
      .join('');

    return `<div class="table-scroll"><table class="db-table">
      <thead><tr><th>Stat</th>${columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function renderTeam(team) {
    const profile = team.profile;
    const back = backButton('Back');

    if (!profile || profile.available === false) {
      return `<div class="detail-head">${back}<h3>${esc(team.name)}</h3></div>
        <p class="muted pad">${esc(profile?.note || team.note || 'No club profile was available for this team.')}
        ${team.url ? ` <a href="${esc(team.url)}" target="_blank" rel="noreferrer noopener">Vitibet page</a>` : ''}</p>`;
    }

    const summary = profile.summary || {};
    const highlights = (profile.highlights || [])
      .map((item) => `<div class="hl-card"><span>${esc(item.title)}</span><strong>${esc(item.value || '–')}</strong>${item.note ? `<i>${esc(item.note)}</i>` : ''}</div>`)
      .join('');

    const standings = (profile.standings || [])
      .map((table) => `<div class="mini-standing">
        <h5>${esc(table.label)}${table.position?.rank ? ` · position ${esc(table.position.rank)}` : ''}</h5>
        ${table.position
          ? `<p class="mono">${esc(table.position.team)} · P ${esc(table.position.played)} · W ${esc(table.position.wins)} · D ${esc(table.position.draws)} · L ${esc(table.position.losses)} · ${esc(table.position.goals)} · ${esc(table.position.points)} pts</p>`
          : '<p class="muted">Team row not found in this table.</p>'}
      </div>`)
      .join('');

    const recent = (profile.recentMatches || [])
      .map((match) => `<tr>
        <td>${esc(match.date || '–')}</td>
        <td>${esc(match.venue || '–')}</td>
        <td>${esc(match.opponent || '–')}</td>
        <td>${esc(match.score || '–')}</td>
        <td><span class="result-dot ${String(match.result || '').toLowerCase()}">${esc(match.result || '–')}</span></td>
      </tr>`)
      .join('');

    const corners = team.corners?.rows?.find((row) => norm(row.team) === norm(profile.name)) || null;

    return `<div class="detail-head">
      ${back}
      <div>
        <h3>${esc(profile.name || team.name)} ${profile.season ? `<span class="muted">${esc(profile.season)}</span>` : ''}</h3>
        <p class="muted">${esc(sportLabel(team.sport))} · ${esc(profile.matches ?? '–')} matches
          ${profile.teamId ? ` · team id ${esc(profile.teamId)}` : ''}
          ${team.url ? ` · <a href="${esc(team.url)}" target="_blank" rel="noreferrer noopener">Vitibet club profile</a>` : ''}</p>
      </div>
      <div class="detail-form">${formBadges(profile.form)}</div>
    </div>

    <div class="hl-grid">${highlights}</div>

    <div class="kv-grid">
      <div><span>Record (W-D-L)</span><strong>${summary.record ? `${summary.record.wins}-${summary.record.draws}-${summary.record.losses}` : '–'}</strong></div>
      <div><span>Goals for : against</span><strong>${summary.goals ? `${summary.goals.for} : ${summary.goals.against}` : '–'}</strong></div>
      <div><span>Avg scored / conceded</span><strong>${round(summary.avgScored)} / ${round(summary.avgConceded)}</strong></div>
      <div><span>BTTS</span><strong>${pct(summary.bttsPct)}</strong></div>
      <div><span>Over 2.5</span><strong>${pct(summary.over25Pct)}</strong></div>
      <div><span>Clean sheets</span><strong>${pct(summary.cleanSheetPct)}</strong></div>
    </div>

    <div class="detail-cols">
      <div>
        <h4>Season stats</h4>
        ${statsTable(profile.overall)}
      </div>
      <div>
        <h4>1st / 2nd half</h4>
        ${statsTable(profile.halves)}
        <h4>Standings rows</h4>
        ${standings || '<p class="muted pad">No standings table on the profile.</p>'}
        ${corners ? `<h4>Corners</h4><p class="mono">For ${esc(corners['for'])} · against ${esc(corners.against)} · per match ${esc(corners.match)} · over 9.5 ${esc(corners.over95Pct)}%</p>` : ''}
      </div>
    </div>

    <h4>Recent matches <span class="muted">from the club profile</span></h4>
    <div class="table-scroll"><table class="db-table">
      <thead><tr><th>Date</th><th>Venue</th><th>Opponent</th><th>Score</th><th>Result</th></tr></thead>
      <tbody>${recent || '<tr><td colspan="5" class="muted">No recent matches listed.</td></tr>'}</tbody>
    </table></div>

    <p class="muted source-line">Stored ${esc(dateLabel(team.updatedAt))} · dates: ${esc((team.sources || []).join(', ') || '–')}</p>`;
  }

  function standingsTable(table) {
    if (!table?.rows?.length) return '<p class="muted pad">No table stored.</p>';
    const columns = [
      ['rank', '#'],
      ['team', 'Team'],
      ['played', 'P'],
      ['wins', 'W'],
      ['draws', 'D'],
      ['losses', 'L'],
      ['goals', 'Goals'],
      ['points', 'Pts'],
      ['pct', '%'],
    ].filter(([field]) => field === 'team' || field === 'rank' || table.rows.some((row) => row[field]));
    const hasForm = table.rows.some((row) => row.form?.length);

    return `<div class="table-scroll"><table class="db-table">
      <thead><tr>${columns.map(([, label]) => `<th>${esc(label)}</th>`).join('')}${hasForm ? '<th>Form</th>' : ''}</tr></thead>
      <tbody>${table.rows
        .map((row) => `<tr>${columns
          .map(([field]) => `<td>${esc(row[field] ?? '–')}</td>`)
          .join('')}${hasForm ? `<td>${formBadges(row.form)}</td>` : ''}</tr>`)
        .join('')}</tbody>
    </table></div>`;
  }

  function renderCompetition(competition) {
    const unit = competition.sport === 'football' ? 'goals' : 'points';
    const tables = competition.tables || {};
    const order = [
      ['all', 'All'],
      ['home', 'Home'],
      ['away', 'Away'],
      ['firstHalf', '1st half'],
      ['secondHalf', '2nd half'],
      ['form', 'Form (last 6)'],
    ].filter(([key]) => tables[key]?.rows?.length);

    const tableTabs = order
      .map(([key, label], index) => `<button type="button" class="table-tab ${index === 0 ? 'active' : ''}" data-table-tab="${key}">${esc(label)}</button>`)
      .join('');
    const tablePanels = order
      .map(([key], index) => `<div data-table-panel="${key}" ${index === 0 ? '' : 'hidden'}>${standingsTable(tables[key])}</div>`)
      .join('');

    const overUnder = (competition.overUnder || [])
      .map((row) => `<tr><td>${esc(row.team)}</td><td>${esc(row.played ?? '–')}</td><td>${pct(row.overPct)}</td><td>${row.overCount ?? '–'}</td><td>${pct(row.underPct)}</td><td>${row.underCount ?? '–'}</td></tr>`)
      .join('');

    const distribution = (competition.goalDistribution || [])
      .map((row) => `<tr><td>${esc(row.team)}</td><td>${esc(row.played ?? '–')}</td><td>${round(row.average)}</td>${['0', '1', '2', '3', '4', '5', '6+'].map((bucket) => `<td>${esc(row.buckets?.[bucket] ?? '–')}</td>`).join('')}</tr>`)
      .join('');

    const scorers = (competition.topScorers || [])
      .map((row, index) => `<tr><td>${index + 1}</td><td>${esc(row.name || '–')}</td><td>${esc(row.team || '–')}</td><td>${esc(row.value || '–')}</td></tr>`)
      .join('');

    const trends = (competition.trends || [])
      .map((trend) => `<li>${esc(trend.text || `${trend.team || ''} ${trend.title || ''}`)}</li>`)
      .join('');

    const corners = competition.corners?.rows?.length
      ? `<h4>Corners <span class="muted">team stats</span></h4>
        <div class="table-scroll"><table class="db-table">
          <thead><tr><th>#</th><th>Team</th><th>P</th><th>For</th><th>Against</th><th>Per match</th><th>Over 9.5</th></tr></thead>
          <tbody>${competition.corners.rows
            .map((row) => `<tr><td>${esc(row.rank ?? '–')}</td><td>${esc(row.team)}</td><td>${esc(row.played ?? '–')}</td><td>${esc(row['for'] ?? '–')}</td><td>${esc(row.against ?? '–')}</td><td>${esc(row.match ?? '–')}</td><td>${pct(row.over95Pct)}</td></tr>`)
            .join('')}</tbody>
        </table></div>`
      : '';

    return `<div class="detail-head">
      ${backButton('Back')}
      <div>
        <h3>${esc(competition.name)}</h3>
        <p class="muted">${esc(sportLabel(competition.sport))} · league ${esc(competition.leagueId || '–')}
          ${competition.url ? ` · <a href="${esc(competition.url)}" target="_blank" rel="noreferrer noopener">Vitibet competition page</a>` : ''}</p>
      </div>
    </div>

    <div class="kv-grid">
      <div><span>League average ${esc(unit)}</span><strong>${competition.leagueAverageGoals != null ? round(competition.leagueAverageGoals) : '–'}</strong></div>
      <div><span>${unit === 'goals' ? 'Goals' : 'Points'} per game (standings)</span><strong>${competition.goalsPerGame != null ? round(competition.goalsPerGame) : '–'}</strong></div>
      <div><span>Teams in table</span><strong>${competition.tables?.all?.rows?.length ?? '–'}</strong></div>
      <div><span>Stored</span><strong>${esc(dateLabel(competition.updatedAt))}</strong></div>
    </div>

    ${order.length ? `<h4>Standings</h4>
      <div class="table-tabs" data-tables>${tableTabs}</div>
      ${tablePanels}` : '<p class="muted pad">No standings stored for this competition.</p>'}

    ${competition.groups?.length > 1
      ? `<h4>Group tables</h4>${competition.groups
          .map((group) => `<h5>${esc(group.label)}</h5>${standingsTable(group.table)}`)
          .join('')}`
      : ''}

    <div class="detail-cols">
      <div>
        <h4>Over / Under 2.5</h4>
        <div class="table-scroll"><table class="db-table">
          <thead><tr><th>Team</th><th>P</th><th>Over</th><th>#</th><th>Under</th><th>#</th></tr></thead>
          <tbody>${overUnder || '<tr><td colspan="6" class="muted">Not stored.</td></tr>'}</tbody>
        </table></div>
        ${corners}
      </div>
      <div>
        <h4>Goal distribution</h4>
        <div class="table-scroll"><table class="db-table">
          <thead><tr><th>Team</th><th>P</th><th>Avg</th>${['0', '1', '2', '3', '4', '5', '6+'].map((b) => `<th>${b}</th>`).join('')}</tr></thead>
          <tbody>${distribution || '<tr><td colspan="10" class="muted">Not stored.</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>

    <h4>Top scorers</h4>
    <div class="table-scroll"><table class="db-table">
      <thead><tr><th>#</th><th>Player</th><th>Team</th><th>Goals</th></tr></thead>
      <tbody>${scorers || '<tr><td colspan="4" class="muted">Not stored.</td></tr>'}</tbody>
    </table></div>

    ${trends ? `<h4>Trends</h4><ul class="trend-list">${trends}</ul>` : ''}
    <p class="muted source-line">Stored ${esc(dateLabel(competition.updatedAt))} · dates: ${esc((competition.sources || []).join(', ') || '–')}</p>`;
  }

  /* ---------------- ML training ---------------- */

  function renderMl(data) {
    const dataset = data.dataset || {};
    const model = data.model;
    const metrics = model?.metrics;
    const trained = Boolean(model);
    if (els.mlPill) {
      els.mlPill.textContent = trained ? 'Trained' : 'Not trained';
      els.mlPill.className = `pill ${trained ? 'ok' : 'muted'}`;
    }

    const metricRows = metrics
      ? [
          ['1X2 accuracy', `${metrics['1x2Accuracy']}%`],
          ['BTTS accuracy', `${metrics.bttsAccuracy}%`],
          ['Over / Under 2.5', `${metrics.over25Accuracy}%`],
          ['Total goals MAE', `${metrics.totalMae}`],
          ['Correct score top-1', `${metrics.correctScoreTop1}%`],
          ['Correct score top-3', `${metrics.correctScoreTop3}%`],
          ['Log loss', `${metrics.logLoss}`],
        ]
      : [];

    els.mlContent.innerHTML = `
      <div class="db-stats">
        <div class="db-stat"><span>Complete matches</span><strong>${dataset.matches ?? '–'}</strong></div>
        <div class="db-stat"><span>Dates covered</span><strong>${dataset.days ?? '–'}</strong></div>
        <div class="db-stat"><span>Features</span><strong>${dataset.features ?? '–'}</strong></div>
        <div class="db-stat"><span>Model</span><strong>${trained ? 'Trained' : 'Not yet'}</strong></div>
      </div>

      <div class="ml-actions">
        <button class="btn primary" id="mlTrain" type="button" ${(dataset.matches || 0) < 8 ? 'disabled' : ''}>${trained ? 'Retrain model' : 'Train model'}</button>
        <span class="muted">${trained ? `Last trained ${esc(dateLabel(model.trainedAt))} · ${model.samples} matches · ${model.metrics?.folds || 0}-fold CV` : 'The model learns only from complete stored matches.'}</span>
      </div>
      <div id="mlMessage"></div>

      <div class="detail-cols">
        <div>
          <h4>Targets</h4>
          <div class="table-scroll"><table class="db-table">
            <thead><tr><th>Market</th><th>Output</th></tr></thead>
            <tbody>
              <tr><td>1X2</td><td>Home / Draw / Away probabilities</td></tr>
              <tr><td>BTTS</td><td>Yes / No probability</td></tr>
              <tr><td>Total goals</td><td>Expected total</td></tr>
              <tr><td>Over / Under 2.5</td><td>Over / Under probability</td></tr>
              <tr><td>Correct score</td><td>Most likely scoreline from the goal layer</td></tr>
            </tbody>
          </table></div>
        </div>
        <div>
          <h4>Cross-validation</h4>
          ${metrics
            ? `<div class="table-scroll"><table class="db-table"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${metricRows
                .map(([label, value]) => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`)
                .join('')}</tbody></table></div>
              <p class="rate-note">${model.metrics?.folds || 0}-fold CV on ${model.samples} matches. Small samples make these numbers directional, not a guarantee.</p>`
            : '<p class="muted pad">Train the model to see cross-validated accuracy and goal error.</p>'}
        </div>
      </div>

      ${trained
        ? `<details class="ml-details"><summary>Architecture &amp; features</summary>
            <p class="rate-note">Input ${model.architecture?.input} → hidden ${(model.architecture?.hidden || []).join(' → ')} → 8 outputs (1X2 softmax, BTTS and O/U sigmoid, total and home/away goal regression), plus a Poisson scoreline layer. Calibration: temperature ${model.calibration?.temperature}, ${(100 * (model.calibration?.outputBlend || 0)).toFixed(0)}% network / ${(100 - 100 * (model.calibration?.outputBlend || 0)).toFixed(0)}% prior blend.</p>
            <p class="ml-features">${(data.featureNames || []).map((name) => `<code>${esc(name)}</code>`).join(' ')}</p>
          </details>`
        : ''}`;
  }

  async function loadMl() {
    if (!els.mlContent) return;
    els.mlContent.innerHTML = '<p class="muted pad">Loading training data…</p>';
    try {
      const res = await fetch('/api/ml', { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      renderMl(data);
    } catch (error) {
      els.mlContent.innerHTML = `<p class="proc-error">${esc(error.message || 'Could not load ML status.')}</p>`;
    }
  }

  els.mlContent?.addEventListener('click', async (event) => {
    const button = event.target.closest('#mlTrain');
    if (!button) return;
    button.disabled = true;
    button.textContent = 'Training…';
    const message = byId('mlMessage');
    if (message) message.innerHTML = '<p class="rate-note">Fitting the network and running cross-validation…</p>';
    try {
      const res = await fetch('/api/ml/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sport: 'football', epochs: 140 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Training failed (${res.status})`);
      await loadMl();
    } catch (error) {
      if (message) message.innerHTML = `<p class="proc-error">${esc(error.message || 'Training failed.')}</p>`;
      button.disabled = false;
      button.textContent = 'Train model';
    }
  });

  /* ---------------- boot ---------------- */

  setView('fixtures');
})();
