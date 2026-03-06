import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { runScan } from './commands/scan.js';
import { runDashboard } from './commands/dashboard.js';
import { runBuild } from './commands/build.js';
import { runMcp } from './commands/mcp.js';
import { writeDefaultConfig } from './config.js';

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
    .option('--force', 'Re-scan even if this commit was already scanned')
    .option('--since <period>', 'Start of range: relative (1y, 6m, 2w, 30d) or absolute ISO date (2024-01-01)')
    .option('--until <period>', 'End of range (default: now); same format as --since')
    .option('--interval <period>', 'Checkpoint interval — one commit sampled per bucket (e.g. 1m, 2w, 7d)')
    .action(async (path: string | undefined, opts) => {
      try {
        await runScan(path, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Unexpected error during scan: ${message}`));
        process.exit(1);
      }
    });

  // ── build ─────────────────────────────────────────────────────────────────
  program
    .command('build')
    .description(
      'Materialise all scans from ~/.usegraph/ into Parquet tables in ~/.usegraph/built/',
    )
    .action(async () => {
      try {
        await runBuild();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error during build: ${message}`));
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

  // ── mcp ───────────────────────────────────────────────────────────────────
  program
    .command('mcp')
    .description(
      'Start a Model Context Protocol (MCP) server over stdio.\n' +
        'Exposes tools for querying Parquet tables built by `usegraph build`.\n' +
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
        console.log(chalk.dim('  Edit the file to customise include/exclude patterns.'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: Failed to write config file: ${message}`));
        process.exit(1);
      }
    });

  return program;
}
