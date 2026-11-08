// Compatible with both CommonJS and ESM package settings on Node.js 24.
async function main() {
  const { execFileSync } = await import('node:child_process');
  const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  process.chdir(resolve(process.argv[1], '..'));
  if (existsSync('.env')) process.loadEnvFile('.env');
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  const browserTemp = mkdtempSync(resolve(tmpdir(), 'playwright-'));
  process.env.TMPDIR = browserTemp;
  process.once('exit', () => {
    try { rmSync(browserTemp, { recursive: true, force: true }); }
    catch { /* Temporary files can be removed when the container exits. */ }
  });
  const require = createRequire(pathToFileURL(resolve('start-wispbyte.js')));
  let installed = false;
  try { installed = require('playwright/package.json').version === '1.64.1'; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (!installed) {
    console.log('Installing Playwright 1.64.1 once...');
    execFileSync('npm', ['install', '--no-save', '--no-package-lock',
      '--no-audit', '--no-fund', 'playwright@1.64.1'], { stdio: 'inherit' });
  } else console.log('Reusing installed Playwright 1.64.1.');
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
  await import(pathToFileURL(resolve('run.mjs')).href);
}
main().catch((error) => {
  console.error(JSON.stringify({ time: new Date().toISOString(),
    stage: 'startup_failed', error: String(error.message) }));
  process.exitCode = 1;
});
