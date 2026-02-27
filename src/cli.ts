import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { runScan } from './commands/scan.js';
import { runView } from './commands/view.js';
import { runDashboard } from './commands/dashboard.js';
import { runBuild } from './commands/build.js';
import { runMcp } from './commands/mcp.js';
import { loadConfig, writeDefaultConfig } from './config.js';
import { computeProjectSlug } from './analyzer/project-identity.js';
import { createStorageBackend } from './storage/index.js';

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json'), 'utf-8')
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
    .option('-o, --output <dir>', 'Output directory for results (default: ~/.usegraph/<slug>)')
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

  // ── view ──────────────────────────────────────────────────────────────────
  program
    .command('view')
    .description('View scan results in the terminal (queries ~/.usegraph/built/ Parquet tables)')
    .option('--project <slug>', 'Filter to a specific project slug')
    .option('--package <package>', 'Filter output to a specific npm package')
    .option('--framework <framework>', 'Filter projects by framework (e.g. "react", "next")')
    .option('--build-tool <tool>', 'Filter projects by build tool (e.g. "vite", "webpack")')
    .option('--component <component>', 'Show detail for a specific component (requires --package)')
    .option('--export <export>', 'Show detail for a specific function export (requires --package)')
    .option('--stale-days <n>', 'Flag projects not scanned within N days (default: 7)', parseInt)
    .option('--json', 'Print raw JSON to stdout')
    .action(async (opts) => {
      try {
        await runView(opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  // ── dashboard ─────────────────────────────────────────────────────────────
  program
    .command('dashboard')
    .description(
      'Launch the usegraph web dashboard (requires `usegraph build` to have been run first)',
    )
    .option('-p, --port <n>', 'Port to listen on (default: 3000)')
    .option('--open', 'Open the dashboard in the default browser automatically')
    .action(async (opts) => {
      try {
        await runDashboard(opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Dashboard error: ${message}`));
        process.exit(1);
      }
    });

  // ── build ─────────────────────────────────────────────────────────────────
  program
    .command('build')
    .description(
      'Materialise all scans from ~/.usegraph/ into Parquet tables in ~/.usegraph/built/',
    )
    .option('--rebuild', 'Force a full rebuild even if Parquet files already exist')
    .option('--verbose', 'Print per-table progress')
    .action(async (opts: { rebuild?: boolean; verbose?: boolean }) => {
      try {
        await runBuild(opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error during build: ${message}`));
        process.exit(1);
      }
    });

  // ── mcp ───────────────────────────────────────────────────────────────────
  program
    .command('mcp')
    .description(
      'Start a Model Context Protocol (MCP) server over stdio.\n' +
        'Exposes 13 tools for querying Parquet tables built by `usegraph build`.\n' +
        'Add to your MCP client config: usegraph mcp',
    )
    .option('--verbose', 'Log method names to stderr')
    .action(async (opts: { verbose?: boolean }) => {
      try {
        await runMcp(opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`MCP server error: ${message}`));
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
    .option('-o, --output <dir>', 'Output directory (default: ~/.usegraph/<slug>)')
    .action((path: string | undefined, opts: { output?: string }) => {
      const projectPath = resolve(path ?? process.cwd());
      const config = loadConfig(projectPath);
      const projectSlug = computeProjectSlug(projectPath);
      const backend = createStorageBackend(projectPath, projectSlug, opts, config);
      const ids = backend.list();
      const storeDir = backend.getCacheDir();
      if (ids.length === 0) {
        console.log('No scans found. Run usegraph scan first.');
      } else {
        console.log(`Saved scans in ${storeDir}:`);
        ids.forEach((id: string) => console.log(`  ${id}`));
      }
    });

  return program;
}
