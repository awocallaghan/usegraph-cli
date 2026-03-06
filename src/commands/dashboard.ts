/**
 * `usegraph dashboard` command
 *
 * Spawns the Observable Framework preview server, pointed at the embedded
 * dashboard in src/dashboard/.  Requires `usegraph build` to have been run
 * first so that ~/.usegraph/built/*.parquet tables exist.
 *
 * Usage:
 *   usegraph dashboard
 *     --port <n>   Port to listen on (default: 3000)
 *     --open       Open the dashboard in the default browser automatically
 */
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

export interface DashboardOptions {
  port?: string;
  open?: boolean;
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  // Resolve the package root from this compiled file's location:
  //   dist/commands/dashboard.js → ../../ → package root
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dashboardDir = join(packageRoot, 'src', 'dashboard');
  const observableBin = findObservableBin(packageRoot);

  if (!existsSync(observableBin)) {
    console.error(chalk.red('Observable Framework binary not found.'));
    console.error(chalk.dim(`  Searched from: ${packageRoot}`));
    console.error(chalk.dim('  Make sure @observablehq/framework is installed (it should be bundled with @usegraph/cli).'));
    process.exit(1);
  }

  const usegraphHome = process.env.USEGRAPH_HOME ?? join(homedir(), '.usegraph');
  const snapshotFile = join(usegraphHome, 'built', 'project_snapshots.parquet');

  if (!existsSync(snapshotFile)) {
    console.error(chalk.red('No Parquet data found.'));
    console.error(chalk.dim('  Run `usegraph build` first to materialise Parquet tables.'));
    process.exit(1);
  }

  // Clear the data-loader cache so Observable always re-runs loaders against the
  // current Parquet files rather than serving stale cached output from a previous run.
  // The npm/stdlib cache (adjacent directories) is preserved since it rarely changes.
  const dataCacheDir = join(dashboardDir, 'pages', '.observablehq', 'cache', 'data');
  if (existsSync(dataCacheDir)) {
    rmSync(dataCacheDir, { recursive: true, force: true });
  }

  const port = opts.port ?? '3000';
  const url = `http://localhost:${port}`;

  console.log('');
  console.log(chalk.bold.cyan(`  usegraph dashboard · ${url}`));
  console.log(chalk.dim('  Press Ctrl+C to stop.'));
  console.log('');

  const child = spawn(observableBin, ['preview', '--port', port], {
    cwd: dashboardDir,
    env: { ...process.env, USEGRAPH_HOME: usegraphHome },
    stdio: 'inherit',
  });

  if (opts.open) {
    setTimeout(() => openBrowser(url), 2000);
  }

  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Observable exited with code ${code}`));
      } else {
        resolve();
      }
    });
    child.on('error', reject);
  });
}

function findObservableBin(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', 'observable');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return join(startDir, 'node_modules', '.bin', 'observable'); // for error message
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execSync(`cmd.exe /c start "" "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch {
    // Silently ignore – user can open the URL manually
  }
}
