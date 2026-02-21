/**
 * Tests for src/analyzer/project-identity.ts
 *
 * Requires: dist/ to be built (pnpm build) before running.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { computeProjectSlug, parseRemoteUrl } = require('../dist/analyzer/project-identity');

// ─── parseRemoteUrl unit tests ────────────────────────────────────────────────

test('parseRemoteUrl handles HTTPS URL with .git suffix', () => {
  const result = parseRemoteUrl('https://github.com/org/repo.git');
  assert.equal(result, 'github.com/org/repo');
});

test('parseRemoteUrl handles HTTPS URL without .git suffix', () => {
  const result = parseRemoteUrl('https://github.com/org/repo');
  assert.equal(result, 'github.com/org/repo');
});

test('parseRemoteUrl handles SSH SCP-style URL with .git suffix', () => {
  const result = parseRemoteUrl('git@github.com:org/repo.git');
  assert.equal(result, 'github.com/org/repo');
});

test('parseRemoteUrl handles SSH SCP-style URL without .git suffix', () => {
  const result = parseRemoteUrl('git@github.com:org/repo');
  assert.equal(result, 'github.com/org/repo');
});

test('parseRemoteUrl handles SSH protocol URL', () => {
  const result = parseRemoteUrl('ssh://git@github.com/org/repo.git');
  assert.equal(result, 'github.com/org/repo');
});

test('parseRemoteUrl returns null for unrecognised format', () => {
  const result = parseRemoteUrl('not-a-url');
  assert.equal(result, null);
});

// ─── computeProjectSlug — package.json fallback ───────────────────────────────

test('computeProjectSlug uses package.json name', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-package' }), 'utf-8');
    const slug = computeProjectSlug(root);
    assert.equal(slug, 'my-package');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeProjectSlug uses scoped package.json name unchanged', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@myorg/ui' }), 'utf-8');
    const slug = computeProjectSlug(root);
    assert.equal(slug, '@myorg/ui');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeProjectSlug falls through to basename when package.json name is empty', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '' }), 'utf-8');
    const slug = computeProjectSlug(root);
    // Should be the basename since name is empty
    assert.equal(slug, require('path').basename(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeProjectSlug falls through to basename when package.json is malformed', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'package.json'), 'NOT_JSON', 'utf-8');
    const slug = computeProjectSlug(root);
    assert.equal(slug, require('path').basename(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeProjectSlug falls through to basename when no package.json and no git', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    // No package.json, no git repo
    const slug = computeProjectSlug(root);
    assert.equal(slug, require('path').basename(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── computeProjectSlug — git remote fallback ─────────────────────────────────

function initGitRepo(dir, remoteUrl) {
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', dir], { encoding: 'utf-8' });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remoteUrl], { encoding: 'utf-8' });
}

test('computeProjectSlug uses HTTPS git remote URL', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  try {
    initGitRepo(root, 'https://github.com/org/repo.git');
    const slug = computeProjectSlug(root);
    assert.equal(slug, 'github.com/org/repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeProjectSlug uses SSH git remote URL', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  try {
    initGitRepo(root, 'git@github.com:org/repo.git');
    const slug = computeProjectSlug(root);
    assert.equal(slug, 'github.com/org/repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeProjectSlug appends monorepo subpath when projectPath is a subdirectory', () => {
  const root = join(tmpdir(), `usegraph-id-test-${randomUUID()}`);
  const subDir = join(root, 'packages', 'ui');
  try {
    initGitRepo(root, 'https://github.com/myorg/mono.git');
    mkdirSync(subDir, { recursive: true });
    const slug = computeProjectSlug(subDir);
    assert.equal(slug, 'github.com/myorg/mono/packages/ui');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
