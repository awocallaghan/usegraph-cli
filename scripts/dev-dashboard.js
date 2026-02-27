#!/usr/bin/env node
/**
 * dev-dashboard.js — quickly spin up the dashboard with fixture data
 *
 * Does exactly what the e2e test does, but persistently:
 *   1. Ensures each fixture project has an ephemeral git repo (2 commits)
 *   2. Scans all 6 projects with --history 2 (skips already-scanned commits)
 *   3. Runs `usegraph build`
 *   4. Launches `usegraph dashboard`
 *
 * Data is stored in <repo-root>/.dev-usegraph/ so repeated runs are fast
 * (already-scanned commits are skipped, no redundant work).
 *
 * Usage:
 *   node scripts/dev-dashboard.js           # scan + build + open dashboard
 *   node scripts/dev-dashboard.js --clean   # wipe .dev-usegraph/ first, then run
 *   node scripts/dev-dashboard.js --build-only  # skip scan, just rebuild + open
 *   node scripts/dev-dashboard.js --scan-only   # scan + build, don't open dashboard
 */

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const FIXTURES_ROOT = join(REPO_ROOT, 'tests', 'fixtures', 'org');
const FIXTURE_PROJECTS = [
  join(FIXTURES_ROOT, 'apps', 'web-app'),
  join(FIXTURES_ROOT, 'apps', 'dashboard'),
  join(FIXTURES_ROOT, 'apps', 'docs'),
  join(FIXTURES_ROOT, 'apps', 'mobile'),
  join(FIXTURES_ROOT, 'packages', 'ui'),
  join(FIXTURES_ROOT, 'packages', 'utils'),
];

const DEV_STORE = join(REPO_ROOT, '.dev-usegraph');
const DIST_CLI  = join(REPO_ROOT, 'dist', 'index.js');
const TARGET_PACKAGES = '@acme/ui,@acme/utils';

const args = process.argv.slice(2);
const CLEAN      = args.includes('--clean');
const BUILD_ONLY = args.includes('--build-only');
const SCAN_ONLY  = args.includes('--scan-only');

// ── helpers ───────────────────────────────────────────────────────────────────

function git(cwd, gitArgs) {
  const r = spawnSync('git', ['-C', cwd, ...gitArgs], { encoding: 'utf-8' });
  if (r.error) throw r.error;
  return r;
}

function run(label, ...cmdArgs) {
  process.stdout.write(`\n▶ ${label}\n`);
  const r = spawnSync(process.execPath, cmdArgs, {
    env: { ...process.env, USEGRAPH_HOME: DEV_STORE },
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error(`\n✗ Failed: ${label}`);
    process.exit(r.status ?? 1);
  }
}

// ── ensure dist/ is built ─────────────────────────────────────────────────────

if (!existsSync(DIST_CLI)) {
  console.error('dist/index.js not found. Run `pnpm build` first.');
  process.exit(1);
}

// ── --clean: wipe the dev store ───────────────────────────────────────────────

if (CLEAN) {
  console.log(`Removing ${DEV_STORE} …`);
  rmSync(DEV_STORE, { recursive: true, force: true });
}

// ── ensure each fixture has a git repo with 2 commits ────────────────────────

if (!BUILD_ONLY) {
  console.log('\n── Setting up fixture git repos ──────────────────────────────');
  for (const projectPath of FIXTURE_PROJECTS) {
    const shortName = projectPath.split('/').slice(-2).join('/');
    const gitDir = join(projectPath, '.git');

    if (existsSync(gitDir)) {
      const log = git(projectPath, ['log', '--oneline']).stdout.trim().split('\n').filter(Boolean);
      console.log(`  ${shortName}: ${log.length} commit(s) already present`);
      continue;
    }

    process.stdout.write(`  ${shortName}: initialising git repo … `);
    git(projectPath, ['init']);
    git(projectPath, ['config', 'user.email', 'dev@dev.local']);
    git(projectPath, ['config', 'user.name', 'Dev']);
    git(projectPath, ['add', '.']);
    git(projectPath, ['commit', '-m', 'initial commit', '--allow-empty']);
    // Second commit so --history 2 has 2 distinct SHAs to scan
    git(projectPath, ['commit', '-m', 'second commit', '--allow-empty']);
    const sha = git(projectPath, ['rev-parse', '--short', 'HEAD']).stdout.trim();
    process.stdout.write(`done (HEAD ${sha})\n`);
  }
}

// ── scan each fixture project with --history 2 ───────────────────────────────

if (!BUILD_ONLY) {
  console.log('\n── Scanning fixture projects (--history 2) ───────────────────');
  for (const projectPath of FIXTURE_PROJECTS) {
    run(
      `scan ${projectPath.split('/').slice(-2).join('/')}`,
      DIST_CLI, 'scan', projectPath,
      '--packages', TARGET_PACKAGES,
      '--history', '2',
    );
  }
}

// ── build parquet tables ──────────────────────────────────────────────────────

console.log('\n── Building Parquet tables ───────────────────────────────────');
run('usegraph build', DIST_CLI, 'build');

// ── launch dashboard ──────────────────────────────────────────────────────────

if (!SCAN_ONLY) {
  console.log('\n── Launching dashboard ───────────────────────────────────────');
  console.log(`   Data: ${DEV_STORE}`);
  console.log('   Press Ctrl+C to stop\n');

  const dashboard = spawn(process.execPath, [DIST_CLI, 'dashboard'], {
    env: { ...process.env, USEGRAPH_HOME: DEV_STORE },
    stdio: 'inherit',
  });

  dashboard.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => dashboard.kill('SIGINT'));
}
