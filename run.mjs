import { randomInt } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const logPath = 'results/registration.jsonl';
mkdirSync('results', { recursive: true });
writeFileSync(logPath, '');

function record(entry) {
  const row = { time: new Date().toISOString(), ...entry };
  appendFileSync(logPath, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}

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
  return code;
}

async function run() {
  if (!process.env.TEST_URL) throw new Error('Set TEST_URL in CircleCI Project Settings.');
  const target = new URL(process.env.TEST_URL);
  if (target.protocol !== 'https:') throw new Error('TEST_URL must use HTTPS.');

  const maxCases = setting('MAX_CASES', 1, 0, Number.MAX_SAFE_INTEGER);
  const runSeconds = setting('RUN_SECONDS', 360, 0, 3600);
  const deadline = runSeconds === 0 ? Infinity : Date.now() + runSeconds * 1000;
  const browser = await chromium.launch({ timeout: 15000 });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    const load = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!load?.ok() || new URL(page.url()).origin !== target.origin) {
      throw new Error('Test page failed to load or redirected to another origin.');
    }

    const confirm = page.locator('#confirmDialog');
    const result = page.locator('#resultDialog');
    let count = 0;
    while (Date.now() < deadline && (maxCases === 0 || count < maxCases)) {
      if (new URL(page.url()).origin !== target.origin) throw new Error('Test page changed origin.');
      const code = randomCode();
      let stage = 'fill';
      try {
        await page.locator('#profileCode').fill(code);
        await page.locator('#agreeCheck').check();
        await page.locator('#submitBtn').click();
        await confirm.waitFor({ state: 'visible' });
        const codes = (await confirm.innerText()).match(/[A-Za-z0-9]+/g) ?? [];
        if (!codes.includes(code)) throw new Error('Confirmation code did not match.');
        stage = 'submit_attempted';
        await confirm.locator('#confirmSubmit').click();
        const dismiss = result.getByRole('button', { name: '確認', exact: true });
        await dismiss.waitFor({ state: 'visible' });
        const message = (await result.innerText()).trim().replace(/\s*確認$/, '');
        record({ code, stage: 'response', message });
        count++;
        stage = 'dismiss';
        await dismiss.click();
        await result.waitFor({ state: 'hidden' });

        if (!message || message === '預約結果確認' ||
            /captcha|too many requests|\b429\b|人機驗證|驗證碼|頻繁|稍後|系統異常|服務繁忙|暫時無法/i.test(message)) {
          throw new Error('Result needs review. Batch stopped.');
        }
      } catch (error) {
        record({ code, stage, error: String(error.message) });
        throw error;
      }
      if (maxCases === 0 || count < maxCases) await delay(2000);
    }
    record({
      stage: 'summary',
      responses: count,
      reason: maxCases > 0 && count >= maxCases ? 'case_limit' : 'time_limit',
    });
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  record({ stage: 'stopped', error: String(error.message) });
  process.exitCode = 1;
});
