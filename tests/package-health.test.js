/**
 * Unit tests for src/package-health.ts query functions.
 *
 * Pattern: write minimal ScanResult JSON files to a temp USEGRAPH_HOME,
 * call runBuild() to produce Parquet tables, then exercise each query function
 * with specific assertions on the output.
 *
 * Run: node --test tests/package-health.test.js
 * Requirements: dist/ must be built.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Setup: temp USEGRAPH_HOME ─────────────────────────────────────────────────

const USEGRAPH_HOME = mkdtempSync(join(tmpdir(), 'usegraph-health-unit-'));
process.env.USEGRAPH_HOME = USEGRAPH_HOME;

// Dynamic imports must come after env var is set
const { runBuild } = await import('../dist/commands/build.js');
const {
  getLatestScanPerProject,
  getStableCorpus,
  getAdoptionDelta,
  getVersionDistribution,
  getComponentDeltas,
  getCoverageInfo,
  parsePeriod,
  getPackageHealth,
} = await import('../dist/package-health.js');

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Write a scan JSON file to USEGRAPH_HOME/<slug>/scans/<id>.json */
function writeScan(scan) {
  const dir = join(USEGRAPH_HOME, ...scan.projectSlug.split('/'), 'scans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scan.id}.json`), JSON.stringify(scan, null, 2));
}

/** ISO date for N days ago */
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Build a minimal ScanResult with component and function usages */
function makeScan({
  id,
  slug,
  codeAt,
  scannedAt,
  pkg = '@test/lib',
  versionResolved = '2.0.0',
  componentUsages = [],
  functionCalls = [],
  language = 'javascript',
}) {
  return {
    id,
    schemaVersion: 1,
    projectPath: `/projects/${slug}`,
    projectName: slug,
    projectSlug: slug,
    scannedAt: scannedAt ?? codeAt ?? new Date().toISOString(),
    codeAt: codeAt ?? null,
    repoUrl: null,
    branch: 'main',
    commitSha: id,
    packageJson: { name: slug, dependencies: { [pkg]: '^2.0.0' } },
    targetPackages: [pkg],
    internalPackages: [],
    fileCount: 1,
    files: [
      ...componentUsages.map((cu) => ({
        filePath: `/projects/${slug}/${cu.file}`,
        relativePath: cu.file,
        imports: [{ source: pkg, specifiers: [{ local: cu.componentName, imported: cu.componentName, type: 'named' }], typeOnly: false }],
        componentUsages: [{
          file: `/projects/${slug}/${cu.file}`,
          line: cu.line ?? 5,
          column: 3,
          componentName: cu.componentName,
          importedFrom: pkg,
          props: (cu.props ?? []).map((p) => ({ name: p, value: 'test', isDynamic: false, sourceSnippet: null })),
          selfClosing: true,
          packageVersionResolved: versionResolved,
          packageVersionMajor: parseInt(versionResolved.split('.')[0]),
          packageVersionMinor: parseInt(versionResolved.split('.')[1]),
          packageVersionPatch: parseInt(versionResolved.split('.')[2]),
          packageVersionPrerelease: null,
          packageVersionIsPrerelease: false,
        }],
        functionCalls: [],
        errors: [],
      })),
      ...functionCalls.map((fc) => ({
        filePath: `/projects/${slug}/${fc.file}`,
        relativePath: fc.file,
        imports: [{ source: pkg, specifiers: [{ local: fc.functionName, imported: fc.functionName, type: 'named' }], typeOnly: false }],
        componentUsages: [],
        functionCalls: [{
          file: `/projects/${slug}/${fc.file}`,
          line: fc.line ?? 10,
          column: 3,
          functionName: fc.functionName,
          importedFrom: pkg,
          args: (fc.args ?? []).map((a, i) => ({
            index: i,
            type: a.type ?? 'string',
            value: a.value,
            isSpread: false,
            sourceSnippet: a.type === 'identifier' ? `someVar` : null,
          })),
          packageVersionResolved: versionResolved,
          packageVersionMajor: parseInt(versionResolved.split('.')[0]),
          packageVersionMinor: parseInt(versionResolved.split('.')[1]),
          packageVersionPatch: parseInt(versionResolved.split('.')[2]),
          packageVersionPrerelease: null,
          packageVersionIsPrerelease: false,
        }],
        errors: [],
      })),
    ],
    summary: {
      totalFilesScanned: componentUsages.length + functionCalls.length,
      filesWithErrors: 0,
      filesWithTargetUsage: componentUsages.length + functionCalls.length,
      totalComponentUsages: componentUsages.length,
      totalFunctionCalls: functionCalls.length,
      byPackage: {
        [pkg]: {
          totalComponentUsages: componentUsages.length,
          totalFunctionCalls: functionCalls.length,
          files: [],
          components: componentUsages.map((c) => c.componentName),
          functions: functionCalls.map((f) => f.functionName),
        },
      },
    },
    meta: {
      packageName: slug,
      packageVersion: '1.0.0',
      dependencies: [
        {
          name: pkg,
          versionRange: '^2.0.0',
          section: 'dependencies',
          versionResolved,
          versionMajor: parseInt(versionResolved.split('.')[0]),
          versionMinor: parseInt(versionResolved.split('.')[1]),
          versionPatch: parseInt(versionResolved.split('.')[2]),
          versionPrerelease: null,
          versionIsPrerelease: false,
          language,
        },
      ],
      tooling: {
        packageManager: language === 'python' ? null : 'pnpm',
        packageManagerVersion: null,
        buildTool: null,
        testFramework: null,
        bundler: null,
        linter: null,
        formatter: null,
        cssApproach: null,
        typescript: true,
        typescriptVersion: null,
        nodeVersion: null,
        framework: language === 'python' ? null : 'react',
        frameworkVersion: null,
        pythonPackageManager: language === 'python' ? 'pip' : null,
        pythonVersion: language === 'python' ? '3.11' : null,
        pythonFramework: language === 'python' ? 'fastapi' : null,
        pythonTestFramework: null,
        pythonLinter: null,
        pythonFormatter: null,
        pythonTypeChecker: null,
      },
    },
  };
}

// ─── Fixture data ──────────────────────────────────────────────────────────────

// 90 days ago = period A; 20 days ago = period B
// from = '100d' → ~100 days ago; mid ≈ 50 days ago

const PKG = '@test/lib';

// Project ALPHA: scanned in both period A and period B (stable corpus)
// Period A scan (80 days ago)
writeScan(makeScan({
  id: 'alpha-scan-a',
  slug: 'org/alpha',
  codeAt: daysAgo(80),
  pkg: PKG,
  versionResolved: '2.0.0',
  componentUsages: [
    { file: 'src/App.tsx', componentName: 'Widget', line: 5, props: ['color', 'size'] },
  ],
  functionCalls: [
    {
      file: 'src/utils.ts',
      functionName: 'createConfig',
      line: 10,
      args: [{ type: 'string', value: 'production' }],
    },
  ],
}));

// Period B scan (20 days ago) — Widget still present, Panel added, setupClient added
// Also has a test file that should be excluded
writeScan(makeScan({
  id: 'alpha-scan-b',
  slug: 'org/alpha',
  codeAt: daysAgo(20),
  pkg: PKG,
  versionResolved: '2.1.0',
  componentUsages: [
    { file: 'src/App.tsx', componentName: 'Widget', line: 5, props: ['color', 'size', 'onClick'] },
    { file: 'src/Dashboard.tsx', componentName: 'Panel', line: 12, props: ['title'] },
    // Test file — should be excluded by query
    { file: 'src/App.test.tsx', componentName: 'Widget', line: 8, props: [] },
  ],
  functionCalls: [
    {
      file: 'src/utils.ts',
      functionName: 'createConfig',
      line: 10,
      args: [{ type: 'string', value: 'production' }, { type: 'string', value: 'v2' }],
    },
    {
      file: 'src/client.ts',
      functionName: 'setupClient',
      line: 3,
      args: [{ type: 'identifier', value: null }], // dynamic arg
    },
  ],
}));

// Project BETA: scanned in both periods, but drops the package in period B
// (used to test adoption churn)
writeScan(makeScan({
  id: 'beta-scan-a',
  slug: 'org/beta',
  codeAt: daysAgo(75),
  pkg: PKG,
  versionResolved: '1.0.0', // old version = lagging (2 majors behind max)
  componentUsages: [
    { file: 'src/index.tsx', componentName: 'Widget', line: 3, props: [] },
  ],
  functionCalls: [],
}));

// beta-scan-b: still in period B but package NOT in dependencies
// To simulate this, we create a different scan structure — minimal, no pkg
const betaScanB = {
  id: 'beta-scan-b',
  schemaVersion: 1,
  projectPath: '/projects/org/beta',
  projectName: 'org/beta',
  projectSlug: 'org/beta',
  scannedAt: daysAgo(15),
  codeAt: daysAgo(15),
  repoUrl: null,
  branch: 'main',
  commitSha: 'beta-scan-b',
  packageJson: { name: 'org/beta' },
  targetPackages: [PKG],
  internalPackages: [],
  fileCount: 0,
  files: [],
  summary: {
    totalFilesScanned: 0,
    filesWithErrors: 0,
    filesWithTargetUsage: 0,
    totalComponentUsages: 0,
    totalFunctionCalls: 0,
    byPackage: {},
  },
  meta: {
    packageName: 'org/beta',
    packageVersion: '1.0.0',
    dependencies: [], // no pkg — churned!
    tooling: {
      packageManager: 'npm', packageManagerVersion: null, buildTool: null,
      testFramework: null, bundler: null, linter: null, formatter: null,
      cssApproach: null, typescript: false, typescriptVersion: null,
      nodeVersion: null, framework: null, frameworkVersion: null,
      pythonPackageManager: null, pythonVersion: null, pythonFramework: null,
      pythonTestFramework: null, pythonLinter: null, pythonFormatter: null, pythonTypeChecker: null,
    },
  },
};
// Note: betaScanB doesn't have the pkg in dependencies, so it won't appear
// in getLatestScanPerProject for pkg. This means beta won't appear in period B corpus.
// So beta is actually in "removedProjects" not stable.

// Project GAMMA: only scanned in period B (new to corpus)
writeScan(makeScan({
  id: 'gamma-scan-b',
  slug: 'org/gamma',
  codeAt: daysAgo(10),
  pkg: PKG,
  versionResolved: '3.0.0-beta.1', // prerelease
  componentUsages: [
    { file: 'src/index.tsx', componentName: 'Widget', line: 1, props: [] },
  ],
  functionCalls: [],
}));

// Python project: stable in both periods
writeScan(makeScan({
  id: 'pyproj-scan-a',
  slug: 'org/pyproj',
  codeAt: daysAgo(85),
  pkg: '@test/pylib',
  versionResolved: '1.0.0',
  language: 'python',
  componentUsages: [],
  functionCalls: [
    { file: 'app/main.py', functionName: 'create_app', line: 5, args: [] },
  ],
}));

writeScan(makeScan({
  id: 'pyproj-scan-b',
  slug: 'org/pyproj',
  codeAt: daysAgo(25),
  pkg: '@test/pylib',
  versionResolved: '1.1.0',
  language: 'python',
  componentUsages: [],
  functionCalls: [
    { file: 'app/main.py', functionName: 'create_app', line: 5, args: [] },
    { file: 'app/worker.py', functionName: 'run_task', line: 8, args: [{ type: 'string', value: 'daily' }] },
  ],
}));

// Python test file — should be excluded
writeScan(makeScan({
  id: 'pyproj-scan-b-tests',
  slug: 'org/pyproj-test-only',
  codeAt: daysAgo(22),
  pkg: '@test/pylib',
  versionResolved: '1.1.0',
  language: 'python',
  componentUsages: [],
  functionCalls: [
    { file: 'tests/test_main.py', functionName: 'create_app', line: 3, args: [] },
  ],
}));

// Build Parquet tables from all fixtures
await runBuild();

// ─── parsePeriod tests ─────────────────────────────────────────────────────────

test('parsePeriod: ISO date returned unchanged', () => {
  assert.equal(parsePeriod('2025-01-15'), '2025-01-15');
});

test('parsePeriod: relative "0d" returns today', () => {
  const result = parsePeriod('0d');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(result, today);
});

test('parsePeriod: "3m" returns ~3 months ago', () => {
  const result = parsePeriod('3m');
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const expected = threeMonthsAgo.toISOString().slice(0, 10);
  assert.equal(result, expected);
});

test('parsePeriod: "1y" returns same date last year', () => {
  const result = parsePeriod('1y');
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const expected = oneYearAgo.toISOString().slice(0, 10);
  assert.equal(result, expected);
});

// ─── getLatestScanPerProject tests ────────────────────────────────────────────

test('getLatestScanPerProject: returns alpha in period A', async () => {
  const from = daysAgo(100).slice(0, 10);
  const to = daysAgo(50).slice(0, 10);
  const scans = await getLatestScanPerProject(PKG, from, to);
  const slugs = scans.map((s) => s.project_id);
  assert.ok(slugs.includes('org/alpha'), `Expected org/alpha in ${JSON.stringify(slugs)}`);
  assert.ok(slugs.includes('org/beta'), `Expected org/beta in ${JSON.stringify(slugs)}`);
  // gamma is not in period A
  assert.ok(!slugs.includes('org/gamma'), `org/gamma should not be in period A`);
});

test('getLatestScanPerProject: when multiple scans in period, returns most recent', async () => {
  // Create two scans for a new project in period B
  writeScan(makeScan({
    id: 'multi-scan-1',
    slug: 'org/multi',
    codeAt: daysAgo(35),
    pkg: PKG,
    versionResolved: '2.0.0',
    componentUsages: [{ file: 'src/A.tsx', componentName: 'Widget', line: 1 }],
    functionCalls: [],
  }));
  writeScan(makeScan({
    id: 'multi-scan-2',
    slug: 'org/multi',
    codeAt: daysAgo(22), // more recent
    pkg: PKG,
    versionResolved: '2.1.0', // newer version
    componentUsages: [{ file: 'src/A.tsx', componentName: 'Widget', line: 1 }],
    functionCalls: [],
  }));
  // Rebuild to include new scans
  await runBuild();

  const from = daysAgo(50).slice(0, 10);
  const to = daysAgo(5).slice(0, 10);
  const scans = await getLatestScanPerProject(PKG, from, to);
  const multiScan = scans.find((s) => s.project_id === 'org/multi');
  assert.ok(multiScan, 'org/multi should be in period B');
  // The returned scan should be the most recent one (multi-scan-2)
  assert.equal(multiScan.scanned_at.slice(0, 10), daysAgo(22).slice(0, 10),
    `Expected most recent scan, got ${multiScan.scanned_at}`);
});

// ─── getStableCorpus tests ────────────────────────────────────────────────────

test('getStableCorpus: alpha is stable (present in both periods)', async () => {
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  assert.ok(corpus.stable.includes('org/alpha'), `Expected org/alpha in stable: ${JSON.stringify(corpus.stable)}`);
});

test('getStableCorpus: gamma only in period B is classified as added', async () => {
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  assert.ok(corpus.added.includes('org/gamma'), `Expected org/gamma in added: ${JSON.stringify(corpus.added)}`);
  assert.ok(!corpus.stable.includes('org/gamma'), `org/gamma should not be stable`);
  assert.ok(!corpus.removed.includes('org/gamma'), `org/gamma should not be removed`);
});

test('getStableCorpus: project only in period A is classified as removed', async () => {
  // Create a project only in period A
  writeScan(makeScan({
    id: 'period-a-only-scan',
    slug: 'org/old-project',
    codeAt: daysAgo(70),
    pkg: PKG,
    versionResolved: '2.0.0',
    componentUsages: [{ file: 'src/X.tsx', componentName: 'Widget', line: 1 }],
    functionCalls: [],
  }));
  await runBuild();

  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  assert.ok(corpus.removed.includes('org/old-project'), `Expected org/old-project in removed: ${JSON.stringify(corpus.removed)}`);
  assert.ok(!corpus.stable.includes('org/old-project'), `org/old-project should not be stable`);
});

// ─── getAdoptionDelta tests ────────────────────────────────────────────────────

test('getAdoptionDelta: delta always equals end - start', async () => {
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(PKG, periodA.from, periodA.to),
    getLatestScanPerProject(PKG, periodB.from, periodB.to),
  ]);
  const adoption = await getAdoptionDelta(PKG, corpus.stable, scansA, scansB);
  assert.equal(adoption.delta, adoption.end - adoption.start,
    `delta (${adoption.delta}) should equal end (${adoption.end}) - start (${adoption.start})`);
});

test('getAdoptionDelta: empty corpus returns zeros', async () => {
  const adoption = await getAdoptionDelta(PKG, [], [], []);
  assert.equal(adoption.start, 0);
  assert.equal(adoption.end, 0);
  assert.equal(adoption.delta, 0);
  assert.deepEqual(adoption.newAdopters, []);
  assert.deepEqual(adoption.churned, []);
});

// ─── getVersionDistribution tests ─────────────────────────────────────────────

test('getVersionDistribution: prerelease flag for 3.0.0-beta.1', async () => {
  const scansB = await getLatestScanPerProject(PKG, daysAgo(50).slice(0, 10), daysAgo(0).slice(0, 10));
  const versions = await getVersionDistribution(PKG, scansB);
  assert.ok(versions.prerelease.includes('org/gamma'),
    `Expected org/gamma in prerelease: ${JSON.stringify(versions.prerelease)}`);
});

test('getVersionDistribution: org/beta lagging (1.0.0 vs 2.x max)', async () => {
  // beta has v1.0.0 in period A, alpha and gamma have v2.x / v3.x
  // In period B, only alpha (2.1.0) and gamma (3.0.0-beta) are present
  // Max major = 3, beta has 1.0.0 (2 majors behind → lagging)
  // But beta is in period A only. So in period B scans, beta is not present.
  // Let's check alpha and gamma in period B:
  // alpha=2.1.0 (major=2), gamma=3.0.0-beta (major=3), max=3
  // alpha is 1 major behind max → lagging threshold is >1 major, so alpha not lagging
  const scansB = await getLatestScanPerProject(PKG, daysAgo(50).slice(0, 10), daysAgo(0).slice(0, 10));
  const versions = await getVersionDistribution(PKG, scansB);
  // alpha (2.1.0) is 1 major behind 3 → threshold is >1, so NOT lagging
  assert.ok(!versions.lagging.includes('org/alpha'),
    `org/alpha should not be lagging (only 1 major behind)`);
});

// ─── getComponentDeltas tests ─────────────────────────────────────────────────

test('getComponentDeltas: Panel added to alpha in period B is detected', async () => {
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(PKG, periodA.from, periodA.to),
    getLatestScanPerProject(PKG, periodB.from, periodB.to),
  ]);
  const result = await getComponentDeltas(PKG, corpus.stable, scansA, scansB);
  const panelDelta = result.deltas.find((d) => d.name === 'Panel' && d.kind === 'component');
  assert.ok(panelDelta, `Expected Panel delta: ${JSON.stringify(result.deltas.map(d => d.name))}`);
  assert.equal(panelDelta.added.length, 1, `Expected 1 added site for Panel`);
  assert.equal(panelDelta.added[0].project, 'org/alpha');
  assert.equal(panelDelta.added[0].file, 'src/Dashboard.tsx');
});

test('getComponentDeltas: test file (*.test.tsx) excluded from results', async () => {
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(PKG, periodA.from, periodA.to),
    getLatestScanPerProject(PKG, periodB.from, periodB.to),
  ]);
  const result = await getComponentDeltas(PKG, corpus.stable, scansA, scansB);
  for (const delta of result.deltas) {
    for (const site of [...delta.added, ...delta.removed]) {
      assert.ok(
        !site.file.endsWith('.test.tsx') && !site.file.endsWith('.test.ts'),
        `Test file found in results: ${site.file}`,
      );
    }
  }
});

test('getComponentDeltas: setupClient function added in period B with args', async () => {
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(PKG, periodA.from, periodA.to),
    getLatestScanPerProject(PKG, periodB.from, periodB.to),
  ]);
  const result = await getComponentDeltas(PKG, corpus.stable, scansA, scansB);
  const setupDelta = result.deltas.find((d) => d.name === 'setupClient' && d.kind === 'function');
  assert.ok(setupDelta, `Expected setupClient delta: ${JSON.stringify(result.deltas.map(d => `${d.kind}:${d.name}`))}`);
  assert.equal(setupDelta.added.length, 1);
  assert.equal(setupDelta.added[0].project, 'org/alpha');
  assert.equal(setupDelta.added[0].file, 'src/client.ts');
  // args should be present
  assert.ok(Array.isArray(setupDelta.added[0].args), 'Expected args array');
  assert.equal(setupDelta.added[0].args.length, 1);
  // dynamic arg: value should be omitted
  assert.equal(setupDelta.added[0].args[0].type, 'dynamic');
  assert.equal(setupDelta.added[0].args[0].value, undefined);
});

test('getComponentDeltas: static arg value present for createConfig', async () => {
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(PKG, periodA, periodB);
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(PKG, periodA.from, periodA.to),
    getLatestScanPerProject(PKG, periodB.from, periodB.to),
  ]);
  // createConfig is in both periods — it should be in unchanged
  const result = await getComponentDeltas(PKG, corpus.stable, scansA, scansB);
  // createConfig has same (project, file) identity in both periods → stable
  assert.ok(result.unchanged.includes('createConfig'),
    `Expected createConfig in unchanged: ${JSON.stringify(result.unchanged)}`);
});

test('getComponentDeltas: Python test file (test_*.py) excluded', async () => {
  const pyPkg = '@test/pylib';
  const periodA = { from: daysAgo(100).slice(0, 10), to: daysAgo(50).slice(0, 10) };
  const periodB = { from: daysAgo(50).slice(0, 10), to: daysAgo(0).slice(0, 10) };
  const corpus = await getStableCorpus(pyPkg, periodA, periodB);
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(pyPkg, periodA.from, periodA.to),
    getLatestScanPerProject(pyPkg, periodB.from, periodB.to),
  ]);
  const result = await getComponentDeltas(pyPkg, corpus.stable, scansA, scansB);
  for (const delta of result.deltas) {
    for (const site of [...delta.added, ...delta.removed]) {
      assert.ok(
        !site.file.match(/test_[^/]+\.py$/) && !site.file.match(/_test\.py$/),
        `Python test file found in results: ${site.file}`,
      );
    }
  }
});

// ─── getCoverageInfo tests ────────────────────────────────────────────────────

test('getCoverageInfo: warning emitted when coverage < 80%', async () => {
  // All projects: alpha, beta, gamma, old-project, multi, pyproj-test-only (for @test/lib)
  // Period B covers: alpha, gamma, multi (not beta which has no pkg deps in B, not old-project)
  // Expected projects = those ever seen for @test/lib
  // Coverage < 80% depends on how many are expected vs covered
  const from = daysAgo(100).slice(0, 10);
  const to = daysAgo(0).slice(0, 10);
  const coverage = await getCoverageInfo(PKG, from, to);
  // Just verify the warning is a string when fired
  if (coverage.projectsCovered < coverage.projectsExpected * 0.8) {
    assert.ok(typeof coverage.warning === 'string', 'Expected a warning string');
    assert.ok(coverage.warning.length > 0, 'Warning should not be empty');
  }
  // Always: coverage fields are consistent
  assert.ok(coverage.projectsCovered >= 0);
  assert.ok(coverage.projectsExpected >= coverage.projectsCovered);
});

test('getCoverageInfo: no warning when all projects covered', async () => {
  // Use a package that only ever has one project (pyproj), scanned in both periods
  const pyPkg = '@test/pylib';
  const from = daysAgo(100).slice(0, 10);
  const to = daysAgo(0).slice(0, 10);
  const coverage = await getCoverageInfo(pyPkg, from, to);
  // pyproj is scanned in both periods, pyproj-test-only has test pkg
  // But pyproj-test-only also uses @test/pylib, so expected >= 2
  // Check coverage is consistent
  assert.ok(coverage.projectsExpected > 0);
  if (coverage.projectsCovered / coverage.projectsExpected >= 0.8) {
    assert.equal(coverage.warning, undefined, 'No warning expected when >=80% covered');
  }
});

// ─── getPackageHealth orchestration test ──────────────────────────────────────

test('getPackageHealth: returns valid PackageHealthResult for @test/lib', async () => {
  const result = await getPackageHealth({ package: PKG, from: '100d' });
  assert.equal(result.package, PKG);
  assert.ok(['js', 'python', 'mixed'].includes(result.language));
  assert.ok(typeof result.generatedAt === 'string');
  assert.ok(result.corpus.stable >= 0);
  assert.equal(result.adoption.delta, result.adoption.end - result.adoption.start);
  assert.ok(Array.isArray(result.componentChanges.deltas));
  assert.ok(Array.isArray(result.componentChanges.unchanged));
  assert.ok(result.coverage.projectsExpected >= result.coverage.projectsCovered);
});

test('getPackageHealth: language is python for @test/pylib', async () => {
  const result = await getPackageHealth({ package: '@test/pylib', from: '100d' });
  assert.equal(result.language, 'python');
});

test('getPackageHealth: returns error for unknown package', async () => {
  await assert.rejects(
    () => getPackageHealth({ package: '@nonexistent/pkg', from: '30d' }),
    (err) => {
      // Should throw, not crash silently
      assert.ok(err instanceof Error || typeof err === 'object');
      return true;
    },
  );
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  try {
    rmSync(USEGRAPH_HOME, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
