/**
 * `usegraph dashboard` command
 *
 * Launches an interactive terminal dashboard showing cross-project usage data.
 * Multiple project paths can be provided, each separated by a comma or as
 * repeated arguments.
 *
 * Usage:
 *   usegraph dashboard [path1] [path2...]
 *     --output <dir>      output dir within each project (default: .usegraph)
 *     --package <pkg>     filter to a specific package
 *     --json              dump aggregated JSON to stdout
 *
 * Note: A full web dashboard is planned for a future release.  This command
 * currently renders a rich terminal report aggregated across all specified projects.
 */
import chalk from 'chalk';
import { resolve } from 'path';
import { loadConfig } from '../config';
import { computeProjectSlug } from '../analyzer/project-identity';
import { createStorageBackend } from '../storage/index';
import type { ScanResult, PackageSummary, ProjectMeta } from '../types';

export interface DashboardCommandOptions {
  output?: string;
  package?: string;
  json?: boolean;
}

export async function runDashboard(projectPaths: string[], opts: DashboardCommandOptions): Promise<void> {
  const paths = projectPaths.length > 0 ? projectPaths : [process.cwd()];

  const results: ScanResult[] = [];

  for (const p of paths) {
    const projectPath = resolve(p);
    const config = loadConfig(projectPath);
    const projectSlug = computeProjectSlug(projectPath);
    const backend = createStorageBackend(projectPath, projectSlug, opts, config);
    const result = backend.loadLatest();
    if (result) {
      results.push(result);
    } else {
      console.warn(chalk.yellow(`  No scan results found for ${projectPath}. Run usegraph scan first.`));
    }
  }

  if (results.length === 0) {
    console.error(chalk.red('No scan data available.'));
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  printDashboard(results, opts);
}

function printDashboard(results: ScanResult[], opts: DashboardCommandOptions): void {
  const pkgFilter = opts.package;

  // ── Header ──────────────────────────────────────────────────────────────
  const width = 60;
  const line = '═'.repeat(width);
  console.log('');
  console.log(chalk.bold.magenta(`╔${line}╗`));
  console.log(chalk.bold.magenta(`║${'  usegraph dashboard'.padEnd(width)}║`));
  console.log(chalk.bold.magenta(`║${'  Cross-project package usage analysis'.padEnd(width)}║`));
  console.log(chalk.bold.magenta(`╚${line}╝`));
  console.log('');
  console.log(`  ${results.length} project${results.length !== 1 ? 's' : ''} loaded`);
  console.log('');

  // ── Per-project overview ─────────────────────────────────────────────────
  console.log(chalk.bold('Projects'));
  for (const r of results) {
    const { summary } = r;
    const status = summary.filesWithTargetUsage > 0 ? chalk.green('●') : chalk.dim('○');
    console.log(
      `  ${status}  ${chalk.bold(r.projectName.padEnd(30))}  ` +
        `${String(summary.totalFilesScanned).padStart(4)} files  ` +
        `${String(summary.totalComponentUsages).padStart(4)} components  ` +
        `${String(summary.totalFunctionCalls).padStart(4)} calls`,
    );
  }
  console.log('');

  // ── Aggregate across projects ────────────────────────────────────────────
  const aggregated = aggregateResults(results, pkgFilter);

  if (aggregated.size === 0) {
    console.log(chalk.dim('  No tracked package usage found across all projects.'));
    return;
  }

  console.log(chalk.bold('Package usage across all projects'));
  console.log('');

  for (const [pkg, data] of aggregated) {
    console.log(chalk.bold.cyan(`  ${pkg}`));

    // Per-project row
    for (const { project, components, functions, files } of data.byProject) {
      console.log(
        `    ${chalk.dim(project.padEnd(32))}` +
          `${String(components).padStart(4)} components  ` +
          `${String(functions).padStart(4)} calls  ` +
          `${String(files).padStart(4)} files`,
      );
    }

    console.log('');

    // Top components across all projects
    if (data.components.length > 0) {
      console.log(`    ${chalk.bold('Components:')} ${data.components.slice(0, 10).join(', ')}`);
    }
    if (data.functions.length > 0) {
      console.log(`    ${chalk.bold('Functions:')}  ${data.functions.slice(0, 10).join(', ')}`);
    }
    console.log('');
  }

  // ── Totals ───────────────────────────────────────────────────────────────
  const totals = results.reduce(
    (acc, r) => ({
      files: acc.files + r.summary.totalFilesScanned,
      components: acc.components + r.summary.totalComponentUsages,
      calls: acc.calls + r.summary.totalFunctionCalls,
    }),
    { files: 0, components: 0, calls: 0 },
  );

  console.log(chalk.bold('Totals across all projects'));
  console.log(`  Files scanned:    ${chalk.white(String(totals.files))}`);
  console.log(`  Component usages: ${chalk.white(String(totals.components))}`);
  console.log(`  Function calls:   ${chalk.white(String(totals.calls))}`);
  console.log('');

  // ── Cross-project tooling overview ────────────────────────────────────────
  const projectsWithMeta = results.filter((r) => r.meta);
  if (projectsWithMeta.length > 0) {
    console.log(chalk.bold('Tech stack across projects'));
    console.log('');

    // Collect all unique tools seen
    const toolMatrix = buildToolMatrix(projectsWithMeta);
    if (toolMatrix.size > 0) {
      const projectNames = projectsWithMeta.map((r) => r.projectName);
      console.log(
        `  ${'Tool'.padEnd(22)}` +
          projectNames.map((n) => n.slice(0, 14).padEnd(16)).join(''),
      );
      console.log(`  ${'─'.repeat(22 + projectNames.length * 16)}`);
      for (const [tool, projectSet] of toolMatrix) {
        const cols = projectNames
          .map((n) => (projectSet.has(n) ? chalk.green('✓') : chalk.dim('–')).padEnd(16))
          .join('');
        console.log(`  ${tool.padEnd(22)}${cols}`);
      }
      console.log('');
    }

    // Dependency overview
    console.log(chalk.bold('Dependency counts per project'));
    for (const r of projectsWithMeta) {
      if (!r.meta) continue;
      const prod = r.meta.dependencies.filter((d) => d.section === 'dependencies').length;
      const dev = r.meta.dependencies.filter((d) => d.section === 'devDependencies').length;
      console.log(
        `  ${r.projectName.padEnd(32)}  ${String(prod).padStart(3)} prod  ${String(dev).padStart(3)} dev`,
      );
    }
    console.log('');
  }

  console.log(chalk.dim('Tip: use --package <name> to filter, usegraph report <path> for per-project detail.'));
}

function buildToolMatrix(results: Array<{ projectName: string; meta?: ProjectMeta }>): Map<string, Set<string>> {
  const matrix = new Map<string, Set<string>>();
  for (const r of results) {
    if (!r.meta) continue;
    for (const tool of r.meta.tooling) {
      if (!matrix.has(tool.name)) matrix.set(tool.name, new Set());
      matrix.get(tool.name)!.add(r.projectName);
    }
  }
  // Sort by how many projects use this tool (desc)
  return new Map(
    [...matrix.entries()].sort((a, b) => b[1].size - a[1].size),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Aggregation helpers
// ────────────────────────────────────────────────────────────────────────────

interface AggregatedPackage {
  byProject: Array<{
    project: string;
    components: number;
    functions: number;
    files: number;
  }>;
  components: string[];  // unique across projects
  functions: string[];
}

function aggregateResults(
  results: ScanResult[],
  pkgFilter: string | undefined,
): Map<string, AggregatedPackage> {
  const map = new Map<string, AggregatedPackage>();

  for (const result of results) {
    for (const [pkg, pkgSummary] of Object.entries(result.summary.byPackage)) {
      if (pkgFilter && pkg !== pkgFilter) continue;

      if (!map.has(pkg)) {
        map.set(pkg, { byProject: [], components: [], functions: [] });
      }

      const agg = map.get(pkg)!;
      agg.byProject.push({
        project: result.projectName,
        components: pkgSummary.totalComponentUsages,
        functions: pkgSummary.totalFunctionCalls,
        files: pkgSummary.files.length,
      });

      for (const c of pkgSummary.components) {
        if (!agg.components.includes(c)) agg.components.push(c);
      }
      for (const f of pkgSummary.functions) {
        if (!agg.functions.includes(f)) agg.functions.push(f);
      }
    }
  }

  // Sort by total usage across all projects
  return new Map(
    [...map.entries()].sort(
      (a, b) =>
        b[1].byProject.reduce((s, p) => s + p.components + p.functions, 0) -
        a[1].byProject.reduce((s, p) => s + p.components + p.functions, 0),
    ),
  );
}
