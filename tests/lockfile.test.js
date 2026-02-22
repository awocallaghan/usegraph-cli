/**
 * Tests for src/analyzer/lockfile.ts — parseSemver + NpmLockfileParser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSemver, npmLockfileParser, pnpmLockfileParser, yarnV1LockfileParser, yarnBerryLockfileParser } = require('../dist/analyzer/lockfile');

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

// ─── PnpmLockfileParser — v6 format (pnpm 7/8/9) ─────────────────────────────

const pnpmV6Lockfile = [
  "lockfileVersion: '6.0'",
  '',
  'importers:',
  '  .:',
  '    dependencies:',
  '      react:',
  '        specifier: ^18.2.0',
  '        version: 18.2.0',
  '      react-dom:',
  '        specifier: ^18.2.0',
  '        version: 18.2.0(react@18.2.0)',
  '    devDependencies:',
  "      '@types/react':",
  '        specifier: ^18.0.0',
  '        version: 18.0.28',
  '      lodash:',
  '        specifier: ^4.17.21',
  '        version: 4.17.21',
].join('\n');

test('PnpmLockfileParser v6: parses nested version field', () => {
  const result = pnpmLockfileParser.parse(pnpmV6Lockfile);
  assert.ok(result.has('react'), 'should have react');
  assert.equal(result.get('react').versionResolved, '18.2.0');
  assert.equal(result.get('react').versionMajor, 18);
  assert.ok(result.has('react-dom'), 'should have react-dom');
});

test('PnpmLockfileParser v6: strips peer-dep suffix from version', () => {
  const result = pnpmLockfileParser.parse(pnpmV6Lockfile);
  // react-dom has "(react@18.2.0)" suffix — must be stripped
  assert.equal(result.get('react-dom').versionResolved, '18.2.0');
  assert.equal(result.get('react-dom').versionMajor, 18);
});

test('PnpmLockfileParser v6: parses scoped packages from devDependencies', () => {
  const result = pnpmLockfileParser.parse(pnpmV6Lockfile);
  assert.ok(result.has('@types/react'), 'should have @types/react');
  assert.equal(result.get('@types/react').versionResolved, '18.0.28');
  assert.ok(result.has('lodash'), 'should have lodash');
  assert.equal(result.get('lodash').versionResolved, '4.17.21');
});

// ─── PnpmLockfileParser — v5 monorepo format ─────────────────────────────────

const pnpmV5MonoLockfile = [
  'lockfileVersion: 5.3',
  '',
  'importers:',
  '',
  '  .:',
  '    specifiers:',
  '      react: ^18.0.0',
  '      lodash: ^4.17.21',
  '    dependencies:',
  '      react: 18.2.0',
  '      lodash: 4.17.21',
  '    devDependencies:',
  '      typescript: 5.0.4',
].join('\n');

test('PnpmLockfileParser v5 monorepo: parses direct version values', () => {
  const result = pnpmLockfileParser.parse(pnpmV5MonoLockfile);
  assert.ok(result.has('react'), 'should have react');
  assert.equal(result.get('react').versionResolved, '18.2.0');
  assert.ok(result.has('lodash'), 'should have lodash');
  assert.equal(result.get('lodash').versionResolved, '4.17.21');
});

test('PnpmLockfileParser v5 monorepo: specifiers section is not parsed as versions', () => {
  const result = pnpmLockfileParser.parse(pnpmV5MonoLockfile);
  // lodash should be 4.17.21, NOT "^4.17.21" from specifiers
  assert.equal(result.get('lodash').versionResolved, '4.17.21');
});

test('PnpmLockfileParser v5 monorepo: devDependencies included', () => {
  const result = pnpmLockfileParser.parse(pnpmV5MonoLockfile);
  assert.ok(result.has('typescript'), 'should have typescript');
  assert.equal(result.get('typescript').versionResolved, '5.0.4');
});

// ─── PnpmLockfileParser — v5 single-package (no importers block) ─────────────

const pnpmV5SingleLockfile = [
  'lockfileVersion: 5.3',
  '',
  'specifiers:',
  '  chalk: ^5.0.0',
  '  commander: ^12.0.0',
  '',
  'dependencies:',
  '  chalk: 5.3.0',
  '  commander: 12.1.0',
  '',
  'devDependencies:',
  '  typescript: 5.0.4',
].join('\n');

test('PnpmLockfileParser v5 single-package: parses top-level dependencies', () => {
  const result = pnpmLockfileParser.parse(pnpmV5SingleLockfile);
  assert.ok(result.has('chalk'), 'should have chalk');
  assert.equal(result.get('chalk').versionResolved, '5.3.0');
  assert.equal(result.get('chalk').versionMajor, 5);
  assert.equal(result.get('chalk').versionMinor, 3);
  assert.ok(result.has('commander'), 'should have commander');
});

test('PnpmLockfileParser v5 single-package: specifiers section is skipped', () => {
  const result = pnpmLockfileParser.parse(pnpmV5SingleLockfile);
  // chalk should resolve to 5.3.0, not "^5.0.0" from specifiers
  assert.equal(result.get('chalk').versionResolved, '5.3.0');
});

test('PnpmLockfileParser v5 single-package: devDependencies included', () => {
  const result = pnpmLockfileParser.parse(pnpmV5SingleLockfile);
  assert.ok(result.has('typescript'), 'should have typescript from devDeps');
  assert.equal(result.get('typescript').versionResolved, '5.0.4');
});

// ─── PnpmLockfileParser — peer suffix stripping ───────────────────────────────

test('PnpmLockfileParser: complex peer suffix is fully stripped', () => {
  const lockfile = [
    "lockfileVersion: '6.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      some-lib:',
    '        specifier: ^1.0.0',
    '        version: 1.2.3(@types/react@18.0.28)(react@18.2.0)(react-dom@18.2.0)',
  ].join('\n');
  const result = pnpmLockfileParser.parse(lockfile);
  const dep = result.get('some-lib');
  assert.ok(dep, 'should have some-lib');
  assert.equal(dep.versionResolved, '1.2.3');
  assert.equal(dep.versionMajor, 1);
  assert.equal(dep.versionMinor, 2);
  assert.equal(dep.versionPatch, 3);
});

test('PnpmLockfileParser: prerelease version is preserved after peer-suffix strip', () => {
  const lockfile = [
    "lockfileVersion: '6.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      my-lib:',
    '        specifier: ^2.0.0-beta.1',
    '        version: 2.0.0-beta.1(react@18.2.0)',
  ].join('\n');
  const result = pnpmLockfileParser.parse(lockfile);
  const dep = result.get('my-lib');
  assert.ok(dep, 'should have my-lib');
  assert.equal(dep.versionResolved, '2.0.0-beta.1');
  assert.equal(dep.versionPrerelease, 'beta.1');
  assert.equal(dep.versionIsPrerelease, true);
});

// ─── PnpmLockfileParser — edge cases ─────────────────────────────────────────

test('PnpmLockfileParser: returns empty map for empty string', () => {
  const result = pnpmLockfileParser.parse('');
  assert.equal(result.size, 0);
});

test('PnpmLockfileParser: returns empty map for non-YAML content', () => {
  const result = pnpmLockfileParser.parse('not a yaml file }{');
  assert.equal(result.size, 0);
});

test('PnpmLockfileParser: returns empty map when no importers or deps section', () => {
  const result = pnpmLockfileParser.parse('lockfileVersion: 6.0\n\npackages:\n  react: {}\n');
  assert.equal(result.size, 0);
});

test('PnpmLockfileParser: monorepo with other importers does not pollute root deps', () => {
  const lockfile = [
    "lockfileVersion: '6.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      react:',
    '        specifier: ^18.2.0',
    '        version: 18.2.0',
    '  apps/web:',
    '    dependencies:',
    '      vue:',
    '        specifier: ^3.0.0',
    '        version: 3.3.4',
  ].join('\n');
  const result = pnpmLockfileParser.parse(lockfile);
  assert.ok(result.has('react'), 'should have react from root');
  assert.ok(!result.has('vue'), 'should NOT have vue from apps/web importer');
});

// ─── YarnV1LockfileParser ─────────────────────────────────────────────────────

const yarnV1Fixture = [
  '# yarn lockfile v1',
  '',
  'react@^17.0.0, react@^18.0.0, react@^18.2.0:',
  '  version "18.2.0"',
  '  resolved "https://registry.npmjs.org/react/-/react-18.2.0.tgz"',
  '  integrity sha512-xxx',
  '  dependencies:',
  '    loose-envify "^1.1.0"',
  '',
  '"@types/react@^18.0.0":',
  '  version "18.0.28"',
  '  resolved "https://registry.npmjs.org/@types/react/-/@types-react-18.0.28.tgz"',
  '  integrity sha512-yyy',
  '',
  'lodash@4.17.21, lodash@^4.0.0, lodash@^4.17.21:',
  '  version "4.17.21"',
  '  resolved "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"',
  '  integrity sha512-zzz',
  '',
].join('\n');

test('YarnV1LockfileParser: parses version from single-specifier entry', () => {
  const result = yarnV1LockfileParser.parse(yarnV1Fixture);
  assert.ok(result.has('react'), 'should have react');
  assert.equal(result.get('react').versionResolved, '18.2.0');
  assert.equal(result.get('react').versionMajor, 18);
});

test('YarnV1LockfileParser: multi-specifier header maps all ranges to same version', () => {
  const result = yarnV1LockfileParser.parse(yarnV1Fixture);
  // react@^17.0.0, react@^18.0.0, react@^18.2.0 all resolve to same entry
  assert.equal(result.get('react').versionResolved, '18.2.0');
  // result map should have exactly one entry for 'react'
  assert.equal(result.size, 3); // react, @types/react, lodash
});

test('YarnV1LockfileParser: parses scoped package', () => {
  const result = yarnV1LockfileParser.parse(yarnV1Fixture);
  assert.ok(result.has('@types/react'), 'should have @types/react');
  assert.equal(result.get('@types/react').versionResolved, '18.0.28');
  assert.equal(result.get('@types/react').versionMajor, 18);
  assert.equal(result.get('@types/react').versionMinor, 0);
  assert.equal(result.get('@types/react').versionPatch, 28);
});

test('YarnV1LockfileParser: parses unscoped package with multiple ranges', () => {
  const result = yarnV1LockfileParser.parse(yarnV1Fixture);
  assert.ok(result.has('lodash'), 'should have lodash');
  assert.equal(result.get('lodash').versionResolved, '4.17.21');
});

test('YarnV1LockfileParser: returns empty map for empty string', () => {
  assert.equal(yarnV1LockfileParser.parse('').size, 0);
});

test('YarnV1LockfileParser: returns empty map for non-yarn content', () => {
  assert.equal(yarnV1LockfileParser.parse('{ "not": "yarn" }').size, 0);
});

test('YarnV1LockfileParser: parses prerelease version', () => {
  const lockfile = [
    '# yarn lockfile v1',
    '',
    'my-lib@^2.0.0-beta.1:',
    '  version "2.0.0-beta.1"',
    '  resolved "https://registry.npmjs.org/my-lib/-/my-lib-2.0.0-beta.1.tgz"',
    '',
  ].join('\n');
  const result = yarnV1LockfileParser.parse(lockfile);
  const dep = result.get('my-lib');
  assert.ok(dep, 'should have my-lib');
  assert.equal(dep.versionResolved, '2.0.0-beta.1');
  assert.equal(dep.versionPrerelease, 'beta.1');
  assert.equal(dep.versionIsPrerelease, true);
});

test('YarnV1LockfileParser: first occurrence wins for same package name', () => {
  // Unusual but possible: two entries resolving the same pkg to different versions
  const lockfile = [
    '# yarn lockfile v1',
    '',
    'react@^18.0.0:',
    '  version "18.2.0"',
    '',
    'react@^17.0.0:',
    '  version "17.0.2"',
    '',
  ].join('\n');
  const result = yarnV1LockfileParser.parse(lockfile);
  assert.equal(result.get('react').versionResolved, '18.2.0');
});

test('YarnV1LockfileParser: parses last entry even without trailing blank line', () => {
  const lockfile = [
    '# yarn lockfile v1',
    '',
    'react@^18.0.0:',
    '  version "18.2.0"',
    // no trailing blank line
  ].join('\n');
  const result = yarnV1LockfileParser.parse(lockfile);
  assert.ok(result.has('react'), 'should parse entry without trailing newline');
  assert.equal(result.get('react').versionResolved, '18.2.0');
});

test('YarnV1LockfileParser: returns empty map for Berry (v2+) format', () => {
  // Berry uses `version: x.y.z` without quotes — won't match v1 pattern
  const berryLockfile = [
    '__metadata:',
    '  version: 6',
    '  cacheKey: 8',
    '',
    '"react@npm:^18.2.0":',
    '  version: 18.2.0',
    '  resolution: "react@npm:18.2.0"',
    '  checksum: abc123',
    '',
  ].join('\n');
  assert.equal(yarnV1LockfileParser.parse(berryLockfile).size, 0);
});

// ─── YarnBerryLockfileParser ──────────────────────────────────────────────────

const berryFixture = [
  '__metadata:',
  '  version: 6',
  '  cacheKey: 8',
  '',
  '"react@npm:^18.0.0, react@npm:^18.2.0":',
  '  version: 18.2.0',
  '  resolution: "react@npm:18.2.0"',
  '  dependencies:',
  '    loose-envify: "^1.1.0"',
  '  checksum: abc123',
  '  languageName: node',
  '  linkType: hard',
  '',
  '"@types/react@npm:^18.0.0":',
  '  version: 18.0.28',
  '  resolution: "@types/react@npm:18.0.28"',
  '  checksum: def456',
  '  languageName: node',
  '  linkType: hard',
  '',
  '"lodash@npm:^4.17.21":',
  '  version: 4.17.21',
  '  resolution: "lodash@npm:4.17.21"',
  '  checksum: ghi789',
  '  languageName: node',
  '  linkType: hard',
  '',
].join('\n');

test('YarnBerryLockfileParser: parses basic npm: version', () => {
  const result = yarnBerryLockfileParser.parse(berryFixture);
  assert.ok(result.has('react'), 'should have react');
  assert.equal(result.get('react').versionResolved, '18.2.0');
  assert.equal(result.get('react').versionMajor, 18);
});

test('YarnBerryLockfileParser: multi-specifier header collapses to one name', () => {
  const result = yarnBerryLockfileParser.parse(berryFixture);
  // "react@npm:^18.0.0, react@npm:^18.2.0" → one entry for 'react'
  assert.equal(result.size, 3); // react, @types/react, lodash
});

test('YarnBerryLockfileParser: parses scoped package', () => {
  const result = yarnBerryLockfileParser.parse(berryFixture);
  assert.ok(result.has('@types/react'), 'should have @types/react');
  assert.equal(result.get('@types/react').versionResolved, '18.0.28');
  assert.equal(result.get('@types/react').versionMinor, 0);
  assert.equal(result.get('@types/react').versionPatch, 28);
});

test('YarnBerryLockfileParser: __metadata block does not pollute results', () => {
  const result = yarnBerryLockfileParser.parse(berryFixture);
  assert.ok(!result.has('__metadata'), 'should NOT have __metadata entry');
});

test('YarnBerryLockfileParser: patch: protocol extracts same name as npm: entry', () => {
  const lockfile = [
    '__metadata:',
    '  version: 6',
    '',
    '"typescript@npm:^5.0.0":',
    '  version: 5.3.3',
    '  resolution: "typescript@npm:5.3.3"',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"typescript@patch:typescript@npm:^5.0.0#~builtin<compat/typescript>::version=5.3.3&hash=abc":',
    '  version: 5.3.3',
    '  resolution: "typescript@patch:..."',
    '  languageName: node',
    '  linkType: hard',
    '',
  ].join('\n');
  const result = yarnBerryLockfileParser.parse(lockfile);
  assert.ok(result.has('typescript'), 'should have typescript');
  assert.equal(result.get('typescript').versionResolved, '5.3.3');
  assert.equal(result.size, 1);
});

test('YarnBerryLockfileParser: parses prerelease version', () => {
  const lockfile = [
    '__metadata:',
    '  version: 6',
    '',
    '"my-lib@npm:^2.0.0-beta.1":',
    '  version: 2.0.0-beta.1',
    '  resolution: "my-lib@npm:2.0.0-beta.1"',
    '  languageName: node',
    '  linkType: hard',
    '',
  ].join('\n');
  const result = yarnBerryLockfileParser.parse(lockfile);
  const dep = result.get('my-lib');
  assert.ok(dep, 'should have my-lib');
  assert.equal(dep.versionResolved, '2.0.0-beta.1');
  assert.equal(dep.versionPrerelease, 'beta.1');
  assert.equal(dep.versionIsPrerelease, true);
});

test('YarnBerryLockfileParser: returns empty map for empty string', () => {
  assert.equal(yarnBerryLockfileParser.parse('').size, 0);
});

test('YarnBerryLockfileParser: returns empty map for v1 format', () => {
  const v1Content = [
    '# yarn lockfile v1',
    '',
    'react@^18.0.0:',
    '  version "18.2.0"',
    '  resolved "https://registry.npmjs.org/react/-/react-18.2.0.tgz"',
    '',
  ].join('\n');
  assert.equal(yarnBerryLockfileParser.parse(v1Content).size, 0);
});

test('YarnBerryLockfileParser: first occurrence wins for duplicate package name', () => {
  const lockfile = [
    '__metadata:',
    '  version: 6',
    '',
    '"react@npm:^18.0.0":',
    '  version: 18.2.0',
    '  languageName: node',
    '',
    '"react@npm:^17.0.0":',
    '  version: 17.0.2',
    '  languageName: node',
    '',
  ].join('\n');
  const result = yarnBerryLockfileParser.parse(lockfile);
  assert.equal(result.get('react').versionResolved, '18.2.0');
});
