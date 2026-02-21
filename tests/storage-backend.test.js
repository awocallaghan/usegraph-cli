/**
 * Tests for the StorageBackend abstraction:
 *   src/storage/backend.ts
 *   src/storage/filesystem.ts
 *   src/storage/index.ts
 *
 * Requires: dist/ to be built (pnpm build) before running.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');
const { randomUUID } = require('node:crypto');

const { FilesystemBackend, GLOBAL_STORE_ROOT } = require('../dist/storage/filesystem');
const { createStorageBackend } = require('../dist/storage/index');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(extra = {}) {
  return {
    targetPackages: [],
    include: ['**/*.ts', '**/*.tsx'],
    exclude: ['**/node_modules/**'],
    outputDir: '',
    ...extra,
  };
}

function makeScanResult(overrides = {}) {
  return {
    id: randomUUID(),
    projectPath: '/fake/project',
    projectName: 'fake-project',
    projectSlug: 'fake-project',
    scannedAt: new Date().toISOString(),
    targetPackages: [],
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
    ...overrides,
  };
}

// ─── FilesystemBackend.resolveDir tests ───────────────────────────────────────

test('resolveDir: --output flag returns project-relative path', () => {
  const projectPath = '/home/user/myapp';
  const slug = 'github.com/org/myapp';
  const config = makeConfig();

  const dir = FilesystemBackend.resolveDir(projectPath, slug, '.usegraph', config);
  assert.equal(dir, require('path').resolve(projectPath, '.usegraph'));
});

test('resolveDir: config.outputDir returns project-relative path', () => {
  const projectPath = '/home/user/myapp';
  const slug = 'github.com/org/myapp';
  const config = makeConfig({ outputDir: '.usegraph' });

  const dir = FilesystemBackend.resolveDir(projectPath, slug, undefined, config);
  assert.equal(dir, require('path').resolve(projectPath, '.usegraph'));
});

test('resolveDir: empty config.outputDir returns global store path', () => {
  const projectPath = '/home/user/myapp';
  const slug = 'my-pkg';
  const config = makeConfig({ outputDir: '' });

  const dir = FilesystemBackend.resolveDir(projectPath, slug, undefined, config);
  assert.equal(dir, join(homedir(), '.usegraph', 'my-pkg'));
});

test('resolveDir: multi-component slug creates nested directories under GLOBAL_STORE_ROOT', () => {
  const projectPath = '/home/user/myapp';
  const slug = 'github.com/org/repo';
  const config = makeConfig({ outputDir: '' });

  const dir = FilesystemBackend.resolveDir(projectPath, slug, undefined, config);
  assert.equal(dir, join(homedir(), '.usegraph', 'github.com', 'org', 'repo'));
});

test('GLOBAL_STORE_ROOT is ~/.usegraph', () => {
  assert.equal(GLOBAL_STORE_ROOT, join(homedir(), '.usegraph'));
});

// ─── FilesystemBackend instance tests ────────────────────────────────────────

test('backend.save() + backend.loadLatest() round-trip', () => {
  const tmpDir = join(tmpdir(), `usegraph-backend-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const backend = new FilesystemBackend(tmpDir);
    const result = makeScanResult({ id: randomUUID() });

    backend.save(result);

    const loaded = backend.loadLatest();
    assert.ok(loaded, 'loadLatest should return a result after save');
    assert.equal(loaded.id, result.id, 'loaded id should match saved id');
    assert.equal(loaded.projectSlug, result.projectSlug);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backend.list() returns scan UUIDs', () => {
  const tmpDir = join(tmpdir(), `usegraph-backend-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const backend = new FilesystemBackend(tmpDir);
    assert.deepEqual(backend.list(), [], 'empty dir should return empty list');

    const r1 = makeScanResult({ id: randomUUID() });
    const r2 = makeScanResult({ id: randomUUID() });
    backend.save(r1);
    backend.save(r2);

    const ids = backend.list();
    assert.equal(ids.length, 2, 'should list two scan IDs');
    assert.ok(ids.includes(r1.id), 'should include first scan ID');
    assert.ok(ids.includes(r2.id), 'should include second scan ID');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('backend.getCacheDir() returns the storage directory', () => {
  const tmpDir = join(tmpdir(), `usegraph-backend-test-${randomUUID()}`);
  const backend = new FilesystemBackend(tmpDir);
  assert.equal(backend.getCacheDir(), tmpDir);
});

test('backend.load() retrieves a specific scan by ID', () => {
  const tmpDir = join(tmpdir(), `usegraph-backend-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const backend = new FilesystemBackend(tmpDir);
    const result = makeScanResult({ id: randomUUID() });
    backend.save(result);

    const loaded = backend.load(result.id);
    assert.ok(loaded, 'load by ID should return the result');
    assert.equal(loaded.id, result.id);

    const missing = backend.load('nonexistent-id');
    assert.equal(missing, null, 'load of missing ID should return null');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── createStorageBackend factory test ───────────────────────────────────────

test('createStorageBackend returns a working FilesystemBackend', () => {
  const tmpDir = join(tmpdir(), `usegraph-backend-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    // Use explicit --output so we control where it writes
    const backend = createStorageBackend(tmpDir, 'test-slug', { output: tmpDir }, makeConfig());
    assert.equal(backend.getCacheDir(), tmpDir);

    const result = makeScanResult({ id: randomUUID() });
    backend.save(result);
    const loaded = backend.loadLatest();
    assert.ok(loaded);
    assert.equal(loaded.id, result.id);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
