/**
 * HTTP helper for Vitibet.
 *
 * The site hands out a PHP session cookie on the first page load and only
 * renders the advanced team-stat fragments (#vst-odpoved) for requests that
 * carry it. One anonymous session is enough for the whole app, so the jar
 * below is shared by every scrape.
 *
 * Scraping is deliberately slow and forgiving so a processing run does not get
 * the app blocked:
 *
 *   - one shared queue caps concurrency and spaces request starts apart
 *   - browser headers are sent as a consistent set, not mixed per request
 *   - retries back off exponentially and honour Retry-After
 *   - 403/429/503 and known \"block page\" bodies pause the whole queue, so the
 *     run slows down instead of piling on and getting the IP banned
 */

export const SITE = 'https://www.vitibet.com';

const UA_PROFILES = [
  { version: '131', os: 'Windows NT 10.0; Win64; x64', platform: '\"Windows\"' },
  { version: '130', os: 'Windows NT 10.0; Win64; x64', platform: '\"Windows\"' },
  { version: '129', os: 'Macintosh; Intel Mac OS X 10_15_7', platform: '\"macOS\"' },
  { version: '128', os: 'Windows NT 10.0; Win64; x64', platform: '\"Windows\"' },
];

// Only phrases a challenge/interstitial actually contains. A short body is not
// evidence of a block: the community endpoint answers with a few bytes of JSON.
const BLOCK_MARKERS = [
  'just a moment',
  'attention required',
  'cf-browser-verification',
  'enable javascript and cookies',
  'checking your browser',
  'too many requests',
  'you have been blocked',
];

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const MAX_CONCURRENT = clamp(Number(process.env.SCRAPE_CONCURRENCY || 4) || 4, 1, 8);
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.SCRAPE_MIN_INTERVAL_MS ?? 250) || 0);
const MAX_INTERVAL_MS = Math.max(MIN_INTERVAL_MS, 2000);
const MAX_RETRIES = clamp(Number(process.env.SCRAPE_RETRIES ?? 3) || 0, 0, 6);
const MAX_COOLDOWN_MS = Math.max(5000, Number(process.env.SCRAPE_MAX_COOLDOWN_MS || 45000) || 45000);

const jar = new Map();

let uaIndex = Math.floor(Math.random() * UA_PROFILES.length);
let active = 0;
let lastStartedAt = 0;
let cooldownUntil = 0;
let intervalMs = MIN_INTERVAL_MS;
let concurrencyLimit = MAX_CONCURRENT;
let successStreak = 0;
const waiters = [];

const counters = { requests: 0, retries: 0, blocked: 0, degraded: 0, failures: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spread requests out instead of firing them on a fixed beat. */
const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

function rememberCookies(response) {
  const list =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function currentProfile() {
  return UA_PROFILES[uaIndex % UA_PROFILES.length];
}

function userAgent(profile = currentProfile()) {
  return `Mozilla/5.0 (${profile.os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${profile.version}.0.0.0 Safari/537.36`;
}

/** Rotate the client fingerprint; only done between attempts, never per request. */
function rotateUserAgent() {
  uaIndex = (uaIndex + 1) % UA_PROFILES.length;
}

function buildHeaders(referer) {
  const profile = currentProfile();
  const headers = {
    'User-Agent': userAgent(profile),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-CH-UA': `\"Not?A_Brand\";v=\"99\", \"Google Chrome\";v=\"${profile.version}\", \"Chromium\";v=\"${profile.version}\"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': profile.platform,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
  };
  if (referer) headers.Referer = referer;
  const cookies = cookieHeader();
  if (cookies) headers.Cookie = cookies;
  return headers;
}

/**
 * One shared slot queue. Every request waits for a free slot, then for the
 * minimum gap since the previous request, then for any block cooldown.
 */
/**
 * Serialised start gate. Measuring the gap from the previous *actual* start,
 * one request at a time, is what keeps requests spaced out; computing it
 * independently in each waiter let several leave together in a burst.
 */
let startGate = Promise.resolve();

function paceStart() {
  const next = startGate.then(async () => {
    const cooling = cooldownUntil - Date.now();
    if (cooling > 0) await sleep(Math.min(cooling, MAX_COOLDOWN_MS));
    const pause = lastStartedAt + jitter(intervalMs) - Date.now();
    if (pause > 0) await sleep(pause);
    lastStartedAt = Date.now();
  });
  startGate = next.catch(() => {});
  return next;
}

async function acquire() {
  let handedOver = false;
  if (active >= concurrencyLimit || waiters.length) {
    await new Promise((resolve) =>
      waiters.push(() => {
        handedOver = true;
        resolve();
      })
    );
  }
  // A woken waiter takes over the releaser's slot, so it must not add a second
  // one; doing so let more requests run than the cap allowed.
  if (!handedOver) active += 1;

  await paceStart();

  return () => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };
}

function looksBlocked(body) {
  if (!body) return false;
  const head = body.slice(0, 2048).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return false;
  const lowered = head.toLowerCase();
  return BLOCK_MARKERS.some((marker) => lowered.includes(marker));
}

function backoffDelay(attempt, error) {
  if (Number.isFinite(error?.retryAfterMs)) {
    return clamp(error.retryAfterMs, 1000, MAX_COOLDOWN_MS);
  }
  return clamp(jitter(700 * 2 ** attempt), 700, 30000);
}

async function fetchOnce(url, { referer = null, timeout = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: buildHeaders(referer),
      redirect: 'follow',
    });
    rememberCookies(res);
    if (!res.ok) {
      const error = new Error(`Vitibet responded ${res.status}`);
      error.status = res.status;
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        error.retryAfterMs = retryAfter * 1000;
      }
      throw error;
    }
    return await res.text();
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Vitibet request timed out');
      timeoutError.timeout = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a page as text with politeness limits and retries. Callers get the
 * same signature as before; the queueing, spacing and backoff happen here.
 */
export async function getHtml(url, { referer = null, timeout = 25000, retries = MAX_RETRIES } = {}) {
  let lastError = null;
  let blocks = 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const release = await acquire();
    try {
      counters.requests += 1;
      const html = await fetchOnce(url, { referer, timeout });
      if (!html || !html.trim()) throw new Error('Vitibet returned an empty response');
      if (looksBlocked(html)) {
        const blocked = new Error('Vitibet returned a challenge page instead of the fixture data');
        blocked.blocked = true;
        throw blocked;
      }
      // Ease back towards the normal pace only after a run of clean responses.
      successStreak += 1;
      if (successStreak >= 20) {
        if (intervalMs > MIN_INTERVAL_MS) {
          intervalMs = Math.max(MIN_INTERVAL_MS, Math.round(intervalMs * 0.9));
        }
        if (concurrencyLimit < MAX_CONCURRENT) concurrencyLimit += 1;
        successStreak = 0;
      }
      return html;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status) || null;
      const blocked = Boolean(error?.blocked) || status === 403 || status === 429 || status === 503;

      if (blocked) {
        blocks += 1;
        counters.blocked += 1;
        rotateUserAgent();
        // Treat a block as a signal to slow the whole run down, permanently for
        // this process (until clean traffic earns some speed back).
        intervalMs = Math.min(MAX_INTERVAL_MS, Math.round(intervalMs * 1.6));
        concurrencyLimit = 1;
        successStreak = 0;
        console.warn(
          `[scrape] ${status ? `HTTP ${status}` : 'challenge page'} from Vitibet; spacing requests ${intervalMs}ms apart.`
        );
        // Pause every queued request; repeated blocks pause for longer.
        const cooldown = clamp(jitter(8000 * 2 ** (blocks - 1)), 5000, MAX_COOLDOWN_MS);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldown);
        lastError = new Error(
          `Vitibet is throttling or blocking requests (${status ? `HTTP ${status}` : 'challenge page'}). ` +
            `Backing off for ${Math.round(cooldown / 1000)}s before trying again.`
        );
        lastError.status = status;
        lastError.blocked = true;
        lastError.cooldownMs = cooldown;
      }

      if (attempt < retries) {
        counters.retries += 1;
        await sleep(backoffDelay(attempt, error));
      } else {
        counters.failures += 1;
      }
    } finally {
      release();
    }
  }

  throw lastError || new Error('Vitibet request failed');
}

/** Diagnostics for /api/health. */
export function stats() {
  return {
    concurrency: concurrencyLimit,
    maxConcurrency: MAX_CONCURRENT,
    minIntervalMs: MIN_INTERVAL_MS,
    intervalMs,
    active,
    queued: waiters.length,
    cooldownMs: Math.max(0, cooldownUntil - Date.now()),
    cookies: jar.size,
    ...counters,
  };
}

export function absolute(url) {
  if (!url) return null;
  try {
    return new URL(url, SITE).toString();
  } catch {
    return null;
  }
}
