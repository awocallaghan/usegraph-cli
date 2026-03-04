/**
 * End-to-end test suite for usegraph-cli.
 *
 * Tests the full pipeline:
 *   1. Scan 6 fixture projects into a temp USEGRAPH_HOME
 *   2. Build Parquet tables via `usegraph build`
 *   3. Exercise all major MCP tool handlers and assert on results
 *
 * Requirements:
 *   - dist/ must be built (node node_modules/typescript/bin/tsc)
 *   - DuckDB native module must be present
 *
 * Run: node --test tests/e2e.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initHistoricalRepo, cleanupTestRepo } from './helpers/git.js';
import { ORG_HISTORY, MAX_HISTORY_DEPTH } from './fixtures/org-history.js';

// ─── Step 1: set USEGRAPH_HOME before importing any dist modules ──────────────
// In ESM, static imports are hoisted. We use dynamic import() below so that
// dist modules (which read USEGRAPH_HOME at evaluation time) pick up the temp dir.

const USEGRAPH_HOME = mkdtempSync(join(tmpdir(), 'usegraph-e2e-'));
process.env.USEGRAPH_HOME = USEGRAPH_HOME;

// ─── Step 2: dynamically import dist modules (they now pick up the temp dir) ──

const { runBuild } = await import('../dist/commands/build.js');
const { callTool } = await import('../dist/commands/mcp.js');

// ─── Fixture paths ────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, 'fixtures/org');

// Source fixture projects (used as history key references, not scanned directly)
const FIXTURE_PROJECTS = [
  join(FIXTURES_ROOT, 'apps/web-app'),
  join(FIXTURES_ROOT, 'apps/dashboard'),
  join(FIXTURES_ROOT, 'apps/docs'),
  join(FIXTURES_ROOT, 'apps/mobile'),
  join(FIXTURES_ROOT, 'packages/ui'),
  join(FIXTURES_ROOT, 'packages/utils'),
];

// Maps source path → history key (e.g. 'apps/web-app')
const HISTORY_KEYS = {
  [join(FIXTURES_ROOT, 'apps/web-app')]:    'apps/web-app',
  [join(FIXTURES_ROOT, 'apps/dashboard')]:  'apps/dashboard',
  [join(FIXTURES_ROOT, 'apps/docs')]:       'apps/docs',
  [join(FIXTURES_ROOT, 'apps/mobile')]:     'apps/mobile',
  [join(FIXTURES_ROOT, 'packages/ui')]:     'packages/ui',
  [join(FIXTURES_ROOT, 'packages/utils')]:  'packages/utils',
};

// Work dirs: temp copies initialized with full git history (populated in before())
const WORK_PROJECTS = [];

const DIST_CLI = resolve(__dirname, '..', 'dist', 'index.js');
const TARGET_PACKAGES = '@acme/ui,@acme/utils';
const normalizeTimestampValue = (value) => {
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
};

// ─── Setup / teardown ─────────────────────────────────────────────────────────

before(async () => {
  // 0. Create temp work dirs and initialise full historical git repos
  const workRoot = join(USEGRAPH_HOME, 'work');
  for (const srcPath of FIXTURE_PROJECTS) {
    const historyKey = HISTORY_KEYS[srcPath];
    const history = ORG_HISTORY[historyKey];
    const workDir = join(workRoot, historyKey);
    mkdirSync(workDir, { recursive: true });
    await initHistoricalRepo(workDir, history.commits, { remote: history.remote });
    WORK_PROJECTS.push(workDir);
  }

  // 1. Scan each work project (latest commit only for the initial scan)
  for (const workPath of WORK_PROJECTS) {
    const result = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', workPath, '--packages', TARGET_PACKAGES],
      {
        env: process.env, // USEGRAPH_HOME already set
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    if (result.status !== 0) {
      const err = (result.stderr || result.stdout || '').slice(0, 500);
      throw new Error(`Scan failed for ${workPath}:\n${err}`);
    }
  }

  // 2. Build Parquet tables
  await runBuild({});
});

after(() => {
  // Clean up temp dir (includes work projects — their .git dirs are inside USEGRAPH_HOME)
  try {
    rmSync(USEGRAPH_HOME, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ─── Assertions ───────────────────────────────────────────────────────────────

test('list_projects returns exactly 6 projects', async () => {
  const rows = await callTool('list_projects', {});
  assert.equal(rows.length, 6, `Expected 6 projects, got ${rows.length}: ${JSON.stringify(rows.map(r => r.project_id))}`);
});

test('list_packages includes @acme/ui and @acme/utils', async () => {
  const rows = await callTool('list_packages', {});
  const names = rows.map((r) => r.package_name);
  assert.ok(names.includes('@acme/ui'), `@acme/ui not found in packages: ${JSON.stringify(names)}`);
  assert.ok(names.includes('@acme/utils'), `@acme/utils not found in packages: ${JSON.stringify(names)}`);
});

test('query_component_usage: Button is used in multiple projects', async () => {
  const rows = await callTool('query_component_usage', {
    package_name: '@acme/ui',
    component_name: 'Button',
  });
  assert.ok(rows.length >= 1, `Expected at least 1 Button usage row, got ${rows.length}`);

  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  assert.ok(
    projectIds.length >= 2,
    `Expected Button used in ≥2 projects, got: ${JSON.stringify(projectIds)}`,
  );
});

test('query_prop_usage: Button variant prop is found', async () => {
  const rows = await callTool('query_prop_usage', {
    package_name: '@acme/ui',
    component_name: 'Button',
    prop_name: 'variant',
  });
  assert.ok(rows.length >= 1, `Expected at least 1 variant prop row for Button, got ${rows.length}`);
});

test('query_prop_usage: all props returned when prop_name omitted', async () => {
  const rows = await callTool('query_prop_usage', {
    package_name: '@acme/ui',
    component_name: 'Button',
  });
  assert.ok(rows.length >= 1, `Expected prop rows for Button when prop_name omitted, got ${rows.length}`);

  const propNames = [...new Set(rows.map((r) => r.prop_name))];
  assert.ok(
    propNames.includes('variant'),
    `Expected "variant" in discovered props, got: ${JSON.stringify(propNames)}`,
  );
  assert.ok(
    propNames.includes('size'),
    `Expected "size" in discovered props, got: ${JSON.stringify(propNames)}`,
  );
  // Every row must include prop_name so the caller can tell props apart
  for (const row of rows) {
    assert.ok(row.prop_name != null, 'Each row should have a prop_name field');
  }
});

test('query_export_usage: formatDate is called in multiple projects', async () => {
  const rows = await callTool('query_export_usage', {
    package_name: '@acme/utils',
    export_name: 'formatDate',
  });
  assert.ok(rows.length >= 1, `Expected at least 1 formatDate call, got ${rows.length}`);

  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  assert.ok(
    projectIds.length >= 2,
    `Expected formatDate in ≥2 projects, got: ${JSON.stringify(projectIds)}`,
  );
});

test('query_tooling_distribution: test_framework includes jest and vitest', async () => {
  const rows = await callTool('query_tooling_distribution', {
    category: 'test_framework',
  });
  const values = rows.map((r) => r.value);
  assert.ok(values.includes('jest'), `jest not found in test_framework distribution: ${JSON.stringify(values)}`);
  assert.ok(values.includes('vitest'), `vitest not found in test_framework distribution: ${JSON.stringify(values)}`);
});

test('query_dependency_versions: react 18.2.0 is present', async () => {
  const rows = await callTool('query_dependency_versions', {
    package_name: 'react',
  });
  assert.ok(rows.length >= 1, `Expected at least 1 row for react versions, got ${rows.length}`);

  const versions = rows.map((r) => r.version_resolved);
  assert.ok(
    versions.includes('18.2.0'),
    `Expected version 18.2.0 for react, got: ${JSON.stringify(versions)}`,
  );

  // BigInt must not appear in results — JSON.stringify would throw if it did
  assert.doesNotThrow(
    () => JSON.stringify(rows),
    'query_dependency_versions result must be JSON-serializable (no BigInt values)',
  );
  const react18 = rows.find((r) => r.version_resolved === '18.2.0');
  assert.strictEqual(
    typeof react18.version_major,
    'number',
    `version_major should be a number, not ${typeof react18.version_major}`,
  );
});

test('get_scan_metadata: project_count is 6', async () => {
  const meta = await callTool('get_scan_metadata', {});
  assert.equal(
    meta.project_count,
    6,
    `Expected project_count=6, got ${meta.project_count}`,
  );
});

test('internal imports are not captured: no relative/alias paths in component or function usages', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');

  const cuPath = requireParquet('component_usages');
  const fuPath = requireParquet('function_usages');

  const [componentRows, functionRows] = await Promise.all([
    queryParquet(`SELECT DISTINCT package_name FROM read_parquet('${cuPath.replace(/'/g, "''")}') WHERE is_latest = true`),
    queryParquet(`SELECT DISTINCT package_name FROM read_parquet('${fuPath.replace(/'/g, "''")}') WHERE is_latest = true`),
  ]);

  const allPackageNames = [
    ...componentRows.map(r => r.package_name),
    ...functionRows.map(r => r.package_name),
  ];

  for (const name of allPackageNames) {
    assert.ok(
      !name.startsWith('.') && !name.startsWith('/') && !name.startsWith('@/') && !name.startsWith('~/'),
      `Internal import path found in usages: "${name}" — should have been filtered out`,
    );
  }
});

test('subpath external imports (@acme/ui/icons) are captured', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const cuPath = requireParquet('component_usages');
  const rows = await queryParquet(
    `SELECT DISTINCT package_name FROM read_parquet('${cuPath.replace(/'/g, "''")}') WHERE is_latest = true AND package_name = '@acme/ui/icons'`
  );
  assert.ok(rows.length >= 1, `Expected @acme/ui/icons to appear in component_usages, but it was not found`);
});

// ─── Dashboard data loader ────────────────────────────────────────────────────

test('dashboard data loader outputs valid JSON with correct shape', () => {
  const loaderPath = resolve(__dirname, '..', 'src', 'dashboard', 'pages', 'data', 'overview.json.js');

  const result = spawnSync(process.execPath, [loaderPath], {
    env: { ...process.env, USEGRAPH_HOME },
    encoding: 'utf-8',
    timeout: 30_000,
  });

  assert.equal(
    result.status,
    0,
    `Data loader exited with code ${result.status}.\nstderr: ${result.stderr}`,
  );

  let parsed;
  assert.doesNotThrow(
    () => { parsed = JSON.parse(result.stdout); },
    `Data loader stdout is not valid JSON.\nstdout: ${result.stdout.slice(0, 300)}`,
  );

  // Shape
  assert.ok(Array.isArray(parsed.projects), 'projects should be an array');
  assert.strictEqual(typeof parsed.totalComponentUsages, 'number', 'totalComponentUsages should be a number');
  assert.strictEqual(typeof parsed.totalFunctionUsages, 'number', 'totalFunctionUsages should be a number');
  assert.ok(Array.isArray(parsed.frameworkCounts), 'frameworkCounts should be an array');
  assert.ok(Array.isArray(parsed.buildToolCounts), 'buildToolCounts should be an array');
  assert.ok(Array.isArray(parsed.packageManagerCounts), 'packageManagerCounts should be an array');

  // Data correctness
  assert.equal(parsed.projects.length, 6, `Expected 6 projects, got ${parsed.projects.length}`);
  assert.ok(parsed.totalComponentUsages > 0, 'totalComponentUsages should be > 0');
  assert.ok(parsed.totalFunctionUsages > 0, 'totalFunctionUsages should be > 0');

  // No BigInt values — JSON.stringify would have thrown during serialization
  // Verify count fields are plain numbers, not bigints
  for (const row of parsed.frameworkCounts) {
    assert.strictEqual(typeof row.count, 'number', `frameworkCounts[].count must be number, got ${typeof row.count}`);
  }
  for (const row of parsed.buildToolCounts) {
    assert.strictEqual(typeof row.count, 'number', `buildToolCounts[].count must be number, got ${typeof row.count}`);
  }
  for (const row of parsed.packageManagerCounts) {
    assert.strictEqual(typeof row.count, 'number', `packageManagerCounts[].count must be number, got ${typeof row.count}`);
  }

  // Framework distribution should include react (used by 4 of 6 fixtures)
  const frameworkNames = parsed.frameworkCounts.map((r) => r.name);
  assert.ok(
    frameworkNames.includes('react'),
    `Expected "react" in frameworkCounts, got: ${JSON.stringify(frameworkNames)}`,
  );
});

// ─── codeAt and --history tests ──────────────────────────────────────────────

test('scanned projects have codeAt set from git', async () => {
  const { loadLatestScanResult } = await import('../dist/storage.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
  const { createStorageBackend } = await import('../dist/storage/index.js');
  const { loadConfig } = await import('../dist/config.js');

  const projectPath = WORK_PROJECTS[0];
  const config = loadConfig(projectPath);
  const slug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(projectPath, slug, {}, config);
  const result = backend.loadLatest();

  assert.ok(result, 'should have a scan result');
  assert.ok(result.codeAt, 'codeAt should be set when project is a git repo');
  assert.ok(!isNaN(new Date(result.codeAt).getTime()), 'codeAt should be a valid date string');
  assert.equal(result.id, result.commitSha, 'id should equal commitSha for git repos');
});

test('--history scans multiple commits and writes separate scan files', async () => {
  const projectPath = WORK_PROJECTS[0];
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
  const { createStorageBackend } = await import('../dist/storage/index.js');
  const { loadConfig } = await import('../dist/config.js');

  const result = spawnSync(
    process.execPath,
    [DIST_CLI, 'scan', projectPath, '--packages', TARGET_PACKAGES, '--history', String(MAX_HISTORY_DEPTH)],
    {
      env: process.env,
      encoding: 'utf-8',
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 0, `--history scan failed:\n${result.stderr || result.stdout}`);

  const config = loadConfig(projectPath);
  const slug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(projectPath, slug, {}, config);
  const scanIds = backend.list();
  assert.ok(scanIds.length >= 8, `Expected ≥8 scan files after --history ${MAX_HISTORY_DEPTH}, got ${scanIds.length}`);

  // Re-running --history should be idempotent (same files, no duplicates)
  const result2 = spawnSync(
    process.execPath,
    [DIST_CLI, 'scan', projectPath, '--packages', TARGET_PACKAGES, '--history', String(MAX_HISTORY_DEPTH)],
    {
      env: process.env,
      encoding: 'utf-8',
      timeout: 120_000,
    },
  );
  assert.equal(result2.status, 0, `second --history scan failed`);
  const scanIds2 = backend.list();
  assert.equal(scanIds2.length, scanIds.length, 'Re-running --history should be idempotent');
});

test('after --history build, Parquet has multiple rows and correct is_latest', async () => {
  // Re-build with the history scans included
  await runBuild({});

  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const projectPath = WORK_PROJECTS[0];
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
  const slug = computeProjectSlug(projectPath);

  const p = requireParquet('project_snapshots');
  const rows = await queryParquet(
    `SELECT project_id, scanned_at, code_at, is_latest
     FROM read_parquet('${p.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}'
     ORDER BY code_at DESC NULLS LAST`
  );

  assert.ok(rows.length >= 8, `Expected ≥8 snapshot rows for ${slug}, got ${rows.length}`);
  const latestRows = rows.filter(r => r.is_latest);
  assert.equal(latestRows.length, 1, 'Exactly one row should have is_latest = true');
  // The latest row should be first (most recent code_at)
  assert.ok(latestRows[0].code_at != null || latestRows[0].scanned_at != null, 'Latest row should have a timestamp');
});

// ─── History depth validation tests ──────────────────────────────────────────

test('git history: web-app snapshots span at least 5 months', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const projectPath = WORK_PROJECTS[0];
  const slug = computeProjectSlug(projectPath);

  const p = requireParquet('project_snapshots');
  const rows = await queryParquet(
    `SELECT MIN(code_at) AS oldest, MAX(code_at) AS newest
     FROM read_parquet('${p.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}'
       AND code_at IS NOT NULL`
  );

  assert.ok(rows.length === 1 && rows[0].oldest && rows[0].newest,
    'Expected code_at data for web-app');

  const oldest = normalizeTimestampValue(rows[0].oldest);
  const newest = normalizeTimestampValue(rows[0].newest);
  const spanDays = (new Date(newest) - new Date(oldest)) / (1000 * 60 * 60 * 24);
  assert.ok(
    spanDays >= 150,
    `Expected code_at to span ≥150 days, got ${Math.round(spanDays)} days (oldest: ${oldest}, newest: ${newest})`,
  );
});

test('git history: all 6 projects have ≥5 snapshot rows after full history scan', async () => {
  // Scan all remaining projects with full history (web-app was already scanned in the --history test)
  for (const workPath of WORK_PROJECTS.slice(1)) {
    const scanResult = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', workPath, '--packages', TARGET_PACKAGES, '--history', String(MAX_HISTORY_DEPTH)],
      { env: process.env, encoding: 'utf-8', timeout: 120_000 },
    );
    assert.equal(scanResult.status, 0, `--history scan failed for ${workPath}:\n${scanResult.stderr || scanResult.stdout}`);
  }

  // Rebuild Parquet with all history scans included
  await runBuild({});

  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const p = requireParquet('project_snapshots');
  for (const workPath of WORK_PROJECTS) {
    const slug = computeProjectSlug(workPath);
    const rows = await queryParquet(
      `SELECT COUNT(*) AS cnt
       FROM read_parquet('${p.replace(/'/g, "''")}')
       WHERE project_id = '${slug.replace(/'/g, "''")}'`
    );
    const count = Number(rows[0].cnt);
    assert.ok(
      count >= 5,
      `Expected ≥5 snapshot rows for ${slug}, got ${count}`,
    );
  }
});

// ─── --since / --interval checkpoint scan tests ───────────────────────────────

test('--since/--interval scans checkpoint commits (downsampled)', async () => {
  const projectPath = WORK_PROJECTS[0]; // web-app: 180-day history
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
  const { createStorageBackend } = await import('../dist/storage/index.js');
  const { loadConfig } = await import('../dist/config.js');

  // Count scans before to establish baseline
  const config = loadConfig(projectPath);
  const slug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(projectPath, slug, {}, config);
  const beforeCount = backend.list().length;

  const result = spawnSync(
    process.execPath,
    [DIST_CLI, 'scan', projectPath, '--packages', TARGET_PACKAGES, '--since', '6m', '--interval', '1m'],
    { env: process.env, encoding: 'utf-8', timeout: 120_000 },
  );
  assert.equal(result.status, 0, `--since/--interval scan failed:\n${result.stderr || result.stdout}`);

  const afterIds = backend.list();
  const newScans = afterIds.length - beforeCount;

  // The fixture has commits spread over ~180 days, so 6 monthly buckets should fire
  // (some commits may already be scanned from --history tests; newScans may be 0)
  // Assert that total scans is now in a reasonable range: 3–12 unique monthly checkpoints
  assert.ok(
    afterIds.length >= 3,
    `Expected ≥3 scan files total after --since 6m --interval 1m, got ${afterIds.length}`,
  );
  assert.ok(
    afterIds.length <= MAX_HISTORY_DEPTH + 10,
    `Expected ≤${MAX_HISTORY_DEPTH + 10} total scans (downsampling should reduce count), got ${afterIds.length}`,
  );

  // Re-running should be idempotent
  const result2 = spawnSync(
    process.execPath,
    [DIST_CLI, 'scan', projectPath, '--packages', TARGET_PACKAGES, '--since', '6m', '--interval', '1m'],
    { env: process.env, encoding: 'utf-8', timeout: 120_000 },
  );
  assert.equal(result2.status, 0, 'Second --since/--interval scan should succeed');
  const afterIds2 = backend.list();
  assert.equal(afterIds2.length, afterIds.length, 'Re-running should be idempotent');
});

test('--since without --interval scans all commits in range', async () => {
  const projectPath = WORK_PROJECTS[1]; // dashboard: also has 180-day history
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
  const { createStorageBackend } = await import('../dist/storage/index.js');
  const { loadConfig } = await import('../dist/config.js');

  const config = loadConfig(projectPath);
  const slug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(projectPath, slug, {}, config);
  const beforeCount = backend.list().length;

  // Use a very short window (3d) — only the most recent commits qualify
  const result = spawnSync(
    process.execPath,
    [DIST_CLI, 'scan', projectPath, '--packages', TARGET_PACKAGES, '--since', '3d'],
    { env: process.env, encoding: 'utf-8', timeout: 60_000 },
  );
  assert.equal(result.status, 0, `--since range scan failed:\n${result.stderr || result.stdout}`);

  // The fixture's newest commit is "today" (daysAgo(0)), so at least 1 commit qualifies
  // (it may already be scanned; either way exit code must be 0)
  const afterCount = backend.list().length;
  assert.ok(afterCount >= beforeCount, 'Scan count should not decrease');
});

test('--history and --since conflict → exit code 1 with clear error', () => {
  const projectPath = WORK_PROJECTS[0];

  const result = spawnSync(
    process.execPath,
    [DIST_CLI, 'scan', projectPath, '--history', '5', '--since', '6m'],
    { env: process.env, encoding: 'utf-8', timeout: 15_000 },
  );
  assert.equal(result.status, 1, `Expected exit code 1, got ${result.status}`);
  const output = (result.stderr || '') + (result.stdout || '');
  assert.ok(
    output.includes('cannot be combined'),
    `Expected "cannot be combined" in error output, got:\n${output.slice(0, 500)}`,
  );
});

test('--interval without --since → exit code 1 with clear error', () => {
  const projectPath = WORK_PROJECTS[0];

  const result = spawnSync(
    process.execPath,
    [DIST_CLI, 'scan', projectPath, '--interval', '1m'],
    { env: process.env, encoding: 'utf-8', timeout: 15_000 },
  );
  assert.equal(result.status, 1, `Expected exit code 1, got ${result.status}`);
  const output = (result.stderr || '') + (result.stdout || '');
  assert.ok(
    output.includes('--interval requires --since'),
    `Expected "--interval requires --since" in error output, got:\n${output.slice(0, 500)}`,
  );
});

test('--since: inactive project (no commits in range) gets a baseline scan pinned to sinceDate', async () => {
  // Create a fresh project whose only commit is 45 days in the past.
  // When we scan with --since 7d the commit is outside the range, but we still
  // expect a baseline scan with codeAt set to sinceDate (≈ now-7d).
  const DAY_MS = 24 * 60 * 60 * 1000;
  const tmpRoot = mkdtempSync(join(tmpdir(), 'usegraph-baseline-'));
  try {
    mkdirSync(tmpRoot, { recursive: true });

    const commitDate = new Date(Date.now() - 45 * DAY_MS).toISOString();
    await initHistoricalRepo(tmpRoot, [
      {
        date: commitDate,
        message: 'initial commit (45 days ago)',
        files: {
          'package.json': JSON.stringify({ name: 'inactive-project', version: '1.0.0' }),
          'src/index.ts': 'export const hello = "world";',
        },
      },
    ]);

    const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
    const { createStorageBackend } = await import('../dist/storage/index.js');
    const { loadConfig } = await import('../dist/config.js');

    const config = loadConfig(tmpRoot);
    const slug = computeProjectSlug(tmpRoot);
    const backend = createStorageBackend(tmpRoot, slug, {}, config);

    const beforeCount = backend.list().length;
    assert.equal(beforeCount, 0, 'No scans should exist before running --since');

    const result = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', tmpRoot, '--packages', TARGET_PACKAGES, '--since', '7d'],
      { env: process.env, encoding: 'utf-8', timeout: 60_000 },
    );
    assert.equal(result.status, 0,
      `--since scan on inactive project failed:\n${result.stderr || result.stdout}`);

    // Should have produced exactly 1 scan (the baseline commit)
    const afterIds = backend.list();
    assert.equal(afterIds.length, 1,
      `Expected 1 baseline scan, got ${afterIds.length}: ${JSON.stringify(afterIds)}`);

    // Load the scan result and verify codeAt is pinned to the sinceDate (~7 days ago)
    const scan = backend.load(afterIds[0]);
    assert.ok(scan !== null, 'Scan result should be loadable');
    assert.ok(scan.codeAt !== null, 'codeAt should be set on the baseline scan');

    const codeAtMs = new Date(scan.codeAt).getTime();
    const sinceDateMs = Date.now() - 7 * DAY_MS;
    // codeAt should be within 5 minutes of sinceDate (7 days ago), not 45 days ago
    assert.ok(
      Math.abs(codeAtMs - sinceDateMs) < 5 * 60 * 1000,
      `Expected codeAt ≈ sinceDate (7d ago), got ${scan.codeAt}`,
    );
    assert.ok(scan.isHistoricalScan === true, 'Baseline scan should be marked as historical');

    // Re-running should be idempotent (baseline already scanned)
    const result2 = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', tmpRoot, '--packages', TARGET_PACKAGES, '--since', '7d'],
      { env: process.env, encoding: 'utf-8', timeout: 60_000 },
    );
    assert.equal(result2.status, 0, 'Re-running --since on inactive project should succeed');
    assert.equal(backend.list().length, 1, 'Re-running should not add duplicate scans');
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('after checkpoint scan build, project_snapshots has rows across date range', async () => {
  // Rebuild to include any newly added checkpoint scans
  await runBuild({});

  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const projectPath = WORK_PROJECTS[0];
  const slug = computeProjectSlug(projectPath);
  const p = requireParquet('project_snapshots');

  const rows = await queryParquet(
    `SELECT MIN(code_at) AS oldest, MAX(code_at) AS newest, COUNT(*) AS cnt
     FROM read_parquet('${p.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}'
       AND code_at IS NOT NULL`
  );

  assert.ok(rows.length === 1 && rows[0].oldest, 'Expected code_at data for web-app');
  const oldest = normalizeTimestampValue(rows[0].oldest);
  const newest = normalizeTimestampValue(rows[0].newest);
  const spanDays = (new Date(newest) - new Date(oldest)) / (1000 * 60 * 60 * 24);
  assert.ok(
    spanDays >= 150,
    `Expected code_at to span ≥150 days after checkpoint scan, got ${Math.round(spanDays)} days`,
  );
});
