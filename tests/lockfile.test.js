/**
 * Tests for src/analyzer/lockfile.ts — parseSemver + NpmLockfileParser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSemver, npmLockfileParser } = require('../dist/analyzer/lockfile');

// ─── parseSemver ──────────────────────────────────────────────────────────────

test('parseSemver: stable version', () => {
  const r = parseSemver('18.2.0');
  assert.equal(r.versionMajor, 18);
  assert.equal(r.versionMinor, 2);
  assert.equal(r.versionPatch, 0);
  assert.equal(r.versionPrerelease, null);
  assert.equal(r.versionIsPrerelease, false);
});

test('parseSemver: prerelease with dash label', () => {
  const r = parseSemver('1.0.0-beta.3');
  assert.equal(r.versionMajor, 1);
  assert.equal(r.versionMinor, 0);
  assert.equal(r.versionPatch, 0);
  assert.equal(r.versionPrerelease, 'beta.3');
  assert.equal(r.versionIsPrerelease, true);
});

test('parseSemver: prerelease with complex label', () => {
  const r = parseSemver('2.1.0-acme-fork.3');
  assert.equal(r.versionPrerelease, 'acme-fork.3');
  assert.equal(r.versionIsPrerelease, true);
});

test('parseSemver: build metadata only (no prerelease)', () => {
  const r = parseSemver('1.0.0+build.42');
  assert.equal(r.versionMajor, 1);
  assert.equal(r.versionMinor, 0);
  assert.equal(r.versionPatch, 0);
  assert.equal(r.versionPrerelease, null);
  assert.equal(r.versionIsPrerelease, false);
});

test('parseSemver: prerelease + build metadata', () => {
  const r = parseSemver('1.0.0-rc.1+build.5');
  assert.equal(r.versionPrerelease, 'rc.1');
  assert.equal(r.versionIsPrerelease, true);
});

test('parseSemver: unrecognised format returns zeros', () => {
  const r = parseSemver('not-a-version');
  assert.equal(r.versionMajor, 0);
  assert.equal(r.versionMinor, 0);
  assert.equal(r.versionPatch, 0);
  assert.equal(r.versionIsPrerelease, false);
});

test('parseSemver: version with leading zeros in patch', () => {
  const r = parseSemver('4.17.21');
  assert.equal(r.versionMajor, 4);
  assert.equal(r.versionMinor, 17);
  assert.equal(r.versionPatch, 21);
  assert.equal(r.versionIsPrerelease, false);
});

// ─── NpmLockfileParser — v1 ──────────────────────────────────────────────────

const v1Lockfile = JSON.stringify({
  name: 'my-project',
  lockfileVersion: 1,
  requires: true,
  dependencies: {
    react: {
      version: '18.2.0',
      requires: { 'loose-envify': '^1.1.0' },
    },
    'react-dom': {
      version: '18.2.0',
      requires: { 'loose-envify': '^1.1.0', react: '^18.2.0', scheduler: '^0.23.0' },
    },
    lodash: {
      version: '4.17.21',
    },
    // Package with nested dep (different version of react inside)
    'some-legacy-package': {
      version: '1.0.0',
      dependencies: {
        react: {
          version: '16.14.0', // nested — should NOT override top-level react@18.2.0
        },
      },
    },
  },
});

test('NpmLockfileParser v1: parses top-level dependencies', () => {
  const result = npmLockfileParser.parse(v1Lockfile);
  assert.ok(result.has('react'), 'should have react');
  assert.equal(result.get('react').versionResolved, '18.2.0');
  assert.equal(result.get('react').versionMajor, 18);
  assert.ok(result.has('react-dom'), 'should have react-dom');
  assert.ok(result.has('lodash'), 'should have lodash');
  assert.equal(result.get('lodash').versionResolved, '4.17.21');
});

test('NpmLockfileParser v1: top-level version wins over nested version', () => {
  const result = npmLockfileParser.parse(v1Lockfile);
  // Top-level react@18.2.0 should win; nested @16.14.0 should NOT overwrite it
  assert.equal(result.get('react').versionResolved, '18.2.0');
});

test('NpmLockfileParser v1: nested packages are still included (under their own key)', () => {
  const result = npmLockfileParser.parse(v1Lockfile);
  // some-legacy-package itself is included
  assert.ok(result.has('some-legacy-package'), 'should have some-legacy-package');
  assert.equal(result.get('some-legacy-package').versionResolved, '1.0.0');
});

// ─── NpmLockfileParser — v2 ──────────────────────────────────────────────────

const v2Lockfile = JSON.stringify({
  name: 'my-project',
  lockfileVersion: 2,
  packages: {
    '': {
      name: 'my-project',
      dependencies: { react: '^18.2.0' },
    },
    'node_modules/react': {
      version: '18.2.0',
      resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
      integrity: 'sha512-abc',
    },
    'node_modules/react-dom': {
      version: '18.2.0',
    },
    'node_modules/@types/react': {
      version: '18.0.28',
    },
    // Nested dep — should be skipped (top-level key is "some-old-lib/node_modules/react")
    'node_modules/some-old-lib': {
      version: '1.0.0',
    },
    'node_modules/some-old-lib/node_modules/react': {
      version: '16.14.0', // nested — should not appear as a top-level "react"
    },
  },
});

test('NpmLockfileParser v2: parses node_modules entries', () => {
  const result = npmLockfileParser.parse(v2Lockfile);
  assert.ok(result.has('react'), 'should have react');
  assert.equal(result.get('react').versionResolved, '18.2.0');
  assert.ok(result.has('react-dom'), 'should have react-dom');
});

test('NpmLockfileParser v2: root ("") entry is skipped', () => {
  const result = npmLockfileParser.parse(v2Lockfile);
  assert.ok(!result.has(''), 'empty root entry should not be in result');
  assert.ok(!result.has('my-project'), 'root project name should not appear');
});

test('NpmLockfileParser v2: scoped packages are parsed correctly', () => {
  const result = npmLockfileParser.parse(v2Lockfile);
  assert.ok(result.has('@types/react'), 'should have @types/react');
  assert.equal(result.get('@types/react').versionResolved, '18.0.28');
  assert.equal(result.get('@types/react').versionMajor, 18);
});

test('NpmLockfileParser v2: nested hoisted entries are skipped', () => {
  const result = npmLockfileParser.parse(v2Lockfile);
  // The "some-old-lib/node_modules/react" should NOT overwrite top-level "react"
  assert.equal(
    result.get('react').versionResolved,
    '18.2.0',
    'nested react@16 should not override top-level react@18',
  );
});

// ─── NpmLockfileParser — v3 ──────────────────────────────────────────────────

const v3Lockfile = JSON.stringify({
  name: 'my-project',
  lockfileVersion: 3,
  packages: {
    '': { name: 'my-project' },
    'node_modules/chalk': {
      version: '5.3.0',
    },
    'node_modules/commander': {
      version: '12.1.0',
    },
  },
});

test('NpmLockfileParser v3: parsed the same as v2', () => {
  const result = npmLockfileParser.parse(v3Lockfile);
  assert.ok(result.has('chalk'), 'should have chalk');
  assert.equal(result.get('chalk').versionResolved, '5.3.0');
  assert.equal(result.get('chalk').versionMajor, 5);
  assert.equal(result.get('chalk').versionMinor, 3);
  assert.ok(result.has('commander'), 'should have commander');
});

// ─── NpmLockfileParser — prerelease versions ─────────────────────────────────

test('NpmLockfileParser: prerelease version is parsed correctly', () => {
  const lockfile = JSON.stringify({
    lockfileVersion: 2,
    packages: {
      '': {},
      'node_modules/my-lib': {
        version: '2.0.0-beta.1',
      },
    },
  });
  const result = npmLockfileParser.parse(lockfile);
  const dep = result.get('my-lib');
  assert.ok(dep, 'should have my-lib');
  assert.equal(dep.versionResolved, '2.0.0-beta.1');
  assert.equal(dep.versionMajor, 2);
  assert.equal(dep.versionPrerelease, 'beta.1');
  assert.equal(dep.versionIsPrerelease, true);
});

// ─── NpmLockfileParser — edge cases ──────────────────────────────────────────

test('NpmLockfileParser: returns empty map for invalid JSON', () => {
  const result = npmLockfileParser.parse('not valid json {{');
  assert.equal(result.size, 0);
});

test('NpmLockfileParser: returns empty map for empty string', () => {
  const result = npmLockfileParser.parse('');
  assert.equal(result.size, 0);
});

test('NpmLockfileParser: skips packages without version field', () => {
  const lockfile = JSON.stringify({
    lockfileVersion: 2,
    packages: {
      '': {},
      'node_modules/has-version': { version: '1.0.0' },
      'node_modules/no-version': { resolved: 'https://example.com/pkg.tgz' },
    },
  });
  const result = npmLockfileParser.parse(lockfile);
  assert.ok(result.has('has-version'));
  assert.ok(!result.has('no-version'), 'package without version should be skipped');
});

test('NpmLockfileParser: result entries have all required fields', () => {
  const lockfile = JSON.stringify({
    lockfileVersion: 2,
    packages: {
      '': {},
      'node_modules/express': { version: '4.18.2' },
    },
  });
  const result = npmLockfileParser.parse(lockfile);
  const dep = result.get('express');
  assert.ok(dep, 'should have express');
  assert.equal(dep.name, 'express');
  assert.equal(dep.versionResolved, '4.18.2');
  assert.equal(typeof dep.versionMajor, 'number');
  assert.equal(typeof dep.versionMinor, 'number');
  assert.equal(typeof dep.versionPatch, 'number');
  assert.equal(typeof dep.versionIsPrerelease, 'boolean');
  // versionPrerelease can be null or string — both are valid for a non-prerelease
  assert.equal(dep.versionPrerelease, null);
});
