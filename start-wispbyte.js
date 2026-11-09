// Compatible with both CommonJS and ESM package settings on Node.js 24.
async function superviseWorker() {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { constants, tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setTimeout: delay } = await import('node:timers/promises');
  // Restart only an unlimited run. Restarting a finite run would reset its limits.
  const continuous = Number(process.env.MAX_CASES ?? 1) === 0 &&
    Number(process.env.RUN_SECONDS ?? 360) === 0;
  const stopCodes = new Set([0, 78, 130, 143]); // Finished, needs attention, SIGINT, SIGTERM.
  const shutdown = new AbortController();
  let worker;
  let forceKillTimer;

  function stop(signal) {
    if (shutdown.signal.aborted) return;
    process.exitCode = 128 + constants.signals[signal];
    shutdown.abort();
    if (worker) {
      const runningWorker = worker;
      runningWorker.kill(signal);
      forceKillTimer = setTimeout(() => runningWorker.kill('SIGKILL'), 12000);
      forceKillTimer.unref();
    }
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    let waitMs = 15000;
    while (!shutdown.signal.aborted) {
      const browserTemp = mkdtempSync(join(tmpdir(), 'playwright-'));
      let exitCode;
      let signal;
      try {
        worker = spawn(process.execPath, ['run.mjs'], {
          stdio: 'inherit',
          env: { ...process.env, TMPDIR: browserTemp },
        });
        [exitCode, signal] = await once(worker, 'close');
      } finally {
        clearTimeout(forceKillTimer);
        worker = undefined;
        try { rmSync(browserTemp, { recursive: true, force: true }); }
        catch { /* The host may remove temporary files when the container exits. */ }
      }

      if (shutdown.signal.aborted) return;
      const status = exitCode ?? (128 + constants.signals[signal]);
      if (!continuous || stopCodes.has(status)) {
        process.exitCode = status;
        return;
      }

      console.log(JSON.stringify({ time: new Date().toISOString(),
        stage: 'worker_restart', exitCode, signal, waitSeconds: waitMs / 1000 }));
      await delay(waitMs, undefined, { signal: shutdown.signal });
      waitMs = Math.min(waitMs * 2, 60000);
    }
  } catch (error) {
    if (!shutdown.signal.aborted || error.name !== 'AbortError') throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function main() {
  const { execFileSync } = await import('node:child_process');
  const { existsSync, readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  process.chdir(resolve(process.argv[1], '..'));
  if (existsSync('.env')) process.loadEnvFile('.env');
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  const require = createRequire(pathToFileURL(resolve('start-wispbyte.js')));
  let installed = false;
  try { installed = require('playwright/package.json').version === '1.64.1'; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (!installed) {
    console.log('Installing Playwright 1.64.1 once...');
    execFileSync('npm', ['install', '--no-save', '--no-package-lock',
      '--no-audit', '--no-fund', 'playwright@1.64.1'], { stdio: 'inherit' });
  } else console.log('Reusing installed Playwright 1.64.1.');
  if (process.env.SKIP_BROWSER_INSTALL !== '1') {
    // Resolve the public package.json, then use its declared executable.
    // The ./cli subpath is not exported by Playwright.
    const packagePath = require.resolve('playwright/package.json');
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
    const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.playwright;
    if (!bin) throw new Error('Installed Playwright does not declare its CLI executable.');
    const cliPath = resolve(packagePath, '..', bin);
    if (!existsSync(cliPath)) throw new Error('Installed Playwright CLI executable is missing.');
    // Checks for the matching headless browser; downloads only if absent.
    execFileSync(process.execPath, [cliPath,
      'install', '--only-shell', 'chromium'], { stdio: 'inherit' });
  } else console.log('Using browser installed during Docker build.');
  await superviseWorker();
}
main().catch((error) => {
  console.error(JSON.stringify({ time: new Date().toISOString(),
    stage: 'startup_failed', error: String(error.message) }));
  process.exitCode = 1;
});
