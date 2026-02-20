import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { runScan } from './commands/scan';
import { runReport } from './commands/report';
import { runDashboard } from './commands/dashboard';
import { loadConfig, writeDefaultConfig } from './config';
import { listScans } from './storage';

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
    );
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
}

export function createCli(): Command {
  const program = new Command();

  program
    .name('usegraph')
    .description(
      'Analyse how npm packages are used across your projects.\n' +
        'Track React component props, function call arguments, and more.',
    )
    .version(getVersion());

  // ── scan ──────────────────────────────────────────────────────────────────
  program
    .command('scan [path]')
    .description('Scan a project and record detailed package usage')
    .option('-p, --packages <packages>', 'Comma-separated list of packages to track')
    .option('-c, --config <path>', 'Path to usegraph config file')
    .option('-o, --output <dir>', 'Output directory for results (default: .usegraph)')
    .option('--concurrency <n>', 'Number of files to analyse in parallel (default: 8)')
    .option('--json', 'Print raw JSON result to stdout instead of saving')
    .action(async (path: string | undefined, opts) => {
      try {
        await runScan(path, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Unexpected error during scan: ${message}`));
        process.exit(1);
      }
    });

  // ── report ────────────────────────────────────────────────────────────────
  program
    .command('report [path]')
    .description('Show a terminal report of the latest scan results')
    .option('-s, --scan <id>', 'Load a specific scan by ID instead of the latest')
    .option('--package <package>', 'Filter output to a single package')
    .option('-o, --output <dir>', 'Output directory where results are stored (default: .usegraph)')
    .option('--files', 'Show file-level usage breakdown')
    .option('--json', 'Print raw JSON to stdout')
    .action(async (path: string | undefined, opts) => {
      try {
        await runReport(path, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Unexpected error during report: ${message}`));
        process.exit(1);
      }
    });

  // ── dashboard ─────────────────────────────────────────────────────────────
  program
    .command('dashboard [paths...]')
    .description('Show aggregated usage dashboard across one or more projects')
    .option('--package <package>', 'Filter to a specific package')
    .option('-o, --output <dir>', 'Scan output dir within each project (default: .usegraph)')
    .option('--json', 'Print raw JSON to stdout')
    .action(async (paths: string[], opts) => {
      try {
        await runDashboard(paths, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Unexpected error during dashboard: ${message}`));
        process.exit(1);
      }
    });

  // ── init ──────────────────────────────────────────────────────────────────
  program
    .command('init [path]')
    .description('Create a usegraph.config.json in the project directory')
    .action((path: string | undefined) => {
      const projectPath = resolve(path ?? process.cwd());
      if (!existsSync(projectPath)) {
        console.error(chalk.red(`Error: Directory does not exist: ${projectPath}`));
        process.exit(1);
      }
      try {
        writeDefaultConfig(projectPath);
        console.log(chalk.green(`✓ Created usegraph.config.json in ${projectPath}`));
        console.log(chalk.dim('  Edit the file to specify which packages to track.'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: Failed to write config file: ${message}`));
        process.exit(1);
      }
    });

  // ── scans ─────────────────────────────────────────────────────────────────
  program
    .command('scans [path]')
    .description('List all saved scans for a project')
    .option('-o, --output <dir>', 'Output directory (default: .usegraph)')
    .action((path: string | undefined, opts: { output?: string }) => {
      const projectPath = resolve(path ?? process.cwd());
      const config = loadConfig(projectPath);
      const outputDir = resolve(projectPath, opts.output ?? config.outputDir);
      const ids = listScans(outputDir);
      if (ids.length === 0) {
        console.log('No scans found. Run usegraph scan first.');
      } else {
        console.log(`Saved scans in ${outputDir}:`);
        ids.forEach((id) => console.log(`  ${id}`));
      }
    });

  return program;
}
