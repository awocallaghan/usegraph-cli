/**
 * `usegraph view` command
 *
 * A unified terminal view of scan results, backed by the Parquet tables
 * produced by `usegraph build`.
 *
 * Usage:
 *   usegraph view
 *     --project <slug>       Filter to a specific project
 *     --package <name>       Filter to a specific npm package
 *     --framework <name>     Filter projects by framework (e.g. "react", "next")
 *     --build-tool <name>    Filter projects by build tool (e.g. "vite", "webpack")
 *     --component <name>     Filter to a specific component name
 *     --export <name>        Filter to a specific function export name
 *     --stale-days <n>       Flag projects not scanned within N days (default: 7)
 *     --json                 Print raw JSON to stdout
 *
 * Renders a single-project detail view when exactly one project matches,
 * or an aggregated multi-project dashboard when multiple projects match.
 */
import chalk from 'chalk';
import { queryParquet, requireParquet, sqlStr } from '../parquet-query';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ViewCommandOptions {
  project?: string;
  package?: string;
  framework?: string;
  buildTool?: string;
  component?: string;
  export?: string;
  staleDays?: number;
  json?: boolean;
}

// ─── Types returned by Parquet queries ────────────────────────────────────────

interface ProjectRow {
  project_id: string;
  repo_url: string | null;
  scanned_at: string;
  framework: string | null;
  build_tool: string | null;
  test_framework: string | null;
  typescript: boolean | null;
  package_manager: string | null;
  is_stale: boolean;
}

interface ComponentUsageRow {
  project_id: string;
  package_name: string;
  component_name: string;
  usage_count: number;
}

interface ExportUsageRow {
  project_id: string;
  package_name: string;
  export_name: string;
  call_count: number;
}

interface DependencyRow {
  package_name: string;
  version_range: string;
  version_resolved: string | null;
  dep_type: string;
  is_internal: boolean;
}

interface SnapshotRow {
  project_id: string;
  repo_url: string | null;
  scanned_at: string;
  framework: string | null;
  framework_version: string | null;
  build_tool: string | null;
  test_framework: string | null;
  typescript: boolean | null;
  typescript_version: string | null;
  package_manager: string | null;
  linter: string | null;
  formatter: string | null;
  css_approach: string | null;
  node_version: string | null;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runView(opts: ViewCommandOptions): Promise<void> {
  const staleDays = typeof opts.staleDays === 'number' ? opts.staleDays : 7;

  // 1. Load matching projects
  const projects = await loadProjects(opts, staleDays);

  if (projects.length === 0) {
    console.error(chalk.red('No projects found.'));
    if (opts.project || opts.framework || opts.buildTool) {
      console.error(chalk.dim('  Check your filter options, or try without filters.'));
    } else {
      console.error(chalk.dim('  Run `usegraph build` first to materialise scan data.'));
    }
    process.exit(1);
  }

  if (opts.json) {
    if (projects.length === 1) {
      const detail = await loadProjectDetail(projects[0].project_id, opts);
      console.log(JSON.stringify(detail, null, 2));
    } else {
      console.log(JSON.stringify(projects, null, 2));
    }
    return;
  }

  if (projects.length === 1) {
    await printSingleProject(projects[0], opts);
  } else {
    await printMultiProject(projects, opts);
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadProjects(
  opts: ViewCommandOptions,
  staleDays: number,
): Promise<ProjectRow[]> {
  const p = requireParquet('project_snapshots');
  const projectFilter = opts.project
    ? `AND project_id = '${sqlStr(opts.project)}'`
    : '';
  const frameworkFilter = opts.framework
    ? `AND framework = '${sqlStr(opts.framework)}'`
    : '';
  const buildToolFilter = opts.buildTool
    ? `AND build_tool = '${sqlStr(opts.buildTool)}'`
    : '';

  return queryParquet(`
    SELECT
      project_id,
      repo_url,
      scanned_at::VARCHAR                                                        AS scanned_at,
      framework,
      build_tool,
      test_framework,
      typescript,
      package_manager,
      (scanned_at::TIMESTAMP < current_timestamp - INTERVAL ${staleDays} DAY)   AS is_stale
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${projectFilter}
      ${frameworkFilter}
      ${buildToolFilter}
    ORDER BY project_id
    LIMIT 200
  `) as unknown as Promise<ProjectRow[]>;
}

async function loadProjectDetail(
  projectId: string,
  opts: ViewCommandOptions,
): Promise<{ snapshot: SnapshotRow | null; dependencies: DependencyRow[]; components: ComponentUsageRow[]; exports: ExportUsageRow[] }> {
  const sp = requireParquet('project_snapshots');
  const dp = requireParquet('dependencies');
  const cu = requireParquet('component_usages');
  const fu = requireParquet('function_usages');
  const id = sqlStr(projectId);

  const pkgFilter = opts.package ? `AND package_name = '${sqlStr(opts.package)}'` : '';
  const compFilter = opts.component ? `AND component_name = '${sqlStr(opts.component)}'` : '';
  const exportFilter = opts.export ? `AND export_name = '${sqlStr(opts.export)}'` : '';

  const [snapshotRows, deps, components, exports] = await Promise.all([
    queryParquet(`
      SELECT * FROM read_parquet('${sqlStr(sp)}')
      WHERE project_id = '${id}' AND is_latest = true
      LIMIT 1
    `),
    queryParquet(`
      SELECT package_name, version_range, version_resolved, dep_type, is_internal
      FROM read_parquet('${sqlStr(dp)}')
      WHERE project_id = '${id}' AND is_latest = true
      ORDER BY dep_type, package_name
      LIMIT 500
    `),
    queryParquet(`
      SELECT
        project_id,
        package_name,
        component_name,
        COUNT(*)::INTEGER AS usage_count
      FROM read_parquet('${sqlStr(cu)}')
      WHERE project_id = '${id}' AND is_latest = true
        ${pkgFilter}
        ${compFilter}
      GROUP BY project_id, package_name, component_name
      ORDER BY usage_count DESC
      LIMIT 200
    `),
    queryParquet(`
      SELECT
        project_id,
        package_name,
        export_name,
        COUNT(*)::INTEGER AS call_count
      FROM read_parquet('${sqlStr(fu)}')
      WHERE project_id = '${id}' AND is_latest = true
        ${pkgFilter}
        ${exportFilter}
      GROUP BY project_id, package_name, export_name
      ORDER BY call_count DESC
      LIMIT 200
    `),
  ]);

  return {
    snapshot: (snapshotRows[0] as unknown as SnapshotRow) ?? null,
    dependencies: deps as unknown as DependencyRow[],
    components: components as unknown as ComponentUsageRow[],
    exports: exports as unknown as ExportUsageRow[],
  };
}

// ─── Single-project view ──────────────────────────────────────────────────────

async function printSingleProject(
  project: ProjectRow,
  opts: ViewCommandOptions,
): Promise<void> {
  const detail = await loadProjectDetail(project.project_id, opts);
  const { snapshot, dependencies, components, exports: exportRows } = detail;

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.blue('╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.blue('║       usegraph view                      ║'));
  console.log(chalk.bold.blue('╚══════════════════════════════════════════╝'));
  console.log('');
  console.log(`  Project:   ${chalk.bold(project.project_id)}`);
  if (project.repo_url) console.log(`  Repo:      ${chalk.dim(project.repo_url)}`);
  console.log(`  Scanned:   ${new Date(project.scanned_at).toLocaleString()}`);
  if (project.is_stale) {
    console.log(`             ${chalk.yellow('⚠ stale — rescan recommended')}`);
  }
  console.log('');

  // ── Tooling ────────────────────────────────────────────────────────────────
  if (snapshot) {
    const toolRows: Array<[string, string]> = [];
    if (snapshot.framework)
      toolRows.push(['Framework', snapshot.framework_version ? `${snapshot.framework} ${snapshot.framework_version}` : snapshot.framework]);
    if (snapshot.package_manager) toolRows.push(['Package Manager', snapshot.package_manager]);
    if (snapshot.build_tool) toolRows.push(['Build Tool', snapshot.build_tool]);
    if (snapshot.test_framework) toolRows.push(['Test Framework', snapshot.test_framework]);
    if (snapshot.linter) toolRows.push(['Linter', snapshot.linter]);
    if (snapshot.formatter) toolRows.push(['Formatter', snapshot.formatter]);
    if (snapshot.css_approach) toolRows.push(['CSS', snapshot.css_approach]);
    if (snapshot.typescript !== null)
      toolRows.push(['TypeScript', snapshot.typescript_version ?? 'yes']);
    if (snapshot.node_version) toolRows.push(['Node', snapshot.node_version]);

    if (toolRows.length > 0) {
      console.log(chalk.bold('Detected tooling:'));
      for (const [label, value] of toolRows) {
        console.log(`  ${chalk.green('✓')} ${label.padEnd(20)} ${chalk.dim(value)}`);
      }
      console.log('');
    }
  }

  // ── Dependencies summary ──────────────────────────────────────────────────
  if (dependencies.length > 0) {
    const prod = dependencies.filter((d) => d.dep_type === 'dependencies').length;
    const dev = dependencies.filter((d) => d.dep_type === 'devDependencies').length;
    console.log(chalk.bold('Dependencies:'));
    console.log(`  ${prod} production  ·  ${dev} dev  ·  ${dependencies.length} total`);
    console.log('');
  }

  // ── Component usages ──────────────────────────────────────────────────────
  if (components.length > 0) {
    console.log(chalk.bold('Component usages:'));
    // Group by package
    const byPackage = groupBy(components, (r) => r.package_name);
    for (const [pkg, rows] of byPackage) {
      console.log(`  ${chalk.bold.cyan(pkg)}`);
      for (const row of rows) {
        console.log(
          `    ${chalk.green(row.component_name.padEnd(32))}  ${String(row.usage_count).padStart(4)} usage${row.usage_count !== 1 ? 's' : ''}`,
        );
      }
    }
    console.log('');
  }

  // ── Function export usages ────────────────────────────────────────────────
  if (exportRows.length > 0) {
    console.log(chalk.bold('Function export usages:'));
    const byPackage = groupBy(exportRows, (r) => r.package_name);
    for (const [pkg, rows] of byPackage) {
      console.log(`  ${chalk.bold.cyan(pkg)}`);
      for (const row of rows) {
        console.log(
          `    ${chalk.green(row.export_name.padEnd(32))}  ${String(row.call_count).padStart(4)} call${row.call_count !== 1 ? 's' : ''}`,
        );
      }
    }
    console.log('');
  }

  if (components.length === 0 && exportRows.length === 0) {
    console.log(chalk.dim('  No tracked package usage found.'));
    if (opts.package || opts.component || opts.export) {
      console.log(chalk.dim('  Try removing filters to see all usage.'));
    }
    console.log('');
  }

  console.log(chalk.dim('Tip: use --component, --export, or --package to filter results.'));
}

// ─── Multi-project view ───────────────────────────────────────────────────────

async function printMultiProject(
  projects: ProjectRow[],
  opts: ViewCommandOptions,
): Promise<void> {
  const cu = requireParquet('component_usages');
  const fu = requireParquet('function_usages');

  const pkgFilter = opts.package ? `AND package_name = '${sqlStr(opts.package)}'` : '';
  const compFilter = opts.component ? `AND component_name = '${sqlStr(opts.component)}'` : '';
  const exportFilter = opts.export ? `AND export_name = '${sqlStr(opts.export)}'` : '';

  // Load aggregate component + export usage across all shown projects
  const projectIdList = projects.map((p) => `'${sqlStr(p.project_id)}'`).join(', ');
  const projectInFilter = `AND project_id IN (${projectIdList})`;

  const [componentUsages, exportUsages] = await Promise.all([
    queryParquet(`
      SELECT
        package_name,
        component_name,
        COUNT(DISTINCT project_id)::INTEGER AS project_count,
        COUNT(*)::INTEGER                   AS total_usages
      FROM read_parquet('${sqlStr(cu)}')
      WHERE is_latest = true
        ${projectInFilter}
        ${pkgFilter}
        ${compFilter}
      GROUP BY package_name, component_name
      ORDER BY project_count DESC, total_usages DESC
      LIMIT 50
    `),
    queryParquet(`
      SELECT
        package_name,
        export_name,
        COUNT(DISTINCT project_id)::INTEGER AS project_count,
        COUNT(*)::INTEGER                   AS total_calls
      FROM read_parquet('${sqlStr(fu)}')
      WHERE is_latest = true
        ${projectInFilter}
        ${pkgFilter}
        ${exportFilter}
      GROUP BY package_name, export_name
      ORDER BY project_count DESC, total_calls DESC
      LIMIT 50
    `),
  ]) as [
    Array<{ package_name: string; component_name: string; project_count: number; total_usages: number }>,
    Array<{ package_name: string; export_name: string; project_count: number; total_calls: number }>,
  ];

  // ── Header ─────────────────────────────────────────────────────────────────
  const width = 60;
  const line = '═'.repeat(width);
  console.log('');
  console.log(chalk.bold.magenta(`╔${line}╗`));
  console.log(chalk.bold.magenta(`║${'  usegraph view'.padEnd(width)}║`));
  console.log(chalk.bold.magenta(`║${'  Cross-project package usage analysis'.padEnd(width)}║`));
  console.log(chalk.bold.magenta(`╚${line}╝`));
  console.log('');
  console.log(`  ${projects.length} project${projects.length !== 1 ? 's' : ''} loaded`);
  if (opts.package) console.log(`  Filtering by package: ${chalk.cyan(opts.package)}`);
  if (opts.component) console.log(`  Filtering by component: ${chalk.cyan(opts.component)}`);
  if (opts.export) console.log(`  Filtering by export: ${chalk.cyan(opts.export)}`);
  console.log('');

  // ── Projects table ─────────────────────────────────────────────────────────
  console.log(chalk.bold('Projects'));
  for (const p of projects) {
    const staleIcon = p.is_stale ? chalk.yellow('⚠') : chalk.green('●');
    const fw = p.framework ? chalk.dim(` [${p.framework}]`) : '';
    const scanned = new Date(p.scanned_at).toLocaleDateString();
    console.log(
      `  ${staleIcon}  ${chalk.bold(p.project_id.padEnd(36))}  ${scanned.padEnd(12)}${fw}`,
    );
  }
  const staleCount = projects.filter((p) => p.is_stale).length;
  if (staleCount > 0) {
    console.log(chalk.dim(`\n  ⚠ ${staleCount} project${staleCount !== 1 ? 's are' : ' is'} stale — re-run usegraph scan + build`));
  }
  console.log('');

  // ── Component usages ──────────────────────────────────────────────────────
  if (componentUsages.length > 0) {
    console.log(chalk.bold('Component usages across projects'));
    console.log('');
    const byPackage = groupBy(componentUsages, (r) => r.package_name);
    for (const [pkg, rows] of byPackage) {
      console.log(`  ${chalk.bold.cyan(pkg)}`);
      for (const row of rows) {
        const bar = '█'.repeat(Math.min(10, row.project_count));
        console.log(
          `    ${row.component_name.padEnd(32)}  ${chalk.blue(bar)}  ` +
            `${String(row.project_count).padStart(3)} project${row.project_count !== 1 ? 's' : ''}  ` +
            `${String(row.total_usages).padStart(5)} usages`,
        );
      }
      console.log('');
    }
  }

  // ── Function export usages ────────────────────────────────────────────────
  if (exportUsages.length > 0) {
    console.log(chalk.bold('Function export usages across projects'));
    console.log('');
    const byPackage = groupBy(exportUsages, (r) => r.package_name);
    for (const [pkg, rows] of byPackage) {
      console.log(`  ${chalk.bold.cyan(pkg)}`);
      for (const row of rows) {
        const bar = '█'.repeat(Math.min(10, row.project_count));
        console.log(
          `    ${row.export_name.padEnd(32)}  ${chalk.blue(bar)}  ` +
            `${String(row.project_count).padStart(3)} project${row.project_count !== 1 ? 's' : ''}  ` +
            `${String(row.total_calls).padStart(5)} calls`,
        );
      }
      console.log('');
    }
  }

  if (componentUsages.length === 0 && exportUsages.length === 0) {
    console.log(chalk.dim('  No tracked package usage found across these projects.'));
    console.log('');
  }

  // ── Tech stack overview ───────────────────────────────────────────────────
  const toolingRows = buildToolingOverview(projects);
  if (toolingRows.length > 0) {
    console.log(chalk.bold('Tech stack overview'));
    console.log('');
    for (const [label, value, count] of toolingRows) {
      const bar = '█'.repeat(Math.min(10, count));
      console.log(
        `  ${label.padEnd(18)}  ${chalk.dim(value.padEnd(20))}  ${chalk.blue(bar)}  ${count}`,
      );
    }
    console.log('');
  }

  console.log(chalk.dim('Tip: use --project, --package, --component, or --export to filter.'));
  console.log(chalk.dim('     use --framework or --build-tool to narrow to a subset of projects.'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function buildToolingOverview(projects: ProjectRow[]): Array<[string, string, number]> {
  const counts = new Map<string, number>();
  for (const p of projects) {
    if (p.framework) increment(counts, `Framework:${p.framework}`);
    if (p.build_tool) increment(counts, `Build Tool:${p.build_tool}`);
    if (p.test_framework) increment(counts, `Test:${p.test_framework}`);
    if (p.package_manager) increment(counts, `Pkg Manager:${p.package_manager}`);
    if (p.typescript) increment(counts, `TypeScript:yes`);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const [label, value] = key.split(':') as [string, string];
      return [label, value, count];
    });
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
