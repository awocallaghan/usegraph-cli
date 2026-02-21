/**
 * `usegraph scan` command
 *
 * Usage:
 *   usegraph scan [path]
 *     --packages <pkg1,pkg2,...>   packages to track in detail
 *     --config <path>             path to config file
 *     --output <dir>              output directory (default: ~/.usegraph/<slug>)
 *     --concurrency <n>           parallel file workers (default: 8)
 *     --json                      print raw JSON result to stdout
 */
import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../config';
import { scanProject } from '../analyzer';
import { computeProjectSlug } from '../analyzer/project-identity';
import { createStorageBackend } from '../storage/index';
import type { ScanResult } from '../types';

export interface ScanCommandOptions {
  packages?: string;
  config?: string;
  output?: string;
  concurrency?: string;
  json?: boolean;
}

export async function runScan(projectPathArg: string | undefined, opts: ScanCommandOptions): Promise<void> {
  const projectPath = resolve(projectPathArg ?? process.cwd());

  if (!existsSync(projectPath)) {
    console.error(chalk.red(`Error: Project path does not exist: ${projectPath}`));
    process.exit(1);
  }

  const config = loadConfig(opts.config ? resolve(opts.config) : projectPath);

  // CLI --packages overrides config
  const targetPackages: string[] = opts.packages
    ? opts.packages.split(',').map((p) => p.trim()).filter(Boolean)
    : config.targetPackages;

  if (targetPackages.length === 0) {
    console.warn(
      chalk.yellow(
        'Warning: No target packages specified. All imports will be tracked (this may be slow).\n' +
          'Use --packages or add "targetPackages" to usegraph.config.json.',
      ),
    );
  }

  const projectSlug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(projectPath, projectSlug, opts, config);
  const cacheDir = backend.getCacheDir();

  const rawConcurrency = opts.concurrency !== undefined ? Number(opts.concurrency) : 8;
  const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1
    ? Math.floor(rawConcurrency)
    : 8;
  if (opts.concurrency !== undefined && concurrency !== Math.floor(rawConcurrency)) {
    console.warn(chalk.yellow(`Warning: Invalid --concurrency value "${opts.concurrency}", using default of 8.`));
  }

  const isGlobal = !opts.output && !config.outputDir;

  console.log(chalk.bold('usegraph scan'));
  console.log(chalk.dim(`  Project:  ${projectPath}`));
  if (targetPackages.length > 0) {
    console.log(chalk.dim(`  Packages: ${targetPackages.join(', ')}`));
  }
  console.log(chalk.dim(`  Output:   ${cacheDir}${isGlobal ? chalk.dim(' (global)') : ''}`));
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
    concurrency,
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

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  backend.save(result);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  printScanSummary(result, elapsedSec);
  console.log('');
  console.log(chalk.green(`✓ Results saved to ${cacheDir}`));
  console.log(chalk.dim(`  Run ${chalk.bold('usegraph report')} to view the analysis.`));
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
