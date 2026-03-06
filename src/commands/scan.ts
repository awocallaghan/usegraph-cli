/**
 * `usegraph scan` command
 *
 * Usage:
 *   usegraph scan [path]
 *     --packages <pkg1,pkg2,...>   packages to track in detail
 *     --since <period>            scan commits from this date (e.g. 6m, 2w, 2024-01-01)
 *     --until <period>            end of range (default: now)
 *     --interval <period>         sample one commit per bucket (e.g. 1m, 2w, 7d)
 */
import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { loadConfig } from '../config.js';
import { scanProject, getCommitSha } from '../analyzer/index.js';
import { computeProjectSlug } from '../analyzer/project-identity.js';
import { createStorageBackend } from '../storage/index.js';
import { getScanIdForCommit } from '../storage.js';
import type { StorageBackend } from '../storage/backend.js';
import type { ScanResult, UsegraphConfig } from '../types.js';
import {
  parsePeriod,
  resolveDate,
  getCommitsInRange,
  getCommitAtOrBefore,
  selectCheckpointCommits,
  type CommitEntry,
} from '../git-history.js';

export interface ScanCommandOptions {
  packages?: string;
  since?: string;
  until?: string;
  interval?: string;
}

export async function runScan(projectPathArg: string | undefined, opts: ScanCommandOptions): Promise<void> {
  const projectPath = resolve(projectPathArg ?? process.cwd());

  if (!existsSync(projectPath)) {
    console.error(chalk.red(`Error: Project path does not exist: ${projectPath}`));
    process.exit(1);
  }

  const config = loadConfig(projectPath);

  // CLI --packages determines which packages to track
  const targetPackages: string[] = opts.packages
    ? opts.packages.split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  if (targetPackages.length === 0) {
    console.warn(
      chalk.yellow(
        'Warning: No target packages specified. All imports will be tracked (this may be slow).\n' +
          'Use --packages to specify which packages to track.',
      ),
    );
  }

  const projectSlug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(projectSlug);
  const cacheDir = backend.getCacheDir() ?? '';

  const hasSince    = opts.since    !== undefined;
  const hasInterval = opts.interval !== undefined;

  if (hasInterval && !hasSince) {
    console.error(chalk.red('Error: --interval requires --since to define a start boundary.'));
    process.exit(1);
  }

  if (hasSince) {
    await runCheckpointScan(projectPath, opts, config, targetPackages, backend, cacheDir);
    return;
  }

  // Deduplication: skip if this commit was already scanned
  if (cacheDir) {
    const commitSha = getCommitSha(projectPath);
    if (commitSha) {
      const existingId = getScanIdForCommit(cacheDir, commitSha);
      if (existingId) {
        const shortSha = commitSha.slice(0, 7);
        console.log(chalk.green(`✓ Already scanned commit ${shortSha} — skipping`));
        return;
      }
    }
  }

  console.log(chalk.bold('usegraph scan'));
  console.log(chalk.dim(`  Project:  ${projectPath}`));
  if (targetPackages.length > 0) {
    console.log(chalk.dim(`  Packages: ${targetPackages.join(', ')}`));
  }
  console.log(chalk.dim(`  Output:   ${cacheDir}`));
  console.log('');

  let lastLine = '';

  const clearLast = () => {
    if (lastLine) process.stdout.write('\r\x1b[K');
  };

  const startTime = Date.now();

  const result: ScanResult = await scanProject({
    projectPath,
    targetPackages,
    config,
    cacheDir,
    projectSlug,
    onProgress: (done, total, file, cached) => {
      clearLast();
      const suffix = cached ? chalk.dim(' [cache]') : '';
      lastLine = `  Scanning ${done}/${total}: ${file}`;
      process.stdout.write(chalk.dim(lastLine) + suffix);
    },
  });

  clearLast();

  if (result.fileCount === 0) {
    console.warn(chalk.yellow('Warning: No source files found matching the configured patterns.'));
    console.warn(chalk.dim(`  Include patterns: ${config.include.join(', ')}`));
    console.warn(chalk.dim('  Check your include/exclude patterns in usegraph.config.json.'));
    console.warn('');
  }

  backend.save(result);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  printScanSummary(result, elapsedSec);
  console.log('');
  console.log(chalk.green(`✓ Results saved to ${cacheDir}`));
}

function printScanSummary(result: ScanResult, elapsedSec: string): void {
  const { summary } = result;
  console.log(chalk.bold(`Scan complete`) + chalk.dim(` (${elapsedSec}s)`));
  console.log(`  Files scanned:      ${summary.totalFilesScanned}`);
  if (result.cacheHits !== undefined && result.cacheHits > 0) {
    const fresh = summary.totalFilesScanned - result.cacheHits;
    console.log(chalk.dim(`  From cache:         ${result.cacheHits} (${fresh} re-analyzed)`));
  }
  if (summary.filesWithErrors > 0) {
    console.log(chalk.yellow(`  Files with errors:  ${summary.filesWithErrors}`));
  }
  console.log(`  Files with usage:   ${summary.filesWithTargetUsage}`);
  console.log(`  Component usages:   ${summary.totalComponentUsages}`);
  console.log(`  Function calls:     ${summary.totalFunctionCalls}`);
  if (result.codeAt) {
    const shortSha = result.commitSha ? ` (commit ${result.commitSha.slice(0, 7)})` : '';
    console.log(`  Code timestamp:     ${result.codeAt}${shortSha}`);
  }

  if (Object.keys(summary.byPackage).length > 0) {
    console.log('');
    console.log(chalk.bold('By package:'));
    for (const [pkg, pkgSummary] of Object.entries(summary.byPackage)) {
      console.log(
        `  ${chalk.cyan(pkg)}  ` +
          `${pkgSummary.totalComponentUsages} components, ` +
          `${pkgSummary.totalFunctionCalls} calls, ` +
          `${pkgSummary.files.length} files`,
      );
    }
  }
}

// ─── Checkpoint scanning (--since / --until / --interval) ─────────────────────

function gitRawSync(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim() || null;
}

async function runCheckpointScan(
  projectPath: string,
  opts: ScanCommandOptions,
  config: UsegraphConfig,
  targetPackages: string[],
  backend: StorageBackend,
  cacheDir: string,
): Promise<void> {
  const projectSlug = computeProjectSlug(projectPath);
  const now = new Date();

  let sinceDate: Date;
  try {
    sinceDate = resolveDate(parsePeriod(opts.since!), now);
  } catch (err) {
    console.error(chalk.red(`Error: --since: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  let untilDate: Date = now;
  if (opts.until) {
    try {
      untilDate = resolveDate(parsePeriod(opts.until), now);
    } catch (err) {
      console.error(chalk.red(`Error: --until: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  }

  if (untilDate < sinceDate) {
    console.error(chalk.red('Error: --until date is before --since date.'));
    process.exit(1);
  }

  let intervalMs: number | undefined;
  if (opts.interval) {
    try {
      const p = parsePeriod(opts.interval);
      if (p.type !== 'relative') {
        console.error(chalk.red('Error: --interval must be a relative period (e.g. 1m, 2w, 7d), not an absolute date.'));
        process.exit(1);
      }
      intervalMs = p.ms;
    } catch (err) {
      console.error(chalk.red(`Error: --interval: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  }

  console.log(chalk.bold('usegraph scan --since' + (opts.interval ? ' --interval' : '')));
  console.log(chalk.dim(`  Project:  ${projectPath}`));
  console.log(chalk.dim(`  Since:    ${sinceDate.toISOString().slice(0, 10)}`));
  console.log(chalk.dim(`  Until:    ${untilDate.toISOString().slice(0, 10)}`));
  if (intervalMs !== undefined) {
    console.log(chalk.dim(`  Interval: ${opts.interval}`));
  }
  console.log('');

  let commits = getCommitsInRange(projectPath, sinceDate, untilDate, gitRawSync);

  // Find the latest commit at or before sinceDate so we always have a data
  // point at the START of the requested period.  This prevents old, inactive
  // projects from appearing as "new" projects when their only commits inside
  // the range post-date the period start.
  const rawBaseline = getCommitAtOrBefore(projectPath, sinceDate, gitRawSync);

  if (commits.length === 0 && rawBaseline === null) {
    console.log(chalk.yellow('No commits found in the specified range.'));
    return;
  }

  console.log(chalk.dim(`  Commits in range: ${commits.length}` +
    (rawBaseline !== null && !commits.some(c => c.sha === rawBaseline.sha) ? ' (+1 baseline at period start)' : '')));

  if (intervalMs !== undefined) {
    commits = selectCheckpointCommits(commits, sinceDate.getTime(), untilDate.getTime(), intervalMs);
    // Recompute after sampling: the baseline may have been dropped from the sampled set
    console.log(chalk.dim(`  After sampling:   ${commits.length} checkpoint(s)` +
      (rawBaseline !== null && !commits.some(c => c.sha === rawBaseline.sha) ? ' (+1 baseline at period start)' : '')));
  }

  console.log('');

  // Baseline needed if it exists and is not already represented in the (possibly sampled) commits.
  // This check is intentionally done AFTER sampling so a baseline commit that was dropped
  // during interval downsampling is still included in the final scan list.
  const baselineNeeded = rawBaseline !== null &&
    !commits.some(c => c.sha === rawBaseline.sha);

  // Baseline is appended after in-range commits (it is the oldest entry)
  type CommitWithOverride = CommitEntry & { overrideCodeAt?: string };
  const allCommits: CommitWithOverride[] = [
    ...commits,
    ...(baselineNeeded ? [{ ...rawBaseline!, overrideCodeAt: sinceDate.toISOString() }] : []),
  ];

  const total = allCommits.length;
  let scanned = 0;
  let skipped = 0;

  for (let i = 0; i < allCommits.length; i++) {
    const commit = allCommits[i];
    const shortSha = commit.sha.slice(0, 7);
    const dateDisplay = commit.overrideCodeAt
      ? ` (baseline at ${commit.overrideCodeAt.slice(0, 10)})`
      : ` (${commit.date.slice(0, 10)})`;

    const existingId = getScanIdForCommit(cacheDir, commit.sha);
    if (existingId) {
      console.log(chalk.dim(`  [${i + 1}/${total}] Skipping ${shortSha}${dateDisplay} (already scanned)`));
      skipped++;
      continue;
    }

    console.log(chalk.dim(`  [${i + 1}/${total}] Scanning commit ${shortSha}${dateDisplay}`));

    const tmpDir = mkdtempSync(join(tmpdir(), `usegraph-worktree-`));
    try {
      const worktreeResult = spawnSync('git', ['-C', projectPath, 'worktree', 'add', tmpDir, commit.sha], {
        encoding: 'utf-8',
      });
      if (worktreeResult.error || worktreeResult.status !== 0) {
        console.warn(chalk.yellow(`  Warning: Could not create worktree for ${shortSha}, skipping`));
        continue;
      }

      const result: ScanResult = await scanProject({
        projectPath: tmpDir,
        targetPackages,
        config,
        cacheDir,
        projectSlug,
      });

      result.isHistoricalScan = true;

      // For the baseline commit, pin codeAt to sinceDate so data reflects
      // the true state of the project at the start of the requested period.
      if (commit.overrideCodeAt) {
        result.codeAt = commit.overrideCodeAt;
      }

      backend.save(result);
      scanned++;
    } finally {
      spawnSync('git', ['-C', projectPath, 'worktree', 'remove', tmpDir, '--force'], {
        encoding: 'utf-8',
      });
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  console.log('');
  console.log(chalk.green(`✓ Checkpoint scan complete: ${scanned} scanned, ${skipped} skipped`));
  console.log(chalk.dim(`  Results saved to ${cacheDir}`));
}
