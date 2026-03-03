/**
 * Integration tests for src/analyzer/scanner.ts + src/storage.ts
 *
 * Creates a temporary project on disk, runs scanProject(), and asserts on
 * the full scan result including:
 *  - file counts
 *  - component usages with props
 *  - function call tracking
 *  - per-package summaries
 *  - incremental file caching (second scan reuses cached entries)
 *  - storage round-trip (save + load latest)
 *
 * Requires: dist/ to be built (pnpm build) before running.
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { scanProject } from '../dist/analyzer/index.js';
import { saveScanResult, loadLatestScanResult, loadFileCache } from '../dist/storage.js';
import { writeDefaultConfig, loadConfig } from '../dist/config.js';
import { initTestRepo, cleanupTestRepo } from './helpers/git.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

/** A TSX file using two components and multiple props from '@myds/button' */
const APP_TSX = `
import { Button, Chip } from '@myds/button';
import { useState } from 'react';

function App() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="primary" size="large" onClick={setOpen}>Click me</Button>
      <Button variant="secondary" disabled={true} />
      <Chip label="tag" color="blue" />
    </div>
  );
}
export default App;
`;

/** A TS file that calls two functions from '@myds/utils' */
const UTILS_TS = `
import { formatDate, parseDate } from '@myds/utils';

export function process(raw) {
  const formatted = formatDate(raw, 'MM/DD/YYYY');
  const parsed    = parseDate('01/01/2024');
  return { formatted, parsed };
}
`;

/** A TS file that imports only from 'react' — no target packages */
const OTHER_TS = `
import { useEffect, useRef } from 'react';

export function useTimer(cb) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current = setInterval(cb, 1000);
    return () => clearInterval(ref.current);
  }, [cb]);
}
`;

// ─── Config helpers ───────────────────────────────────────────────────────────

function makeConfig(extra = {}) {
  return {
    targetPackages: [],
    include: ['**/*.ts', '**/*.tsx'],
    exclude: ['**/node_modules/**'],
    outputDir: '.usegraph',
    ...extra,
  };
}

// ─── Temp project factory ─────────────────────────────────────────────────────

/**
 * Creates a temporary directory tree:
 *   <tmpdir>/usegraph-test-<uuid>/
 *     src/
 *       App.tsx
 *       utils.ts
 *       other.ts
 * Returns the project root path.
 */
function createTempProject() {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  const src  = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'App.tsx'),   APP_TSX,   'utf-8');
  writeFileSync(join(src, 'utils.ts'),  UTILS_TS,  'utf-8');
  writeFileSync(join(src, 'other.ts'),  OTHER_TS,  'utf-8');
  return root;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('scanProject returns correct file count', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config: makeConfig(),
    });
    assert.equal(result.fileCount, 3, 'should find all three source files');
    assert.equal(result.summary.totalFilesScanned, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanProject detects component usages from target package', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config: makeConfig(),
    });

    const { byPackage } = result.summary;

    assert.ok(byPackage['@myds/button'], '@myds/button should be in byPackage');
    const btnPkg = byPackage['@myds/button'];

    // 2 x Button + 1 x Chip = 3 component usages
    assert.equal(btnPkg.totalComponentUsages, 3, 'should count 3 component usages');
    assert.ok(btnPkg.components.includes('Button'), 'should list Button');
    assert.ok(btnPkg.components.includes('Chip'),   'should list Chip');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanProject collects props on component usages', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });

    // Find all Button usages
    const allUsages = result.files.flatMap((f) => f.componentUsages);
    const buttonUsages = allUsages.filter((u) => u.componentName === 'Button');
    assert.ok(buttonUsages.length >= 2, 'should find at least 2 Button usages');

    // First Button should have variant="primary", size="large", onClick props
    const primary = buttonUsages.find((u) =>
      u.props.some((p) => p.name === 'variant' && p.value === 'primary'),
    );
    assert.ok(primary, 'should find the primary Button usage');

    const variantProp = primary.props.find((p) => p.name === 'variant');
    const sizeProp    = primary.props.find((p) => p.name === 'size');
    assert.ok(variantProp, 'should have variant prop');
    assert.ok(sizeProp,    'should have size prop');
    assert.equal(variantProp.value, 'primary');
    assert.equal(sizeProp.value,    'large');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanProject detects function calls from target package', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config: makeConfig(),
    });

    const { byPackage } = result.summary;
    assert.ok(byPackage['@myds/utils'], '@myds/utils should be in byPackage');
    const utilsPkg = byPackage['@myds/utils'];

    assert.equal(utilsPkg.totalFunctionCalls, 2, 'should count 2 function calls');
    assert.ok(utilsPkg.functions.includes('formatDate'), 'should list formatDate');
    assert.ok(utilsPkg.functions.includes('parseDate'),  'should list parseDate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanProject captures string argument to function call', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/utils'],
      config: makeConfig(),
    });

    const allCalls = result.files.flatMap((f) => f.functionCalls);
    const parseDateCall = allCalls.find((c) => c.functionName === 'parseDate');
    assert.ok(parseDateCall, 'should find parseDate call');
    assert.ok(parseDateCall.args.length >= 1, 'parseDate should have at least one argument');
    const firstArg = parseDateCall.args[0];
    assert.equal(firstArg.type,  'string', 'first arg should be a string literal');
    assert.equal(firstArg.value, '01/01/2024');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanProject filesWithTargetUsage count is correct', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config: makeConfig(),
    });

    // App.tsx uses @myds/button, utils.ts uses @myds/utils — 2 files with usage
    // other.ts only uses 'react' which is not a target package
    assert.equal(result.summary.filesWithTargetUsage, 2,
      'only files using target packages should be counted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanProject result has expected metadata fields', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });

    assert.ok(result.id,          'should have an id');
    assert.ok(result.projectPath, 'should have projectPath');
    assert.ok(result.projectName, 'should have projectName');
    assert.ok(result.projectSlug, 'should have projectSlug');
    assert.ok(result.scannedAt,   'should have scannedAt ISO string');
    assert.ok(new Date(result.scannedAt).getFullYear() >= 2024,
      'scannedAt should be a valid recent date');
    assert.deepEqual(result.targetPackages, ['@myds/button']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Incremental cache tests ──────────────────────────────────────────────────

test('second scan with cacheDir gets all cache hits', async () => {
  const root     = createTempProject();
  const cacheDir = join(root, '.usegraph');
  mkdirSync(cacheDir, { recursive: true });
  try {
    // First scan — cold cache
    const first = await scanProject({
      projectPath:    root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config:         makeConfig(),
      cacheDir,
    });
    assert.equal(first.cacheHits ?? 0, 0, 'cold scan should have 0 cache hits');

    // Second scan — warm cache, files unchanged
    const second = await scanProject({
      projectPath:    root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config:         makeConfig(),
      cacheDir,
    });
    assert.equal(second.cacheHits, first.fileCount,
      'second scan should hit cache for every file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changing target packages invalidates the file cache', async () => {
  const root     = createTempProject();
  const cacheDir = join(root, '.usegraph');
  mkdirSync(cacheDir, { recursive: true });
  try {
    // Warm the cache with one set of packages
    await scanProject({
      projectPath:    root,
      targetPackages: ['@myds/button'],
      config:         makeConfig(),
      cacheDir,
    });

    // Scan with a different package set — cache must be invalidated
    const result = await scanProject({
      projectPath:    root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config:         makeConfig(),
      cacheDir,
    });
    assert.equal(result.cacheHits ?? 0, 0,
      'cache should be invalidated when target packages change');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache file is written to cacheDir after scan', async () => {
  const root     = createTempProject();
  const cacheDir = join(root, '.usegraph');
  mkdirSync(cacheDir, { recursive: true });
  try {
    await scanProject({
      projectPath:    root,
      targetPackages: ['@myds/button'],
      config:         makeConfig(),
      cacheDir,
    });
    assert.ok(
      existsSync(join(cacheDir, 'file-cache.json')),
      'file-cache.json should be written to cacheDir',
    );
    // The cache should have entries for all scanned files
    const cache = loadFileCache(cacheDir, ['@myds/button']);
    assert.equal(Object.keys(cache.entries).length, 3,
      'cache should have one entry per scanned file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Storage round-trip tests ─────────────────────────────────────────────────

test('saveScanResult + loadLatestScanResult round-trip', async () => {
  const root      = createTempProject();
  const outputDir = join(root, '.usegraph');
  mkdirSync(outputDir, { recursive: true });
  try {
    const result = await scanProject({
      projectPath:    root,
      targetPackages: ['@myds/button', '@myds/utils'],
      config:         makeConfig(),
    });

    saveScanResult(outputDir, result);

    const loaded = loadLatestScanResult(outputDir);
    assert.ok(loaded, 'loadLatestScanResult should return a result');
    assert.equal(loaded.id, result.id, 'loaded scan id should match');
    assert.equal(loaded.fileCount, result.fileCount);
    assert.equal(
      loaded.summary.totalComponentUsages,
      result.summary.totalComponentUsages,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadLatestScanResult returns null when no scan exists', () => {
  const root      = join(tmpdir(), `usegraph-test-empty-${randomUUID()}`);
  const outputDir = join(root, '.usegraph');
  mkdirSync(outputDir, { recursive: true });
  try {
    const loaded = loadLatestScanResult(outputDir);
    assert.equal(loaded, null, 'should return null when no latest.json exists');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Regression: src/-only include patterns miss files outside src/ ────────────

/**
 * Reproduces the bug where `usegraph init` created configs with `src/**` patterns
 * that failed to find any files in projects whose source lives in pages/, components/,
 * or other top-level directories (e.g. Next.js projects).
 */
test('scanProject with src-only include patterns finds no files outside src/', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(join(root, 'pages'), { recursive: true });
  mkdirSync(join(root, 'components'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.tsx'), APP_TSX, 'utf-8');
  writeFileSync(join(root, 'components', 'Button.tsx'), OTHER_TS, 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig({ include: ['src/**/*.ts', 'src/**/*.tsx'] }),
    });
    assert.equal(result.fileCount, 0,
      'src/-only include patterns should find 0 files when project has no src/ dir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanProject with broad include patterns finds files outside src/', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(join(root, 'pages'), { recursive: true });
  mkdirSync(join(root, 'components'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.tsx'), APP_TSX, 'utf-8');
  writeFileSync(join(root, 'components', 'Button.tsx'), OTHER_TS, 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(), // uses **/*.ts, **/*.tsx — broad patterns
    });
    assert.equal(result.fileCount, 2,
      'broad include patterns should find files in pages/ and components/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeDefaultConfig creates config with broad include patterns', () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeDefaultConfig(root);
    const config = loadConfig(root);
    assert.ok(
      config.include.every((p) => !p.startsWith('src/')),
      'init config should not restrict patterns to src/ — would miss Next.js pages/, components/, etc.',
    );
    assert.ok(
      config.include.some((p) => p.startsWith('**/')),
      'init config should use ** glob patterns to find files in any directory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Git-aware scanning tests ─────────────────────────────────────────────────

test('git-aware scanning: codeAt is null when not in a git repo', async () => {
  const root = createTempProject();
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });
    assert.equal(result.codeAt, null, 'codeAt should be null outside a git repo');
    assert.equal(result.commitSha, null, 'commitSha should be null outside a git repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git-aware scanning: codeAt is set when in a git repo', async () => {
  const root = createTempProject();
  try {
    await initTestRepo(root);
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });
    assert.ok(result.codeAt, 'codeAt should be set when in a git repo');
    assert.ok(!isNaN(new Date(result.codeAt).getTime()), 'codeAt should be a valid date');
  } finally {
    cleanupTestRepo(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('git-aware scanning: id equals commitSha when in a git repo', async () => {
  const root = createTempProject();
  try {
    await initTestRepo(root);
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });
    assert.ok(result.commitSha, 'commitSha should be set when in a git repo');
    assert.equal(result.id, result.commitSha, 'id should equal commitSha when in a git repo');
  } finally {
    cleanupTestRepo(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('git-aware scanning: same commit produces same id on re-scan', async () => {
  const root = createTempProject();
  try {
    await initTestRepo(root);
    const first = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });
    const second = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });
    assert.equal(first.id, second.id, 'same commit should produce same id');
    assert.equal(first.id, first.commitSha, 'id should be the commit SHA');
  } finally {
    cleanupTestRepo(root);
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Webpack detection edge cases ─────────────────────────────────────────────

test('webpack detected when config has non-standard name (e.g. webpack.config.prod.js)', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app', devDependencies: { webpack: '^5.0.0' } }), 'utf-8');
  writeFileSync(join(root, 'webpack.config.prod.js'), 'module.exports = {};', 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: [],
      config: makeConfig(),
    });
    assert.equal(result.meta?.tooling.buildTool, 'webpack',
      'webpack should be detected from webpack.config.prod.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('webpack detected when config is in a subdirectory (e.g. frontend/webpack.config.js)', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(join(root, 'frontend'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app', devDependencies: { webpack: '^5.0.0' } }), 'utf-8');
  writeFileSync(join(root, 'frontend', 'webpack.config.js'), 'module.exports = {};', 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: [],
      config: makeConfig(),
    });
    assert.equal(result.meta?.tooling.buildTool, 'webpack',
      'webpack should be detected from frontend/webpack.config.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('webpack detected when config is non-standard name in a subdirectory (e.g. config/webpack.config.prod.js)', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app', devDependencies: { webpack: '^5.0.0' } }), 'utf-8');
  writeFileSync(join(root, 'config', 'webpack.config.prod.js'), 'module.exports = {};', 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: [],
      config: makeConfig(),
    });
    assert.equal(result.meta?.tooling.buildTool, 'webpack',
      'webpack should be detected from config/webpack.config.prod.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Alias import filtering ───────────────────────────────────────────────────

test('excludes alias imports that are not in package.json dependencies', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(join(root, 'src'), { recursive: true });
  // @components is a webpack alias, not in package.json
  const fileWithAlias = `
import { Button } from '@components/Button';
import { useState } from 'react';
export default function App() { return null; }
`;
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'my-app',
    dependencies: { react: '^18.0.0' },
  }), 'utf-8');
  writeFileSync(join(root, 'src', 'App.tsx'), fileWithAlias, 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: [],
      config: makeConfig(),
    });
    const allImports = result.files.flatMap(f => f.imports);
    const sources = allImports.map(i => i.source);
    assert.ok(sources.includes('react'), 'real dep (react) should be in imports');
    assert.ok(!sources.includes('@components/Button'),
      'alias import (@components/Button) should not appear when package.json is present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subpath imports of known packages are included when package.json is present', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  mkdirSync(join(root, 'src'), { recursive: true });
  const fileWithSubpath = `
import { createRoot } from 'react-dom/client';
export default function App() { return null; }
`;
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'my-app',
    dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
  }), 'utf-8');
  writeFileSync(join(root, 'src', 'App.tsx'), fileWithSubpath, 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: [],
      config: makeConfig(),
    });
    const allImports = result.files.flatMap(f => f.imports);
    const sources = allImports.map(i => i.source);
    assert.ok(sources.includes('react-dom/client'),
      'subpath import of a known package (react-dom/client) should be included');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Subdirectory package.json / lockfile detection ───────────────────────────

test('package manager detected when package.json and lockfile are in a subdirectory (frontend/)', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  const frontend = join(root, 'frontend');
  mkdirSync(join(frontend, 'src'), { recursive: true });
  writeFileSync(join(frontend, 'package.json'), JSON.stringify({
    name: 'my-frontend',
    dependencies: { '@myds/button': '^1.0.0', react: '^18.2.0' },
  }), 'utf-8');
  writeFileSync(join(frontend, 'yarn.lock'), '# yarn lockfile v1\n\n"react@^18.2.0":\n  version "18.2.0"\n  resolved "https://registry.npmjs.org/react/-/react-18.2.0.tgz"\n  integrity sha512-stub\n', 'utf-8');
  writeFileSync(join(frontend, 'src', 'App.tsx'), APP_TSX, 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });
    assert.equal(result.meta?.tooling.packageManager, 'yarn',
      'should detect yarn from frontend/yarn.lock');
    assert.ok(result.meta?.packageName === 'my-frontend',
      'should read package name from frontend/package.json');
    const reactDep = result.meta?.dependencies.find(d => d.name === 'react');
    assert.ok(reactDep, 'should list react dependency from frontend/package.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lockfile versions resolved when lockfile is in parent directory (monorepo subpackage)', async () => {
  // Simulate a monorepo where the lockfile lives at the workspace root
  // but the scan is run against a subpackage directory.
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  const pkg = join(root, 'packages', 'ui');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  // Workspace root: pnpm lockfile with resolved react version
  writeFileSync(join(root, 'pnpm-lock.yaml'), `\
lockfileVersion: '9.0'

importers:
  packages/ui:
    dependencies:
      react:
        specifier: ^18.2.0
        version: 18.2.0

packages:

  'react@18.2.0':
    resolution: {integrity: sha512-stub}
    engines: {node: '>=0.10.0'}
`, 'utf-8');
  // Subpackage: its own package.json (no lockfile here)
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: '@acme/ui',
    version: '1.0.0',
    dependencies: { react: '^18.2.0' },
  }), 'utf-8');
  writeFileSync(join(pkg, 'src', 'App.tsx'), APP_TSX, 'utf-8');
  try {
    const result = await scanProject({
      projectPath: pkg,
      targetPackages: ['@myds/button'],
      config: makeConfig(),
    });
    assert.equal(result.meta?.tooling.packageManager, 'pnpm',
      'should detect pnpm from workspace root pnpm-lock.yaml');
    const reactDep = result.meta?.dependencies.find(d => d.name === 'react');
    assert.ok(reactDep, 'should have react dependency');
    assert.equal(reactDep.versionResolved, '18.2.0',
      'should resolve react version from workspace root lockfile');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package manager detected when package.json is in subdirectory and lockfile is also in subdirectory (npm)', async () => {
  const root = join(tmpdir(), `usegraph-test-${randomUUID()}`);
  const frontend = join(root, 'client');
  mkdirSync(join(frontend, 'src'), { recursive: true });
  writeFileSync(join(frontend, 'package.json'), JSON.stringify({
    name: 'my-client',
    dependencies: { react: '^18.2.0' },
  }), 'utf-8');
  writeFileSync(join(frontend, 'package-lock.json'), JSON.stringify({
    name: 'my-client',
    version: '1.0.0',
    lockfileVersion: 2,
    packages: {
      'node_modules/react': { version: '18.2.0' },
    },
  }), 'utf-8');
  writeFileSync(join(frontend, 'src', 'index.ts'), OTHER_TS, 'utf-8');
  try {
    const result = await scanProject({
      projectPath: root,
      targetPackages: [],
      config: makeConfig(),
    });
    assert.equal(result.meta?.tooling.packageManager, 'npm',
      'should detect npm from client/package-lock.json');
    const reactDep = result.meta?.dependencies.find(d => d.name === 'react');
    assert.ok(reactDep, 'should list react dependency from client/package.json');
    assert.equal(reactDep.versionResolved, '18.2.0',
      'should resolve react version from client/package-lock.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Fixture-based subdirectory / monorepo tests ──────────────────────────────

const __fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/org');

test('frontend-subdir fixture: yarn detected and @acme packages resolved', async () => {
  // The fixture has no package.json at the root; everything is under frontend/
  const fixtureRoot = join(__fixtureDir, 'apps/frontend-subdir');
  const result = await scanProject({
    projectPath: fixtureRoot,
    targetPackages: ['@acme/ui', '@acme/utils'],
    config: makeConfig(),
  });

  assert.equal(result.meta?.tooling.packageManager, 'yarn',
    'should detect yarn from frontend/yarn.lock');
  assert.equal(result.meta?.packageName, 'frontend-subdir',
    'should read package name from frontend/package.json');

  const acmeUiDep = result.meta?.dependencies.find(d => d.name === '@acme/ui');
  assert.ok(acmeUiDep, 'should list @acme/ui dependency from frontend/package.json');
  assert.equal(acmeUiDep.versionResolved, '1.2.0',
    'should resolve @acme/ui version from frontend/yarn.lock');

  // Source files in frontend/src/ should be scanned
  assert.ok(result.fileCount >= 2, `expected at least 2 source files, got ${result.fileCount}`);

  // Button component from @acme/ui should be detected
  assert.ok(result.summary.byPackage['@acme/ui'],
    '@acme/ui should appear in the scan summary');
});

test('monorepo-root fixture: pnpm detected at workspace root', async () => {
  // The fixture is a pnpm workspace root with packages/web and packages/ui
  const fixtureRoot = join(__fixtureDir, 'apps/monorepo-root');
  const result = await scanProject({
    projectPath: fixtureRoot,
    targetPackages: ['@acme/ui', '@acme/utils'],
    config: makeConfig(),
  });

  assert.equal(result.meta?.tooling.packageManager, 'pnpm',
    'should detect pnpm from workspace root pnpm-lock.yaml');
  assert.equal(result.meta?.packageName, 'monorepo-root',
    'should read package name from workspace root package.json');
});

test('monorepo-root/packages/web fixture: pnpm detected from workspace root lockfile', async () => {
  // Scanning a monorepo subpackage — the lockfile lives in the workspace root
  const pkgPath = join(__fixtureDir, 'apps/monorepo-root/packages/web');
  const result = await scanProject({
    projectPath: pkgPath,
    targetPackages: ['@acme/ui', '@acme/utils'],
    config: makeConfig(),
  });

  assert.equal(result.meta?.tooling.packageManager, 'pnpm',
    'should detect pnpm by walking up to workspace root pnpm-lock.yaml');
  assert.equal(result.meta?.packageName, '@monorepo/web',
    'should read package name from packages/web/package.json');

  const acmeUiDep = result.meta?.dependencies.find(d => d.name === '@acme/ui');
  assert.ok(acmeUiDep, 'should list @acme/ui from packages/web/package.json');
  assert.equal(acmeUiDep.versionResolved, '1.2.0',
    'should resolve @acme/ui version from workspace root pnpm-lock.yaml');

  // Button and formatDate usages should be detected in packages/web/src/
  assert.ok(result.summary.byPackage['@acme/ui'],
    '@acme/ui should appear in scan summary for packages/web');
  assert.ok(result.summary.byPackage['@acme/utils'],
    '@acme/utils should appear in scan summary for packages/web');
});
