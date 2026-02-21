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

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');

const { scanProject } = require('../dist/analyzer');
const { saveScanResult, loadLatestScanResult, loadFileCache } = require('../dist/storage');

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

const { writeDefaultConfig, loadConfig } = require('../dist/config');

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
