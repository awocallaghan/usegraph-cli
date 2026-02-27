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
import { mkdtempSync, rmSync, createReadStream, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST_CLI = resolve(ROOT, 'dist', 'index.js');
const DIST_DASHBOARD = resolve(ROOT, 'src', 'dashboard', 'dist');

const FIXTURES_ROOT = resolve(__dirname, 'fixtures/org');
const FIXTURE_PROJECTS = [
  join(FIXTURES_ROOT, 'apps/web-app'),
  join(FIXTURES_ROOT, 'apps/dashboard'),
  join(FIXTURES_ROOT, 'apps/docs'),
  join(FIXTURES_ROOT, 'apps/mobile'),
  join(FIXTURES_ROOT, 'packages/ui'),
  join(FIXTURES_ROOT, 'packages/utils'),
];
const TARGET_PACKAGES = '@acme/ui,@acme/utils';

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

before(async () => {
  // 1. Compile TypeScript CLI (needed for scan + build steps)
  const tscResult = spawnSync(
    'npx', ['tsc'],
    { encoding: 'utf-8', timeout: 60_000, cwd: ROOT },
  );
  if (tscResult.status !== 0) {
    throw new Error(`TypeScript build failed:\n${tscResult.stderr}\n${tscResult.stdout}`);
  }

  // 2. Scan fixture projects
  for (const projectPath of FIXTURE_PROJECTS) {
    const result = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', projectPath, '--packages', TARGET_PACKAGES],
      { env: { ...process.env, USEGRAPH_HOME }, encoding: 'utf-8', timeout: 60_000 },
    );
    if (result.status !== 0) {
      throw new Error(`Scan failed for ${projectPath}:\n${(result.stderr || result.stdout || '').slice(0, 500)}`);
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
      res.writeHead(200, { 'Content-Type': mime });
      createReadStream(filePath).pipe(res);
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

  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`[console.error] ${msg.text()}`);
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for DuckDB WASM to initialise and reactive cells to settle
    await page.waitForTimeout(waitMs);
  } finally {
    await page.close();
  }

  return errors;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('dashboard index page loads without runtime errors', async () => {
  const errors = await checkPageForErrors('/index');
  assert.deepEqual(errors, [], `Runtime errors on index page:\n${errors.join('\n')}`);
});

test('project-detail page loads without runtime errors', async () => {
  const errors = await checkPageForErrors('/project-detail');
  assert.deepEqual(errors, [], `Runtime errors on project-detail page:\n${errors.join('\n')}`);
});

test('component-explorer page loads without runtime errors', async () => {
  const errors = await checkPageForErrors('/component-explorer');
  assert.deepEqual(errors, [], `Runtime errors on component-explorer page:\n${errors.join('\n')}`);
});

test('function-explorer page loads without runtime errors', async () => {
  const errors = await checkPageForErrors('/function-explorer');
  assert.deepEqual(errors, [], `Runtime errors on function-explorer page:\n${errors.join('\n')}`);
});
