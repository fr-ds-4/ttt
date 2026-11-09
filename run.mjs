import { randomInt } from 'node:crypto';
import { mkdirSync, appendFileSync, statSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const logPath = 'results/registration.jsonl';
let logBytes = 0;
let fileLogging = true;
try {
  mkdirSync('results', { recursive: true });
  try { logBytes = statSync(logPath).size; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
} catch (error) {
  fileLogging = false;
  console.error(JSON.stringify({ time: new Date().toISOString(),
    stage: 'file_log_disabled', error: String(error.message) }));
}

function record(entry) {
  const row = { time: new Date().toISOString(), ...entry };
  const line = JSON.stringify(row);
  console.log(line);
  if (!fileLogging) return;
  try {
    const bytes = Buffer.byteLength(line + '\n');
    if (logBytes + bytes > 2 * 1024 * 1024) {
      rmSync(logPath + '.1', { force: true });
      renameSync(logPath, logPath + '.1');
      logBytes = 0;
    }
    appendFileSync(logPath, line + '\n');
    logBytes += bytes;
  } catch (error) {
    fileLogging = false;
    console.error(JSON.stringify({ time: new Date().toISOString(),
      stage: 'file_log_disabled', error: String(error.message) }));
  }
}

function memorySnapshot() {
  const read = (path) => {
    try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
  };
  const mb = (value) => value !== null && /^\d+$/.test(value)
    ? Math.round(Number(value) / 1024 / 1024) : null;
  return {
    nodeMemoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    containerMemoryMB: mb(read('/sys/fs/cgroup/memory.current') ??
      read('/sys/fs/cgroup/memory/memory.usage_in_bytes')),
    containerLimitMB: mb(read('/sys/fs/cgroup/memory.max') ??
      read('/sys/fs/cgroup/memory/memory.limit_in_bytes')),
    memoryEvents: read('/sys/fs/cgroup/memory.events')
  };
}

let activeBrowser;
let stopSignal;
let shutdownTimer;
const abort = new AbortController();
function onSignal(signal) {
  if (stopSignal) return;
  stopSignal = signal;
  process.exitCode = signal === 'SIGTERM' ? 143 : 130;
  record({ stage: 'received_signal', signal, ...memorySnapshot() });
  abort.abort();
  shutdownTimer = setTimeout(() => process.exit(process.exitCode), 10000);
  shutdownTimer.unref();
  activeBrowser?.close({ reason: signal }).catch(() => {});
}
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

function setting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const issuedCodes = new Set();
function randomCode() {
  let code;
  do {
    const length = randomInt(5, 7);
    code = Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
  } while (issuedCodes.has(code));
  issuedCodes.add(code);
  // Deduplication covers the latest 10,000 codes, keeping memory bounded.
  if (issuedCodes.size > 10000) issuedCodes.delete(issuedCodes.values().next().value);
  return code;
}

async function run() {
  if (!process.env.TEST_URL) throw new Error('Set TEST_URL in the deployment environment variables.');
  const target = new URL(process.env.TEST_URL);
  if (target.protocol !== 'https:') throw new Error('TEST_URL must use HTTPS.');
  record({ stage: 'worker_started', pid: process.pid });
  const maxCases = setting('MAX_CASES', 1, 0, Number.MAX_SAFE_INTEGER);
  const runSeconds = setting('RUN_SECONDS', 360, 0, 3600);
  const deadline = runSeconds === 0 ? Infinity : Date.now() + runSeconds * 1000;
  const state = { responses: 0 };
  let recoveries = 0;
  const recoveryLimit = setting('MAX_BROWSER_RECOVERIES', 3, 0, 20);
  while (!stopSignal && Date.now() < deadline && (!maxCases || state.responses < maxCases)) {
    try {
      await runSession(target, state, maxCases || Infinity, deadline);
      break;
    } catch (error) {
      if (stopSignal || !error.recoverable) throw error;
      if (Date.now() >= deadline || (maxCases && state.responses >= maxCases)) break;
      if (recoveries >= recoveryLimit) throw new Error('Browser recovery limit reached: ' + error.message);
      const waitMs = Math.min(15000 * 2 ** recoveries, 60000, deadline - Date.now());
      recoveries++;
      record({ stage: 'browser_recovery', attempt: recoveries, waitSeconds: waitMs / 1000,
        responses: state.responses, error: String(error.message) });
      await delay(waitMs, undefined, { signal: abort.signal });
    }
  }
  record({ stage: 'summary', responses: state.responses,
    reason: stopSignal ? 'signal' : maxCases > 0 && state.responses >= maxCases
      ? 'case_limit' : 'time_limit' });
}

async function runSession(target, state, limit, deadline) {
  const browser = await chromium.launch({ timeout: 60000,
    handleSIGTERM: false, handleSIGINT: false });
  activeBrowser = browser;
  const heartbeat = setInterval(() => record({ stage: 'resources',
    ...memorySnapshot() }), 30000);
  heartbeat.unref();
  let context;
  let closing = false;
  browser.on('disconnected', () => record({ stage: 'browser_disconnected',
    expected: closing || Boolean(stopSignal), ...memorySnapshot() }));
  try {
    if (stopSignal) return;
    context = await browser.newContext({ reducedMotion: 'reduce' });
    // Block background audio/video, but preserve scripts, styles and images.
    await context.route('**/*', (route) => route.request().resourceType() === 'media'
      ? route.abort() : route.continue());
    const page = await context.newPage();
    page.on('crash', () => record({ stage: 'page_crashed', ...memorySnapshot() }));
    page.setDefaultTimeout(12000);
    record({ stage: 'opening_page' });
    let load;
    try {
      load = await page.goto(target.href, { waitUntil: 'commit', timeout: 60000 });
    } catch (error) {
      const networkError = error.message.match(/net::ERR_[A-Z_]+/)?.[0];
      const reason = error.name === 'TimeoutError' ? 'timeout after 60 seconds' : networkError ?? error.name;
      throw new Error(`Test page navigation failed before HTTP response: ${reason}.`);
    }
    const httpStatus = load?.status() ?? null;
    record({ stage: 'page_response', httpStatus });
    if (!load?.ok()) throw new Error(`Test page did not return a successful HTTP response: ${httpStatus ?? 'none'}.`);
    if (new URL(page.url()).origin !== target.origin) throw new Error('Test page redirected to another origin.');

    const profile = page.locator('#profileCode');
    try {
      await profile.waitFor({ state: 'visible', timeout: 30000 });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw new Error('Test page returned HTTP successfully, but #profileCode did not become visible within 30 seconds.');
    }
    record({ stage: 'form_ready' });

    const confirm = page.locator('#confirmDialog');
    const result = page.locator('#resultDialog');
    while (!stopSignal && Date.now() < deadline && state.responses < limit) {
      if (new URL(page.url()).origin !== target.origin) throw new Error('Test page changed origin.');
      const code = randomCode();
      let stage = 'fill';
      try {
        await profile.fill(code, { timeout: 45000 });
        stage = 'agree';
        await page.locator('#agreeCheck').check();
        stage = 'open_confirmation';
        await page.locator('#submitBtn').click();
        await confirm.waitFor({ state: 'visible' });
        const codes = (await confirm.innerText()).match(/[A-Za-z0-9]+/g) ?? [];
        if (!codes.includes(code)) throw new Error('Confirmation code did not match.');
        // Ensure an old dialog cannot be mistaken for this submission's result.
        await result.waitFor({ state: 'hidden' });
        stage = 'submit_attempted';
        try {
          // Observe the result dialog ourselves instead of waiting for navigation.
          await confirm.locator('#confirmSubmit').click({ noWaitAfter: true });
        } catch (error) {
          if (error.name !== 'TimeoutError' || stopSignal) throw error;
          record({ code, stage: 'submit_wait_warning', error: String(error.message) });
          // The click may already have happened. Never click it a second time.
        }
        stage = 'waiting_result';
        const dismiss = result.getByRole('button', { name: '確認', exact: true });
        try {
          await dismiss.waitFor({ state: 'visible', timeout: 60000 });
        } catch (error) {
          if (error.name !== 'TimeoutError' || stopSignal) throw error;
          throw new Error('Submission result unknown after 60 seconds; stopped without resubmitting.');
        }
        const message = (await result.innerText()).trim().replace(/\s*確認$/, '');
        record({ code, stage: 'response', message });
        state.responses++;
        if (!message || message === '預約結果確認' ||
            /captcha|too many requests|\b429\b|人機驗證|驗證碼|頻繁|稍後|系統異常|服務繁忙|暫時無法/i.test(message)) {
          throw new Error('Result needs review. Run stopped.');
        }
        stage = 'dismiss';
        await dismiss.click({ noWaitAfter: true });
        await result.waitFor({ state: 'hidden' });
      } catch (error) {
        if (stage === 'fill' && error.name === 'TimeoutError') {
          const fields = await profile.evaluateAll((elements) => elements.map((input) => {
            const style = getComputedStyle(input);
            const bounds = input.getBoundingClientRect();
            return {
              visible: style.visibility === 'visible' && bounds.width > 0 && bounds.height > 0,
              disabled: input.matches(':disabled') || Boolean(input.closest('[aria-disabled="true"]')),
              readOnly: input.readOnly || input.getAttribute('aria-readonly') === 'true',
              inert: Boolean(input.closest('[inert]')),
            };
          })).catch(() => null);
          record({ stage: 'field_state', fields });
        }
        record({ code, stage, error: String(error.message) });
        // Only restart before final submission, or after an accepted result was recorded.
        const transient = error.name === 'TimeoutError' ||
          /Target page, context or browser has been closed|Target crashed|Page crashed/i.test(error.message);
        error.recoverable = transient && ['fill', 'agree', 'open_confirmation', 'dismiss'].includes(stage);
        throw error;
      }
      if (!stopSignal && state.responses < limit && Date.now() < deadline) {
        await delay(Math.min(2000, deadline - Date.now()), undefined, { signal: abort.signal });
      }
    }
  } finally {
    clearInterval(heartbeat);
    closing = true;
    await context?.close().catch(() => {});
    await browser.close();
    activeBrowser = undefined;
  }
}

run().catch((error) => {
  record({ stage: 'stopped', signal: stopSignal ?? null, error: String(error.message) });
  if (!stopSignal) process.exitCode = 1;
}).finally(() => {
  clearTimeout(shutdownTimer);
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
});
