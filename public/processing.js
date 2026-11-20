/* Processing + Database tabs.
 *
 * Wrapped in an IIFE because app.js already declares its own top-level
 * `state`/`els` bindings in the same classic-script scope.
 */
(() => {
  const byId = (id) => document.getElementById(id);

  /* How much history is shown before the "Show all" toggle appears. */
  const RUNS_PREVIEW = 6;
  const DAYS_PREVIEW = 6;

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
    runsExpanded: false,
    daysExpanded: false,
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
      // A date is often processed more than once, which turns the history into
      // a list of attempts. Keep the newest run per date + sport + mode and
      // fold the rest into a count.
      const newest = new Map();
      const attempts = new Map();
      for (const job of jobs) {
        const key = `${job.mode || 'database'}|${job.sport}|${job.date}`;
        attempts.set(key, (attempts.get(key) || 0) + 1);
        if (!newest.has(key)) newest.set(key, job);
      }
      const runs = [...newest.values()];
      const shown = state.runsExpanded ? runs : runs.slice(0, RUNS_PREVIEW);
      const toggle =
        runs.length > RUNS_PREVIEW
          ? `<button class="btn tiny" type="button" style="justify-self:start;margin-top:3px" data-more-runs>${
              state.runsExpanded ? 'Show fewer runs' : `Show all ${runs.length} dates`
            }</button>`
          : '';
      els.procRuns.innerHTML = shown
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
              ${(attempts.get(`${job.mode || 'database'}|${job.sport}|${job.date}`) || 1) > 1
                ? ` · ${attempts.get(`${job.mode || 'database'}|${job.sport}|${job.date}`)} runs, latest shown`
                : ''}
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
        .join('') + toggle;
    } catch {
      els.procRuns.innerHTML = '<p class="muted pad">Could not read processing history.</p>';
    }
  }

  els.procRuns.addEventListener('click', (event) => {
    if (event.target.closest('[data-more-runs]')) {
      state.runsExpanded = !state.runsExpanded;
      loadRuns();
      return;
    }
    const button = event.target.closest('[data-open-day]');
    if (button) openDay(button.dataset.openDay, { jump: true });
  });
