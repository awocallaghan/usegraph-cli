/**
 * `usegraph dashboard` command
 *
 * Builds the Observable Framework dashboard then serves the static output with
 * a Node.js HTTP server.  Using the built output (rather than `observable preview`)
 * lets Observable Framework's client-side router preserve the ES-module cache
 * across page navigations, which is required for the DuckDB singleton pattern.
 *
 * Usage:
 *   usegraph dashboard
 *     --port <n>   Port to listen on (default: 3000)
 *     --open       Open the dashboard in the default browser automatically
 */
import { execSync, spawnSync } from 'child_process';
import { createReadStream, existsSync, rmSync } from 'fs';
import { createServer } from 'http';
import { extname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const MIME: Record<string, string> = {
  '.html':    'text/html',
  '.js':      'application/javascript',
  '.mjs':     'application/javascript',
  '.css':     'text/css',
  '.json':    'application/json',
  '.wasm':    'application/wasm',
  '.parquet': 'application/octet-stream',
  '.png':     'image/png',
  '.svg':     'image/svg+xml',
};

export interface DashboardOptions {
  port?: string;
  open?: boolean;
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  // Resolve the package root from this compiled file's location:
  //   dist/commands/dashboard.js → ../../ → package root
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dashboardDir = join(packageRoot, 'src', 'dashboard');
  const observableBin = join(packageRoot, 'node_modules', '.bin', 'observable');

  if (!existsSync(observableBin)) {
    console.error(chalk.red('Observable Framework binary not found.'));
    console.error(chalk.dim(`  Expected at: ${observableBin}`));
    console.error(chalk.dim('  Try running `pnpm install` in the usegraph-cli package directory.'));
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

  // Build the static dashboard output.
  console.log('');
  console.log(chalk.dim('  Building dashboard…'));
  const buildResult = spawnSync(observableBin, ['build'], {
    cwd: dashboardDir,
    env: { ...process.env, USEGRAPH_HOME: usegraphHome },
    stdio: 'inherit',
  });
  if (buildResult.status !== 0) {
    console.error(chalk.red('Observable build failed.'));
    process.exit(buildResult.status ?? 1);
  }

  const distDir = join(dashboardDir, 'dist');
  const port = opts.port ?? '3000';
  const url = `http://localhost:${port}`;

  // Serve the static build output.
  const server = createServer((req, res) => {
    let urlPath = (req.url ?? '/').split('?')[0];
    if (urlPath === '/' || urlPath === '') urlPath = '/index';
    const base = join(distDir, urlPath);

    const candidates = [base, base + '.html', join(base, 'index.html')];
    const filePath = candidates.find(existsSync);

    if (!filePath) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(filePath) || '.html';
    const mime = MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(Number(port), resolve));

  console.log(chalk.bold.cyan(`  usegraph dashboard · ${url}`));
  console.log(chalk.dim('  Press Ctrl+C to stop.'));
  console.log('');

  if (opts.open) {
    openBrowser(url);
  }

  // Keep running until Ctrl+C.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { server.close(); resolve(); });
    process.on('SIGTERM', () => { server.close(); resolve(); });
  });
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
