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

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

// ─── Step 1: set USEGRAPH_HOME before requiring any dist modules ──────────────
// The build and mcp modules evaluate process.env.USEGRAPH_HOME at load time,
// so we must set it before the first require() of those modules.

const USEGRAPH_HOME = mkdtempSync(join(tmpdir(), 'usegraph-e2e-'));
process.env.USEGRAPH_HOME = USEGRAPH_HOME;

// ─── Step 2: require dist modules (they now pick up the temp dir) ─────────────

const { runBuild } = require('../dist/commands/build');
const { callTool } = require('../dist/commands/mcp');

// ─── Fixture paths ────────────────────────────────────────────────────────────

const FIXTURES_ROOT = resolve(__dirname, 'fixtures/org');
const FIXTURE_PROJECTS = [
  join(FIXTURES_ROOT, 'apps/web-app'),
  join(FIXTURES_ROOT, 'apps/dashboard'),
  join(FIXTURES_ROOT, 'apps/docs'),
  join(FIXTURES_ROOT, 'apps/mobile'),
  join(FIXTURES_ROOT, 'packages/ui'),
  join(FIXTURES_ROOT, 'packages/utils'),
];

const DIST_CLI = resolve(__dirname, '..', 'dist', 'index.js');
const TARGET_PACKAGES = '@acme/ui,@acme/utils';

// ─── Setup / teardown ─────────────────────────────────────────────────────────

before(async () => {
  // 1. Scan each fixture project
  for (const projectPath of FIXTURE_PROJECTS) {
    const result = spawnSync(
      process.execPath,
      [DIST_CLI, 'scan', projectPath, '--packages', TARGET_PACKAGES],
      {
        env: process.env, // USEGRAPH_HOME already set
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    if (result.status !== 0) {
      const err = (result.stderr || result.stdout || '').slice(0, 500);
      throw new Error(`Scan failed for ${projectPath}:\n${err}`);
    }
  }

  // 2. Build Parquet tables
  await runBuild({});
});

after(() => {
  // Clean up temp dir
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
  const { queryParquet, requireParquet } = require('../dist/parquet-query');

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
  const { queryParquet, requireParquet } = require('../dist/parquet-query');
  const cuPath = requireParquet('component_usages');
  const rows = await queryParquet(
    `SELECT DISTINCT package_name FROM read_parquet('${cuPath.replace(/'/g, "''")}') WHERE is_latest = true AND package_name = '@acme/ui/icons'`
  );
  assert.ok(rows.length >= 1, `Expected @acme/ui/icons to appear in component_usages, but it was not found`);
});
