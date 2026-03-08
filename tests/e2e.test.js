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
  // Subdirectory package.json detection: no root package.json, one in frontend/
  join(FIXTURES_ROOT, 'apps/frontend-subdir'),
];

// Maps source path → history key (e.g. 'apps/web-app')
const HISTORY_KEYS = {
  [join(FIXTURES_ROOT, 'apps/web-app')]:          'apps/web-app',
  [join(FIXTURES_ROOT, 'apps/dashboard')]:        'apps/dashboard',
  [join(FIXTURES_ROOT, 'apps/docs')]:             'apps/docs',
  [join(FIXTURES_ROOT, 'apps/mobile')]:           'apps/mobile',
  [join(FIXTURES_ROOT, 'packages/ui')]:           'packages/ui',
  [join(FIXTURES_ROOT, 'packages/utils')]:        'packages/utils',
  [join(FIXTURES_ROOT, 'apps/frontend-subdir')]:  'apps/frontend-subdir',
};

// Work dirs: temp copies initialized with full git history (populated in before())
const WORK_PROJECTS = [];

// Monorepo: single work dir, multiple scan targets within it
let MONOREPO_WORK_DIR = null;

const DIST_CLI = resolve(__dirname, '..', 'dist', 'index.js');
const TARGET_PACKAGES = '@acme/ui,@acme/utils';

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

  // Monorepo: one shared work dir, scanned as two separate workspace packages
  MONOREPO_WORK_DIR = join(workRoot, 'apps/monorepo');
  mkdirSync(MONOREPO_WORK_DIR, { recursive: true });
  await initHistoricalRepo(
    MONOREPO_WORK_DIR,
    ORG_HISTORY['apps/monorepo'].commits,
    { remote: ORG_HISTORY['apps/monorepo'].remote },
  );

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

  // Scan each monorepo workspace package as a separate project
  for (const pkg of ['packages/web', 'packages/api']) {
    const scanPath = join(MONOREPO_WORK_DIR, pkg);
    const result = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', scanPath, '--packages', TARGET_PACKAGES],
      {
        env: process.env,
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    if (result.status !== 0) {
      const err = (result.stderr || result.stdout || '').slice(0, 500);
      throw new Error(`Scan failed for monorepo ${pkg}:\n${err}`);
    }
  }

  // 2. Build Parquet tables
  await runBuild();
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

test('list_projects returns exactly 9 projects', async () => {
  const rows = await callTool('list_projects', {});
  assert.equal(rows.length, 9, `Expected 9 projects, got ${rows.length}: ${JSON.stringify(rows.map(r => r.project_id))}`);
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

test('get_scan_metadata: project_count is 9', async () => {
  const meta = await callTool('get_scan_metadata', {});
  assert.equal(
    meta.project_count,
    9,
    `Expected project_count=9, got ${meta.project_count}`,
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
  assert.equal(parsed.projects.length, 9, `Expected 9 projects, got ${parsed.projects.length}`);
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

// ─── codeAt tests ─────────────────────────────────────────────────────────────

test('scanned projects have codeAt set from git', async () => {
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
  const { createStorageBackend } = await import('../dist/storage/index.js');

  const projectPath = WORK_PROJECTS[0];
  const slug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(slug);
  const result = backend.loadLatest();

  assert.ok(result, 'should have a scan result');
  assert.ok(result.codeAt, 'codeAt should be set when project is a git repo');
  assert.ok(!isNaN(new Date(result.codeAt).getTime()), 'codeAt should be a valid date string');
  assert.equal(result.id, result.commitSha, 'id should equal commitSha for git repos');
});

// ─── --since / --interval checkpoint scan tests ───────────────────────────────

test('--since/--interval scans checkpoint commits (downsampled)', async () => {
  const projectPath = WORK_PROJECTS[0]; // web-app: 180-day history
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');
  const { createStorageBackend } = await import('../dist/storage/index.js');

  // Count scans before to establish baseline
  const slug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(slug);
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

  const slug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(slug);
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

    const slug = computeProjectSlug(tmpRoot);
    const backend = createStorageBackend(slug);

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
  await runBuild();

  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const projectPath = WORK_PROJECTS[0];
  const slug = computeProjectSlug(projectPath);
  const p = requireParquet('project_snapshots');

  const rows = await queryParquet(
    `SELECT DATE_DIFF('day', CAST(MIN(code_at) AS TIMESTAMP), CAST(MAX(code_at) AS TIMESTAMP)) AS span_days,
            CAST(MIN(code_at) AS VARCHAR) AS oldest,
            CAST(MAX(code_at) AS VARCHAR) AS newest,
            COUNT(*) AS cnt
     FROM read_parquet('${p.replace(/'/g, "''")}')
      WHERE project_id = '${slug.replace(/'/g, "''")}'
        AND code_at IS NOT NULL`
  );

  assert.ok(rows.length === 1 && rows[0].oldest, 'Expected code_at data for web-app');
  const spanDays = Number(rows[0].span_days);
  const oldest = String(rows[0].oldest);
  const newest = String(rows[0].newest);
  assert.ok(
    spanDays >= 150,
    `Expected code_at to span ≥150 days after checkpoint scan, got ${Math.round(spanDays)} days (oldest: ${oldest}, newest: ${newest})`,
  );
});

// ─── Subdirectory package.json detection tests ────────────────────────────────

test('frontend-subdir: package manager detected as pnpm from frontend/pnpm-lock.yaml', async () => {
  // The frontend-subdir project has no root-level package.json — only frontend/package.json.
  // The scanner should detect the lockfile in the frontend/ subdirectory and report pnpm.
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const frontendSubdirWorkPath = WORK_PROJECTS[6]; // apps/frontend-subdir
  const slug = computeProjectSlug(frontendSubdirWorkPath);

  const p = requireParquet('project_snapshots');
  const rows = await queryParquet(
    `SELECT package_manager
     FROM read_parquet('${p.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}'
       AND is_latest = true`
  );

  assert.ok(rows.length >= 1, `Expected at least 1 snapshot for frontend-subdir (slug: ${slug})`);
  assert.equal(
    rows[0].package_manager,
    'pnpm',
    `Expected pnpm detected from frontend/pnpm-lock.yaml, got: ${rows[0].package_manager}`,
  );
});

test('frontend-subdir: dependencies read from frontend/package.json', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const frontendSubdirWorkPath = WORK_PROJECTS[6]; // apps/frontend-subdir
  const slug = computeProjectSlug(frontendSubdirWorkPath);

  const p = requireParquet('dependencies');
  const rows = await queryParquet(
    `SELECT DISTINCT package_name
     FROM read_parquet('${p.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}'
       AND is_latest = true`
  );

  const names = rows.map((r) => r.package_name);
  assert.ok(
    names.includes('@acme/ui'),
    `Expected @acme/ui in frontend-subdir dependencies, got: ${JSON.stringify(names)}`,
  );
  assert.ok(
    names.includes('@acme/utils'),
    `Expected @acme/utils in frontend-subdir dependencies, got: ${JSON.stringify(names)}`,
  );
});

test('frontend-subdir: component and function usages are captured', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const frontendSubdirWorkPath = WORK_PROJECTS[6]; // apps/frontend-subdir
  const slug = computeProjectSlug(frontendSubdirWorkPath);

  const cuPath = requireParquet('component_usages');
  const fuPath = requireParquet('function_usages');

  const [componentRows, functionRows] = await Promise.all([
    queryParquet(
      `SELECT component_name FROM read_parquet('${cuPath.replace(/'/g, "''")}')
       WHERE project_id = '${slug.replace(/'/g, "''")}' AND is_latest = true`
    ),
    queryParquet(
      `SELECT export_name FROM read_parquet('${fuPath.replace(/'/g, "''")}')
       WHERE project_id = '${slug.replace(/'/g, "''")}' AND is_latest = true`
    ),
  ]);

  const components = componentRows.map((r) => r.component_name);
  const functions = functionRows.map((r) => r.export_name);

  assert.ok(
    components.includes('Button'),
    `Expected Button component usage in frontend-subdir, got: ${JSON.stringify(components)}`,
  );
  assert.ok(
    components.includes('Badge'),
    `Expected Badge component usage in frontend-subdir, got: ${JSON.stringify(components)}`,
  );
  assert.ok(
    functions.includes('formatDate'),
    `Expected formatDate function usage in frontend-subdir, got: ${JSON.stringify(functions)}`,
  );
});

// ─── Monorepo workspace package tests ────────────────────────────────────────

test('monorepo/packages/web: package manager detected as pnpm from root lockfile', async () => {
  // The packages/web directory has no lockfile — pnpm-lock.yaml is at the monorepo root.
  // findLockfileDir should traverse up and detect pnpm.
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const webPath = join(MONOREPO_WORK_DIR, 'packages/web');
  const slug = computeProjectSlug(webPath);

  const p = requireParquet('project_snapshots');
  const rows = await queryParquet(
    `SELECT package_manager
     FROM read_parquet('${p.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}' AND is_latest = true`
  );

  assert.ok(rows.length >= 1, `Expected at least 1 snapshot for monorepo web (slug: ${slug})`);
  assert.equal(
    rows[0].package_manager,
    'pnpm',
    `Expected pnpm from root lockfile for monorepo web, got: ${rows[0].package_manager}`,
  );
});

test('monorepo/packages/api: package manager detected as pnpm from root lockfile', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const apiPath = join(MONOREPO_WORK_DIR, 'packages/api');
  const slug = computeProjectSlug(apiPath);

  const p = requireParquet('project_snapshots');
  const rows = await queryParquet(
    `SELECT package_manager
     FROM read_parquet('${p.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}' AND is_latest = true`
  );

  assert.ok(rows.length >= 1, `Expected at least 1 snapshot for monorepo api (slug: ${slug})`);
  assert.equal(
    rows[0].package_manager,
    'pnpm',
    `Expected pnpm from root lockfile for monorepo api, got: ${rows[0].package_manager}`,
  );
});

test('monorepo/packages/web: @acme/ui and @acme/utils appear in component/function usages', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const webPath = join(MONOREPO_WORK_DIR, 'packages/web');
  const slug = computeProjectSlug(webPath);

  const cuPath = requireParquet('component_usages');
  const rows = await queryParquet(
    `SELECT component_name, package_name
     FROM read_parquet('${cuPath.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}' AND is_latest = true`
  );

  const components = rows.map((r) => r.component_name);
  assert.ok(
    components.includes('Button'),
    `Expected Button in monorepo web component usages, got: ${JSON.stringify(components)}`,
  );
});

test('monorepo/packages/api: @acme/utils functions are captured', async () => {
  const { queryParquet, requireParquet } = await import('../dist/parquet-query.js');
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const apiPath = join(MONOREPO_WORK_DIR, 'packages/api');
  const slug = computeProjectSlug(apiPath);

  const fuPath = requireParquet('function_usages');
  const rows = await queryParquet(
    `SELECT export_name
     FROM read_parquet('${fuPath.replace(/'/g, "''")}')
     WHERE project_id = '${slug.replace(/'/g, "''")}' AND is_latest = true`
  );

  const functions = rows.map((r) => r.export_name);
  assert.ok(
    functions.includes('formatDate') || functions.includes('formatCurrency') || functions.includes('debounce'),
    `Expected @acme/utils function usages in monorepo api, got: ${JSON.stringify(functions)}`,
  );
});

test('monorepo packages are treated as separate projects', async () => {
  const { computeProjectSlug } = await import('../dist/analyzer/project-identity.js');

  const webSlug = computeProjectSlug(join(MONOREPO_WORK_DIR, 'packages/web'));
  const apiSlug = computeProjectSlug(join(MONOREPO_WORK_DIR, 'packages/api'));

  assert.notEqual(webSlug, apiSlug, 'Monorepo workspace packages should have distinct project slugs');

  const rows = await callTool('list_projects', {});
  const projectIds = rows.map((r) => r.project_id);

  assert.ok(
    projectIds.includes(webSlug),
    `Expected monorepo web package (${webSlug}) in project list: ${JSON.stringify(projectIds)}`,
  );
  assert.ok(
    projectIds.includes(apiSlug),
    `Expected monorepo api package (${apiSlug}) in project list: ${JSON.stringify(projectIds)}`,
  );
});

// ─── CI template usage e2e tests ──────────────────────────────────────────────

test('ci_template_usages.parquet is produced by build', async () => {
  const { existsSync } = await import('node:fs');
  const { getBuiltDir } = await import('../dist/parquet-query.js');
  const ciPath = join(getBuiltDir(), 'ci_template_usages.parquet');
  assert.ok(existsSync(ciPath), `Expected ci_template_usages.parquet to exist at ${ciPath}`);
});

test('list_ci_templates returns rows including actions/checkout', async () => {
  const rows = await callTool('list_ci_templates', {});
  assert.ok(rows.length >= 1, `Expected at least 1 CI template row, got ${rows.length}`);
  const sources = rows.map((r) => r.source);
  assert.ok(
    sources.includes('actions/checkout'),
    `Expected actions/checkout in CI templates: ${JSON.stringify(sources)}`,
  );
});

test('list_ci_templates: provider filter returns only github rows', async () => {
  const rows = await callTool('list_ci_templates', { provider: 'github' });
  assert.ok(rows.length >= 1, 'Expected at least 1 github CI template');
  for (const row of rows) {
    assert.equal(row.provider, 'github', `Expected all rows to be github, got: ${row.provider}`);
  }
});

test('query_ci_template_usage: actions/checkout returns project rows', async () => {
  const rows = await callTool('query_ci_template_usage', { source: 'actions/checkout' });
  assert.ok(rows.length >= 1, `Expected at least 1 usage row for actions/checkout, got ${rows.length}`);

  // Each row has required fields
  for (const row of rows) {
    assert.ok(row.project_id, 'Row should have project_id');
    assert.equal(row.provider, 'github', 'actions/checkout should be from github provider');
    assert.ok(row.file_path, 'Row should have file_path');
    assert.ok(row.line > 0, 'Row should have a positive line number');
  }
});

test('query_ci_template_usage: version v4 is seen for actions/checkout', async () => {
  const rows = await callTool('query_ci_template_usage', { source: 'actions/checkout' });
  const versions = rows.map((r) => r.version);
  assert.ok(
    versions.includes('v4'),
    `Expected version v4 for actions/checkout, got: ${JSON.stringify(versions)}`,
  );
});

test('query_ci_template_adoption_trend: returns monthly data with period + adopting_projects fields', async () => {
  const rows = await callTool('query_ci_template_adoption_trend', {
    source: 'actions/checkout',
    period_months: 3,
  });
  assert.ok(rows.length >= 1, `Expected at least 1 trend row, got ${rows.length}`);
  for (const row of rows) {
    assert.ok(typeof row.period === 'string', `period should be a string, got ${typeof row.period}`);
    assert.ok(typeof row.adopting_projects === 'number', `adopting_projects should be a number, got ${typeof row.adopting_projects}`);
    assert.ok(row.adopting_projects >= 0, 'adopting_projects should be non-negative');
  }
});

test('query_ci_template_inputs: actions/setup-node node-version input is present', async () => {
  const rows = await callTool('query_ci_template_inputs', {
    source: 'actions/setup-node',
    input_name: 'node-version',
  });
  assert.ok(rows.length >= 1, `Expected at least 1 input row for actions/setup-node node-version, got ${rows.length}`);
  assert.ok(
    rows.some((r) => r.input_name === 'node-version'),
    `Expected node-version in inputs: ${JSON.stringify(rows)}`,
  );
});

test('ci_overview.json data loader outputs valid JSON with expected shape', () => {
  const loaderPath = resolve(__dirname, '..', 'src', 'dashboard', 'pages', 'data', 'ci_overview.json.js');
  const result = spawnSync(process.execPath, [loaderPath], {
    env: { ...process.env, USEGRAPH_HOME },
    encoding: 'utf-8',
    timeout: 30_000,
  });

  assert.equal(
    result.status,
    0,
    `CI data loader exited with code ${result.status}.\nstderr: ${result.stderr}`,
  );

  let parsed;
  assert.doesNotThrow(
    () => { parsed = JSON.parse(result.stdout); },
    `CI data loader stdout is not valid JSON.\nstdout: ${result.stdout.slice(0, 300)}`,
  );

  assert.ok(typeof parsed.totalUsages === 'number', 'totalUsages should be a number');
  assert.ok(typeof parsed.projectCount === 'number', 'projectCount should be a number');
  assert.ok(Array.isArray(parsed.providerCounts), 'providerCounts should be an array');
  assert.ok(Array.isArray(parsed.topTemplates), 'topTemplates should be an array');
  assert.ok(parsed.totalUsages > 0, 'Expected totalUsages > 0 (CI files present in fixtures)');
});
