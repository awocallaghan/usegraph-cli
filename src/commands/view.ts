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
 *     --component <name>     Show detail for a specific component (requires --package)
 *     --export <name>        Show detail for a specific function export (requires --package)
 *     --stale-days <n>       Flag projects not scanned within N days (default: 7)
 *     --json                 Print raw JSON to stdout
 *
 * Modes:
 *   --component + --package  → component detail view (prop breakdown across projects)
 *   --export    + --package  → export detail view (arg breakdown across projects)
 *   (default)                → single-project or multi-project overview
 */
import chalk from 'chalk';
import { queryParquet, requireParquet, sqlStr } from '../parquet-query.js';

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

interface PropUsageRow {
  project_id: string;
  file_path: string;
  line: number;
  prop_name: string;
  value_type: string;
  value: string | null;
  source_snippet: string | null;
}

interface ArgUsageRow {
  project_id: string;
  file_path: string;
  line: number;
  arg_index: number;
  value_type: string;
  value: string | null;
  source_snippet: string | null;
}

interface ProjectCallCountRow {
  project_id: string;
  site_count: number;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runView(opts: ViewCommandOptions): Promise<void> {
  // Validate: --component / --export require --package
  if (opts.component && !opts.package) {
    console.error(chalk.red('Error: --component requires --package to be specified.'));
    console.error(chalk.dim('  Example: usegraph view --package @acme/ui --component Button'));
    process.exit(1);
  }
  if (opts.export && !opts.package) {
    console.error(chalk.red('Error: --export requires --package to be specified.'));
    console.error(chalk.dim('  Example: usegraph view --package @acme/utils --export formatDate'));
    process.exit(1);
  }

  const staleDays = typeof opts.staleDays === 'number' ? opts.staleDays : 7;

  // Load matching projects (used by all modes)
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

  // ── Mode dispatch ──────────────────────────────────────────────────────────
  if (opts.component && opts.package) {
    if (opts.json) {
      const rows = await loadPropUsages(opts.package, opts.component, opts.project);
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    await printComponentDetail(projects, opts.package, opts.component, opts.project);
    return;
  }

  if (opts.export && opts.package) {
    if (opts.json) {
      const rows = await loadArgUsages(opts.package, opts.export, opts.project);
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    await printExportDetail(projects, opts.package, opts.export, opts.project);
    return;
  }

  // ── Overview modes ─────────────────────────────────────────────────────────
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

async function loadPropUsages(
  packageName: string,
  componentName: string,
  projectId?: string,
): Promise<PropUsageRow[]> {
  const p = requireParquet('component_prop_usages');
  const projectFilter = projectId ? `AND project_id = '${sqlStr(projectId)}'` : '';
  return queryParquet(`
    SELECT project_id, file_path, line, prop_name, value_type, value::VARCHAR AS value, source_snippet
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      AND package_name   = '${sqlStr(packageName)}'
      AND component_name = '${sqlStr(componentName)}'
      ${projectFilter}
    ORDER BY prop_name, project_id, line
    LIMIT 2000
  `) as unknown as Promise<PropUsageRow[]>;
}

async function loadArgUsages(
  packageName: string,
  exportName: string,
  projectId?: string,
): Promise<ArgUsageRow[]> {
  const p = requireParquet('function_arg_usages');
  const projectFilter = projectId ? `AND project_id = '${sqlStr(projectId)}'` : '';
  return queryParquet(`
    SELECT project_id, file_path, line, arg_index, value_type, value::VARCHAR AS value, source_snippet
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      AND package_name = '${sqlStr(packageName)}'
      AND export_name  = '${sqlStr(exportName)}'
      ${projectFilter}
    ORDER BY arg_index, project_id, line
    LIMIT 2000
  `) as unknown as Promise<ArgUsageRow[]>;
}

async function loadCallSiteCounts(
  table: 'component_usages' | 'function_usages',
  packageName: string,
  nameField: string,
  nameValue: string,
  projectId?: string,
): Promise<ProjectCallCountRow[]> {
  const p = requireParquet(table);
  const projectFilter = projectId ? `AND project_id = '${sqlStr(projectId)}'` : '';
  return queryParquet(`
    SELECT project_id, COUNT(*)::INTEGER AS site_count
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      AND package_name = '${sqlStr(packageName)}'
      AND ${nameField} = '${sqlStr(nameValue)}'
      ${projectFilter}
    GROUP BY project_id
    ORDER BY site_count DESC
  `) as unknown as Promise<ProjectCallCountRow[]>;
}

// ─── Component detail view ────────────────────────────────────────────────────

async function printComponentDetail(
  projects: ProjectRow[],
  packageName: string,
  componentName: string,
  projectId?: string,
): Promise<void> {
  const [propRows, callCounts] = await Promise.all([
    loadPropUsages(packageName, componentName, projectId),
    loadCallSiteCounts('component_usages', packageName, 'component_name', componentName, projectId),
  ]);

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.blue('╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.blue('║       usegraph view — component          ║'));
  console.log(chalk.bold.blue('╚══════════════════════════════════════════╝'));
  console.log('');
  console.log(`  Component:  ${chalk.bold.green(componentName)}`);
  console.log(`  Package:    ${chalk.bold.cyan(packageName)}`);
  const projectScope = projectId ? ` (project: ${projectId})` : ` across ${projects.length} project${projects.length !== 1 ? 's' : ''}`;
  console.log(`  Scope:      ${chalk.dim(projectScope)}`);
  console.log('');

  if (callCounts.length === 0) {
    console.log(chalk.dim(`  No usages of ${componentName} from ${packageName} found.`));
    console.log('');
    return;
  }

  // ── Per-project adoption ──────────────────────────────────────────────────
  console.log(chalk.bold('Adoption by project'));
  const totalSites = callCounts.reduce((s, r) => s + r.site_count, 0);
  for (const row of callCounts) {
    const bar = '█'.repeat(Math.min(10, row.site_count));
    console.log(
      `  ${chalk.bold(row.project_id.padEnd(36))}  ${chalk.blue(bar)}  ` +
        `${String(row.site_count).padStart(4)} site${row.site_count !== 1 ? 's' : ''}`,
    );
  }
  console.log(chalk.dim(`  Total: ${totalSites} usage site${totalSites !== 1 ? 's' : ''} across ${callCounts.length} project${callCounts.length !== 1 ? 's' : ''}`));
  console.log('');

  if (propRows.length === 0) {
    console.log(chalk.dim(`  No prop data recorded (component may have no tracked props).`));
    console.log('');
    return;
  }

  // ── Prop breakdown ─────────────────────────────────────────────────────────
  console.log(chalk.bold('Prop usage'));
  console.log('');

  const byProp = groupBy(propRows, (r) => r.prop_name);
  for (const [prop, rows] of byProp) {
    const staticRows = rows.filter((r) => r.value_type === 'static');
    const dynamicRows = rows.filter((r) => r.value_type !== 'static');

    console.log(`  ${chalk.bold.yellow(prop)}  ${chalk.dim(`(${rows.length} total)`)}`);

    // Static value frequency table
    if (staticRows.length > 0) {
      const freq = new Map<string, number>();
      for (const r of staticRows) {
        const key = r.value ?? 'null';
        freq.set(key, (freq.get(key) ?? 0) + 1);
      }
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      for (const [val, count] of sorted) {
        const bar = '█'.repeat(Math.min(8, count));
        console.log(
          `    ${chalk.green(JSON.stringify(val).padEnd(28))}  ${chalk.blue(bar)}  ${count}`,
        );
      }
    }

    // Dynamic usages
    if (dynamicRows.length > 0) {
      console.log(`    ${chalk.dim(`${dynamicRows.length} dynamic value${dynamicRows.length !== 1 ? 's' : ''}`)}`);
      const snippets = dynamicRows
        .filter((r) => r.source_snippet)
        .slice(0, 3);
      for (const r of snippets) {
        const preview = (r.source_snippet ?? '').split('\n').find((l) => l.includes(prop)) ?? r.source_snippet ?? '';
        console.log(`    ${chalk.dim('↳')} ${chalk.italic(chalk.dim(preview.trim()))}`);
      }
      if (dynamicRows.filter((r) => r.source_snippet).length > 3) {
        console.log(`    ${chalk.dim(`… and ${dynamicRows.filter((r) => r.source_snippet).length - 3} more`)}`);
      }
    }

    console.log('');
  }

  console.log(chalk.dim('Tip: use --project to narrow to a single project.'));
}

// ─── Export detail view ───────────────────────────────────────────────────────

async function printExportDetail(
  projects: ProjectRow[],
  packageName: string,
  exportName: string,
  projectId?: string,
): Promise<void> {
  const [argRows, callCounts] = await Promise.all([
    loadArgUsages(packageName, exportName, projectId),
    loadCallSiteCounts('function_usages', packageName, 'export_name', exportName, projectId),
  ]);

  // ── Header ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.blue('╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.blue('║       usegraph view — export             ║'));
  console.log(chalk.bold.blue('╚══════════════════════════════════════════╝'));
  console.log('');
  console.log(`  Export:     ${chalk.bold.green(exportName)}`);
  console.log(`  Package:    ${chalk.bold.cyan(packageName)}`);
  const projectScope = projectId ? ` (project: ${projectId})` : ` across ${projects.length} project${projects.length !== 1 ? 's' : ''}`;
  console.log(`  Scope:      ${chalk.dim(projectScope)}`);
  console.log('');

  if (callCounts.length === 0) {
    console.log(chalk.dim(`  No calls to ${exportName} from ${packageName} found.`));
    console.log('');
    return;
  }

  // ── Per-project adoption ──────────────────────────────────────────────────
  console.log(chalk.bold('Adoption by project'));
  const totalSites = callCounts.reduce((s, r) => s + r.site_count, 0);
  for (const row of callCounts) {
    const bar = '█'.repeat(Math.min(10, row.site_count));
    console.log(
      `  ${chalk.bold(row.project_id.padEnd(36))}  ${chalk.blue(bar)}  ` +
        `${String(row.site_count).padStart(4)} call${row.site_count !== 1 ? 's' : ''}`,
    );
  }
  console.log(chalk.dim(`  Total: ${totalSites} call site${totalSites !== 1 ? 's' : ''} across ${callCounts.length} project${callCounts.length !== 1 ? 's' : ''}`));
  console.log('');

  if (argRows.length === 0) {
    console.log(chalk.dim(`  No argument data recorded (export may be called with no args).`));
    console.log('');
    return;
  }

  // ── Argument breakdown ────────────────────────────────────────────────────
  console.log(chalk.bold('Argument usage'));
  console.log('');

  const byArg = groupBy(argRows, (r) => String(r.arg_index));
  for (const [idx, rows] of byArg) {
    const staticRows = rows.filter((r) => r.value_type === 'static');
    const dynamicRows = rows.filter((r) => r.value_type !== 'static');

    console.log(`  ${chalk.bold.yellow(`arg[${idx}]`)}  ${chalk.dim(`(${rows.length} total)`)}`);

    // Static value frequency table
    if (staticRows.length > 0) {
      const freq = new Map<string, number>();
      for (const r of staticRows) {
        const key = r.value ?? 'null';
        freq.set(key, (freq.get(key) ?? 0) + 1);
      }
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      for (const [val, count] of sorted) {
        const bar = '█'.repeat(Math.min(8, count));
        console.log(
          `    ${chalk.green(JSON.stringify(val).padEnd(28))}  ${chalk.blue(bar)}  ${count}`,
        );
      }
    }

    // Dynamic usages
    if (dynamicRows.length > 0) {
      console.log(`    ${chalk.dim(`${dynamicRows.length} dynamic value${dynamicRows.length !== 1 ? 's' : ''}`)}`);
      const snippets = dynamicRows
        .filter((r) => r.source_snippet)
        .slice(0, 3);
      for (const r of snippets) {
        const preview = (r.source_snippet ?? '').split('\n').find((l) => l.includes(exportName)) ?? r.source_snippet ?? '';
        console.log(`    ${chalk.dim('↳')} ${chalk.italic(chalk.dim(preview.trim()))}`);
      }
      if (dynamicRows.filter((r) => r.source_snippet).length > 3) {
        console.log(`    ${chalk.dim(`… and ${dynamicRows.filter((r) => r.source_snippet).length - 3} more`)}`);
      }
    }

    console.log('');
  }

  console.log(chalk.dim('Tip: use --project to narrow to a single project.'));
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
    if (opts.package) {
      console.log(chalk.dim('  Try removing filters to see all usage.'));
    }
    console.log('');
  }

  console.log(chalk.dim('Tip: use --package to filter, or --component/--export (with --package) for detail views.'));
}

// ─── Multi-project view ───────────────────────────────────────────────────────

async function printMultiProject(
  projects: ProjectRow[],
  opts: ViewCommandOptions,
): Promise<void> {
  const cu = requireParquet('component_usages');
  const fu = requireParquet('function_usages');

  const pkgFilter = opts.package ? `AND package_name = '${sqlStr(opts.package)}'` : '';

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

  console.log(chalk.dim('Tip: use --project, --package to filter.'));
  console.log(chalk.dim('     use --component/--export (with --package) for detailed prop/arg views.'));
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

