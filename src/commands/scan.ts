/**
 * `usegraph scan` command
 *
 * Usage:
 *   usegraph scan [path]
 *     --packages <pkg1,pkg2,...>   packages to track in detail
 *     --config <path>             path to config file
 *     --output <dir>              output directory (default: .usegraph)
 *     --concurrency <n>           parallel file workers (default: 8)
 *     --json                      print raw JSON result to stdout
 */
import chalk from 'chalk';
import { resolve } from 'path';
import { loadConfig } from '../config';
import { scanProject } from '../analyzer';
import { saveScanResult } from '../storage';
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

  const outputDir = resolve(projectPath, opts.output ?? config.outputDir);
  const concurrency = Number(opts.concurrency ?? 8);

  console.log(chalk.bold('usegraph scan'));
  console.log(chalk.dim(`  Project:  ${projectPath}`));
  if (targetPackages.length > 0) {
    console.log(chalk.dim(`  Packages: ${targetPackages.join(', ')}`));
  }
  console.log(chalk.dim(`  Output:   ${outputDir}`));
  console.log('');

  let lastLine = '';

  const clearLast = () => {
    if (lastLine) process.stdout.write('\r\x1b[K');
  };

  const result: ScanResult = await scanProject({
    projectPath,
    targetPackages,
    config,
    concurrency,
    onProgress: (done, total, file) => {
      clearLast();
      lastLine = `  Scanning ${done}/${total}: ${file}`;
      process.stdout.write(chalk.dim(lastLine));
    },
  });

  clearLast();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const savedPath = saveScanResult(outputDir, result);

  printScanSummary(result);
  console.log('');
  console.log(chalk.green(`✓ Results saved to ${savedPath}`));
  console.log(chalk.dim(`  Run ${chalk.bold('usegraph report')} to view the analysis.`));
}

function printScanSummary(result: ScanResult): void {
  const { summary } = result;
  console.log(chalk.bold('Scan complete'));
  console.log(`  Files scanned:      ${summary.totalFilesScanned}`);
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
