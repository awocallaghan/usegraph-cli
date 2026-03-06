/**
 * Dashboard browser-side e2e tests using Playwright headless Chromium.
 *
 * These tests verify that each dashboard page loads without runtime errors,
 * including errors from DuckDB WASM queries and Observable Framework reactive cells.
 *
 * Setup (one-time):
 *   npx playwright install chromium
 *
 * Run:
 *   pnpm test:dashboard
 *   node --test tests/dashboard-e2e.test.js
 *
 * Requirements:
 *   - dist/ must be built (pnpm build)
 *   - playwright devDep must be installed
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, createReadStream, existsSync, copyFileSync, renameSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { initHistoricalRepo } from './helpers/git.js';
import { ORG_HISTORY } from './fixtures/org-history.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST_CLI = resolve(ROOT, 'dist', 'index.js');
const DIST_DASHBOARD = resolve(ROOT, 'src', 'dashboard', 'dist');

const HISTORY_KEYS = [
  'apps/web-app',
  'apps/dashboard',
  'apps/docs',
  'apps/mobile',
  'packages/ui',
  'packages/utils',
];
const TARGET_PACKAGES = '@acme/ui,@acme/utils';

// Maximum ms from navigation to loading-indicator removal.
const DUCKDB_LOAD_BUDGET_MS = 15_000;

// ─── Temp USEGRAPH_HOME ───────────────────────────────────────────────────────

const USEGRAPH_HOME = mkdtempSync(join(tmpdir(), 'usegraph-dashboard-e2e-'));

// ─── MIME types for static server ────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.parquet': 'application/octet-stream',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// ─── Shared state ─────────────────────────────────────────────────────────────

let server;
let serverPort;
let browser;

// ─── Setup ───────────────────────────────────────────────────────────────────

// Work dirs: temp copies initialized with full git history (populated in before())
const WORK_PROJECTS = [];

before(async () => {
  // 0. Create temp work dirs and initialise full historical git repos
  const workRoot = join(USEGRAPH_HOME, 'work');
  for (const historyKey of HISTORY_KEYS) {
    const history = ORG_HISTORY[historyKey];
    const workDir = join(workRoot, historyKey);
    mkdirSync(workDir, { recursive: true });
    await initHistoricalRepo(workDir, history.commits, { remote: history.remote });
    WORK_PROJECTS.push(workDir);
  }

  // 1. Compile TypeScript CLI (needed for scan + build steps)
  const tscResult = spawnSync(
    'npx', ['tsc'],
    { encoding: 'utf-8', timeout: 60_000, cwd: ROOT },
  );
  if (tscResult.status !== 0) {
    throw new Error(`TypeScript build failed:\n${tscResult.stderr}\n${tscResult.stdout}`);
  }

  // 2. Scan fixture projects
  for (const workPath of WORK_PROJECTS) {
    const result = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', workPath, '--packages', TARGET_PACKAGES, '--since', '7m'],
      { env: { ...process.env, USEGRAPH_HOME }, encoding: 'utf-8', timeout: 60_000 },
    );
    if (result.status !== 0) {
      throw new Error(`Scan failed for ${workPath}:\n${(result.stderr || result.stdout || '').slice(0, 500)}`);
    }
  }

  // 3. Build parquet tables
  const buildResult = spawnSync(
    process.execPath,
    [DIST_CLI, 'build'],
    { env: { ...process.env, USEGRAPH_HOME }, encoding: 'utf-8', timeout: 60_000 },
  );
  if (buildResult.status !== 0) {
    throw new Error(`usegraph build failed:\n${(buildResult.stderr || buildResult.stdout || '').slice(0, 500)}`);
  }

  // 4. Build Observable Framework dashboard into src/dashboard/dist/
  //    Run from src/dashboard/ so that observablehq.config.js is picked up and
  //    the output stays in src/dashboard/dist/ (not the package root dist/).
  const obsBuild = spawnSync(
    'npx', ['observable', 'build'],
    { env: { ...process.env, USEGRAPH_HOME }, encoding: 'utf-8', timeout: 120_000, cwd: resolve(ROOT, 'src', 'dashboard') },
  );
  if (obsBuild.status !== 0) {
    throw new Error(`Observable build failed:\n${obsBuild.stderr}\n${obsBuild.stdout}`);
  }

  // 5. Start static file server on dist/
  await new Promise((resolveServer) => {
    server = createServer((req, res) => {
      // Normalise path: /foo → /foo.html, / → /index.html
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/' || urlPath === '') urlPath = '/index';
      const base = join(DIST_DASHBOARD, urlPath);

      // Try exact file, then .html, then index.html inside directory
      const candidates = [base, base + '.html', join(base, 'index.html')];
      const filePath = candidates.find(existsSync);

      if (!filePath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = extname(filePath) || '.html';
      const mime = MIME[ext] ?? 'application/octet-stream';
      const { size: fileSize } = statSync(filePath);

      // Support HTTP Range requests so DuckDB WASM can fetch parquet files
      // using efficient byte-range reads instead of falling back to full reads.
      const rangeHeader = req.headers['range'];
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end   = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        res.writeHead(206, {
          'Content-Type':  mime,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': end - start + 1,
        });
        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type':  mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': fileSize,
        });
        createReadStream(filePath).pipe(res);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolveServer();
    });
  });

  // 5. Launch headless browser
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  try { rmSync(USEGRAPH_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function checkPageForErrors(path, waitMs = 5000) {
  const url = `http://127.0.0.1:${serverPort}${path}`;
  const page = await browser.newPage();
  const errors = [];
  const warnings = [];

  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`[console.error] ${msg.text()}`);
    } else if (msg.type() === 'warning') {
      warnings.push(`[console.warn] ${msg.text()}`);
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for DuckDB WASM to initialise and reactive cells to settle
    await page.waitForTimeout(waitMs);
  } finally {
    await page.close();
  }

  return { errors, warnings };
}

/**
 * Navigate to a DuckDB-powered page, wait for the loading indicator to
 * disappear (meaning DuckDB finished its query), then return any JS errors,
 * warnings, timing logs, and total load time.
 *
 * @param {string} path  - URL path, e.g. '/component-explorer'
 * @param {string} loadingSelector - CSS selector for the element that must
 *   disappear once data has loaded. Defaults to the Observable error/loading
 *   placeholder rendered while a cell is pending.
 * @returns {{ errors: string[], warnings: string[], timings: string[], loadMs: number }}
 */
async function checkDuckDbPageLoads(path, loadingSelector = '.observablehq--loading') {
  const url = `http://127.0.0.1:${serverPort}${path}`;
  const page = await browser.newPage();
  const errors = [];
  const warnings = [];
  const timings = [];

  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      errors.push(`[console.error] ${text}`);
    } else if (msg.type() === 'warning') {
      warnings.push(`[console.warn] ${text}`);
    } else if (text.startsWith('[usegraph]')) {
      timings.push(text);
    }
  });

  const t0 = Date.now();
  let loadMs = -1;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait up to 30 s for the loading indicator to vanish.  If it never
    // disappears the page has stalled (e.g. DuckDB failed to initialise).
    try {
      await page.waitForSelector(loadingSelector, { state: 'detached', timeout: 30_000 });
      loadMs = Date.now() - t0;
    } catch {
      loadMs = Date.now() - t0;
      errors.push(`[timeout] Loading indicator never disappeared on ${path} after ${loadMs}ms — DuckDB may have stalled`);
    }
  } finally {
    await page.close();
  }

  return { errors, warnings, timings, loadMs };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
// One test per page — each visit checks errors, warnings, DuckDB load, and
// performance budget together, so every page is only loaded once.

test('index page: no errors or warnings', async () => {
  const { errors, warnings } = await checkPageForErrors('/index');
  assert.deepEqual(errors,   [], `Runtime errors on index:\n${errors.join('\n')}`);
  assert.deepEqual(warnings, [], `Console warnings on index:\n${warnings.join('\n')}`);
});

test('component-explorer page: no errors, no warnings, loads within budget', async () => {
  const { errors, warnings, timings, loadMs } = await checkDuckDbPageLoads('/component-explorer', '#comp-loading-indicator');
  const info = timings.length ? `\n  Timings: ${timings.join(' | ')}` : '';
  assert.deepEqual(errors,   [], `Errors on component-explorer:${info}\n${errors.join('\n')}`);
  assert.deepEqual(warnings, [], `Warnings on component-explorer:\n${warnings.join('\n')}`);
  assert.ok(loadMs <= DUCKDB_LOAD_BUDGET_MS, `component-explorer too slow: ${loadMs}ms > ${DUCKDB_LOAD_BUDGET_MS}ms${info}`);
});

test('function-explorer page: no errors, no warnings, loads within budget', async () => {
  const { errors, warnings, timings, loadMs } = await checkDuckDbPageLoads('/function-explorer', '#fn-loading-indicator');
  const info = timings.length ? `\n  Timings: ${timings.join(' | ')}` : '';
  assert.deepEqual(errors,   [], `Errors on function-explorer:${info}\n${errors.join('\n')}`);
  assert.deepEqual(warnings, [], `Warnings on function-explorer:\n${warnings.join('\n')}`);
  assert.ok(loadMs <= DUCKDB_LOAD_BUDGET_MS, `function-explorer too slow: ${loadMs}ms > ${DUCKDB_LOAD_BUDGET_MS}ms${info}`);
});

test('package-adoption page: no errors, no warnings, loads within budget', async () => {
  const { errors, warnings, timings, loadMs } = await checkDuckDbPageLoads('/package-adoption', '#pa-loading-indicator');
  const info = timings.length ? `\n  Timings: ${timings.join(' | ')}` : '';
  assert.deepEqual(errors,   [], `Errors on package-adoption:${info}\n${errors.join('\n')}`);
  assert.deepEqual(warnings, [], `Warnings on package-adoption:\n${warnings.join('\n')}`);
  assert.ok(loadMs <= DUCKDB_LOAD_BUDGET_MS, `package-adoption too slow: ${loadMs}ms > ${DUCKDB_LOAD_BUDGET_MS}ms${info}`);
});

test('project-detail page: no errors, no warnings, loads within budget', async () => {
  const { errors, warnings, timings, loadMs } = await checkDuckDbPageLoads('/project-detail', '#pd-loading-indicator');
  const info = timings.length ? `\n  Timings: ${timings.join(' | ')}` : '';
  assert.deepEqual(errors,   [], `Errors on project-detail:${info}\n${errors.join('\n')}`);
  assert.deepEqual(warnings, [], `Warnings on project-detail:\n${warnings.join('\n')}`);
  assert.ok(loadMs <= DUCKDB_LOAD_BUDGET_MS, `project-detail too slow: ${loadMs}ms > ${DUCKDB_LOAD_BUDGET_MS}ms${info}`);
});

test('project-detail and index pages load without errors when Parquet lacks code_at (backward compat)', async () => {  // Simulate an old Parquet file by rewriting project_snapshots.parquet without the code_at column.
  // We use the DuckDB Node API (already a dependency) to do this in-process.
  const duckdb = (await import('duckdb')).default;
  const snapshotsFile = join(USEGRAPH_HOME, 'built', 'project_snapshots.parquet');

  // Create a stripped copy (no code_at) as a temporary Parquet, then overwrite the real file.
  const tmpFile = join(tmpdir(), `usegraph-test-nocodeat-${Date.now()}.parquet`);
  const db = await new Promise((res, rej) => {
    const d = new duckdb.Database(':memory:', e => e ? rej(e) : res(d));
  });
  const conn = db.connect();
  const runVoid = (sql) => new Promise((res, rej) => conn.run(sql, e => e ? rej(e) : res()));
  const safe = (p) => p.replace(/'/g, "''");

  await runVoid(
    `COPY (SELECT * EXCLUDE (code_at) FROM read_parquet('${safe(snapshotsFile)}'))` +
    ` TO '${safe(tmpFile)}' (FORMAT PARQUET)`,
  );
  conn.close();
  await new Promise(res => db.close(() => res()));

  // Back up and overwrite the real file so the data loader sees the old format.
  const backupFile = snapshotsFile + '.bak';
  copyFileSync(snapshotsFile, backupFile);
  renameSync(tmpFile, snapshotsFile);

  try {
    // Re-run the observable build so the data loader migration runs.
    const rebuildResult = spawnSync(
      'npx', ['@observablehq/framework', 'build'],
      {
        env: { ...process.env, USEGRAPH_HOME },
        encoding: 'utf-8',
        timeout: 120_000,
        cwd: join(ROOT, 'src/dashboard'),
      },
    );
    if (rebuildResult.status !== 0) {
      throw new Error(`observable build failed:\n${rebuildResult.stderr?.slice(0, 500)}`);
    }
    // The static server already serves from DIST_DASHBOARD — no reassignment needed.

    const { errors: indexErrors } = await checkPageForErrors('/index');
    const { errors: detailErrors } = await checkPageForErrors('/project-detail');
    assert.deepEqual(
      [...indexErrors, ...detailErrors],
      [],
      `Runtime errors with legacy Parquet (no code_at):\n${[...indexErrors, ...detailErrors].join('\n')}`,
    );
  } finally {
    // Restore the original file.
    renameSync(backupFile, snapshotsFile);
  }
});
