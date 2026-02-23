/**
 * usegraph mcp — Model Context Protocol server over stdio.
 *
 * Exposes 13 tools that query the Parquet tables produced by `usegraph build`:
 *
 *   Discovery:
 *     get_scan_metadata         — overall stats about the data store
 *     list_projects             — filtered project list
 *     list_packages             — packages used across projects
 *     get_project_snapshot      — full detail for one project
 *
 *   Dependencies:
 *     query_dependency_versions — version distribution for a package
 *     query_prerelease_usage    — which projects use prerelease builds
 *     query_tooling_distribution— breakdown of a tooling category
 *
 *   Components:
 *     query_component_usage     — where a component is used
 *     query_prop_usage          — prop values across call sites
 *     query_component_adoption_trend — adoption over time
 *
 *   Functions / exports:
 *     query_export_usage        — where a function export is called
 *     query_export_adoption_trend — adoption over time
 *     get_source_context        — source snippet for a prop/arg call site
 */

import { existsSync } from 'fs';
import chalk from 'chalk';
import * as z from 'zod';
import {
  BUILT_DIR,
  PARQUET,
  TOOLING_CATEGORY_ALLOWLIST,
  queryParquet,
  requireParquet,
  sqlStr,
} from '../parquet-query';

// ─── CLI options ──────────────────────────────────────────────────────────────

export interface McpOptions {
  /** No longer a network port — MCP runs over stdio */
  verbose?: boolean;
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function toolGetScanMetadata(): Promise<unknown> {
  const snapshotsPath = requireParquet('project_snapshots');
  const rows = await queryParquet(`
    SELECT
      COUNT(DISTINCT project_id)::INTEGER          AS project_count,
      MIN(scanned_at)::VARCHAR                     AS oldest_scan,
      MAX(scanned_at)::VARCHAR                     AS newest_scan,
      array_agg(DISTINCT schema_version)           AS schema_versions,
      COUNT(DISTINCT CASE
        WHEN scanned_at::TIMESTAMP < current_timestamp - INTERVAL 7 DAY
        THEN project_id END)::INTEGER              AS stale_project_count
    FROM read_parquet('${sqlStr(snapshotsPath)}')
  `);
  return rows[0] ?? {};
}

async function toolListProjects(args: {
  framework?: string;
  build_tool?: string;
  stale_after_days?: number;
}): Promise<unknown> {
  const p = requireParquet('project_snapshots');
  const frameworkFilter = args.framework
    ? `AND framework = '${sqlStr(args.framework)}'`
    : '';
  const buildToolFilter = args.build_tool
    ? `AND build_tool = '${sqlStr(args.build_tool)}'`
    : '';
  const staleDays = typeof args.stale_after_days === 'number' ? args.stale_after_days : 7;
  return queryParquet(`
    SELECT
      project_id,
      repo_url,
      scanned_at::VARCHAR           AS scanned_at,
      framework,
      build_tool,
      test_framework,
      typescript,
      package_manager,
      (scanned_at::TIMESTAMP < current_timestamp - INTERVAL ${staleDays} DAY) AS is_stale
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${frameworkFilter}
      ${buildToolFilter}
    ORDER BY project_id
    LIMIT 100
  `);
}

async function toolListPackages(args: {
  scope?: string;
  dep_type?: string;
  internal_only?: boolean;
}): Promise<unknown> {
  const p = requireParquet('dependencies');
  const scopeFilter = args.scope
    ? `AND package_name LIKE '${sqlStr(args.scope)}/%'`
    : '';
  const depTypeFilter = args.dep_type
    ? `AND dep_type = '${sqlStr(args.dep_type)}'`
    : '';
  const internalFilter =
    args.internal_only === true ? `AND is_internal = true` : '';
  return queryParquet(`
    SELECT
      package_name,
      COUNT(DISTINCT project_id)::INTEGER AS project_count,
      array_agg(DISTINCT version_resolved) AS versions_seen
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${scopeFilter}
      ${depTypeFilter}
      ${internalFilter}
    GROUP BY package_name
    ORDER BY project_count DESC
    LIMIT 100
  `);
}

async function toolGetProjectSnapshot(args: { project_id: string }): Promise<unknown> {
  const sp = requireParquet('project_snapshots');
  const dp = requireParquet('dependencies');
  const id = sqlStr(args.project_id);

  const [snapshot, deps] = await Promise.all([
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
  ]);

  return { snapshot: snapshot[0] ?? null, dependencies: deps };
}

async function toolQueryDependencyVersions(args: {
  package_name: string;
  dep_type?: string;
  include_prerelease?: boolean;
}): Promise<unknown> {
  const p = requireParquet('dependencies');
  const nameFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const depTypeFilter = args.dep_type
    ? `AND dep_type = '${sqlStr(args.dep_type)}'`
    : '';
  const prereleaseFilter =
    args.include_prerelease === true ? '' : `AND version_is_prerelease = false`;
  return queryParquet(`
    SELECT
      version_resolved,
      version_major,
      version_minor,
      version_patch,
      version_prerelease,
      COUNT(DISTINCT project_id)::INTEGER AS project_count,
      array_agg(DISTINCT project_id)     AS projects
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${nameFilter}
      ${depTypeFilter}
      ${prereleaseFilter}
    GROUP BY version_resolved, version_major, version_minor, version_patch, version_prerelease
    ORDER BY version_major DESC, version_minor DESC, version_patch DESC
    LIMIT 100
  `);
}

async function toolQueryPrereleaseUsage(args: {
  package_name: string;
  prerelease_filter?: string;
}): Promise<unknown> {
  const p = requireParquet('dependencies');
  const nameFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const tagFilter = args.prerelease_filter
    ? `AND version_prerelease LIKE '%${sqlStr(args.prerelease_filter)}%'`
    : '';
  return queryParquet(`
    SELECT
      version_resolved,
      version_prerelease,
      COUNT(DISTINCT project_id)::INTEGER AS project_count,
      array_agg(DISTINCT project_id)     AS projects
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${nameFilter}
      AND version_is_prerelease = true
      ${tagFilter}
    GROUP BY version_resolved, version_prerelease
    ORDER BY project_count DESC
    LIMIT 100
  `);
}

async function toolQueryToolingDistribution(args: { category: string }): Promise<unknown> {
  // CRITICAL: validate against allowlist before SQL column interpolation
  if (!TOOLING_CATEGORY_ALLOWLIST.has(args.category)) {
    throw new Error(
      `Invalid category "${args.category}". Must be one of: ${Array.from(TOOLING_CATEGORY_ALLOWLIST).join(', ')}`,
    );
  }
  const col = args.category; // safe — validated above
  const p = requireParquet('project_snapshots');
  return queryParquet(`
    SELECT
      ${col}::VARCHAR                       AS value,
      COUNT(DISTINCT project_id)::INTEGER   AS project_count,
      array_agg(DISTINCT project_id)        AS projects
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      AND ${col} IS NOT NULL
    GROUP BY ${col}
    ORDER BY project_count DESC
    LIMIT 100
  `);
}

async function toolQueryComponentUsage(args: {
  package_name: string;
  component_name: string;
  package_version?: number;
  include_prerelease?: boolean;
}): Promise<unknown> {
  const p = requireParquet('component_usages');
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const compFilter = `AND component_name = '${sqlStr(args.component_name)}'`;
  const versionFilter =
    typeof args.package_version === 'number'
      ? `AND package_version_major = ${args.package_version}`
      : '';
  const prereleaseFilter =
    args.include_prerelease === true ? '' : `AND (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)`;
  return queryParquet(`
    SELECT
      project_id,
      file_path,
      line,
      package_version_resolved
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${pkgFilter}
      ${compFilter}
      ${versionFilter}
      ${prereleaseFilter}
    ORDER BY project_id, file_path, line
    LIMIT 100
  `);
}

async function toolQueryPropUsage(args: {
  package_name: string;
  component_name: string;
  prop_name: string;
  package_version?: number;
  include_prerelease?: boolean;
}): Promise<unknown> {
  const p = requireParquet('component_prop_usages');
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const compFilter = `AND component_name = '${sqlStr(args.component_name)}'`;
  const propFilter = `AND prop_name = '${sqlStr(args.prop_name)}'`;
  const versionFilter =
    typeof args.package_version === 'number'
      ? `AND package_version_major = ${args.package_version}`
      : '';
  const prereleaseFilter =
    args.include_prerelease === true ? '' : `AND (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)`;
  return queryParquet(`
    SELECT
      project_id,
      file_path,
      line,
      value_type,
      value,
      source_snippet,
      package_version_resolved
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${pkgFilter}
      ${compFilter}
      ${propFilter}
      ${versionFilter}
      ${prereleaseFilter}
    ORDER BY project_id, file_path, line
    LIMIT 100
  `);
}

async function toolQueryComponentAdoptionTrend(args: {
  package_name: string;
  component_name?: string;
  period_months?: number;
}): Promise<unknown> {
  const p = requireParquet('component_usages');
  const months = typeof args.period_months === 'number' ? args.period_months : 12;
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const compFilter = args.component_name
    ? `AND component_name = '${sqlStr(args.component_name)}'`
    : '';
  return queryParquet(`
    SELECT
      date_trunc('month', scanned_at::TIMESTAMP)::VARCHAR AS period,
      COUNT(DISTINCT project_id)::INTEGER                 AS adopting_projects
    FROM read_parquet('${sqlStr(p)}')
    WHERE (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)
      ${pkgFilter}
      ${compFilter}
      AND scanned_at::TIMESTAMP >= current_timestamp - INTERVAL ${months} MONTH
    GROUP BY date_trunc('month', scanned_at::TIMESTAMP)
    ORDER BY period
  `);
}

async function toolQueryExportUsage(args: {
  package_name: string;
  export_name: string;
  package_version?: number;
  include_prerelease?: boolean;
}): Promise<unknown> {
  const fp = requireParquet('function_usages');
  const fap = requireParquet('function_arg_usages');
  const pkgFilter = `AND fu.package_name = '${sqlStr(args.package_name)}'`;
  const expFilter = `AND fu.export_name = '${sqlStr(args.export_name)}'`;
  const versionFilter =
    typeof args.package_version === 'number'
      ? `AND fu.package_version_major = ${args.package_version}`
      : '';
  const prereleaseFilter =
    args.include_prerelease === true ? '' : `AND (fu.package_version_is_prerelease = false OR fu.package_version_is_prerelease IS NULL)`;
  return queryParquet(`
    SELECT
      fu.project_id,
      fu.file_path,
      fu.line,
      fau.arg_index,
      fau.value_type,
      fau.value,
      fau.source_snippet,
      fu.package_version_resolved
    FROM read_parquet('${sqlStr(fp)}') fu
    LEFT JOIN read_parquet('${sqlStr(fap)}') fau
      ON  fu.project_id  = fau.project_id
      AND fu.scanned_at  = fau.scanned_at
      AND fu.file_path   = fau.file_path
      AND fu.line        = fau.line
      AND fu.export_name = fau.export_name
    WHERE fu.is_latest = true
      ${pkgFilter}
      ${expFilter}
      ${versionFilter}
      ${prereleaseFilter}
    ORDER BY fu.project_id, fu.file_path, fu.line, fau.arg_index
    LIMIT 100
  `);
}

async function toolQueryExportAdoptionTrend(args: {
  package_name: string;
  export_name: string;
  period_months?: number;
}): Promise<unknown> {
  const p = requireParquet('function_usages');
  const months = typeof args.period_months === 'number' ? args.period_months : 12;
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const expFilter = `AND export_name = '${sqlStr(args.export_name)}'`;
  return queryParquet(`
    SELECT
      date_trunc('month', scanned_at::TIMESTAMP)::VARCHAR AS period,
      COUNT(DISTINCT project_id)::INTEGER                 AS adopting_projects
    FROM read_parquet('${sqlStr(p)}')
    WHERE (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)
      ${pkgFilter}
      ${expFilter}
      AND scanned_at::TIMESTAMP >= current_timestamp - INTERVAL ${months} MONTH
    GROUP BY date_trunc('month', scanned_at::TIMESTAMP)
    ORDER BY period
  `);
}

async function toolGetSourceContext(args: {
  project_id: string;
  file_path: string;
  line: number;
  prop_name?: string;
  arg_index?: number;
}): Promise<unknown> {
  const id = sqlStr(args.project_id);
  const fp = sqlStr(args.file_path);
  const line = args.line;

  if (args.prop_name !== undefined) {
    const p = requireParquet('component_prop_usages');
    const propFilter = `AND prop_name = '${sqlStr(args.prop_name)}'`;
    const rows = await queryParquet(`
      SELECT source_snippet, value_type, value
      FROM read_parquet('${sqlStr(p)}')
      WHERE project_id = '${id}'
        AND file_path  = '${fp}'
        AND line       = ${line}
        ${propFilter}
        AND is_latest  = true
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  if (args.arg_index !== undefined) {
    const p = requireParquet('function_arg_usages');
    const rows = await queryParquet(`
      SELECT source_snippet, value_type, value
      FROM read_parquet('${sqlStr(p)}')
      WHERE project_id = '${id}'
        AND file_path  = '${fp}'
        AND line       = ${line}
        AND arg_index  = ${args.arg_index}
        AND is_latest  = true
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  throw new Error('Either prop_name or arg_index must be provided.');
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'get_scan_metadata':
      return toolGetScanMetadata();
    case 'list_projects':
      return toolListProjects(args as Parameters<typeof toolListProjects>[0]);
    case 'list_packages':
      return toolListPackages(args as Parameters<typeof toolListPackages>[0]);
    case 'get_project_snapshot':
      return toolGetProjectSnapshot(args as Parameters<typeof toolGetProjectSnapshot>[0]);
    case 'query_dependency_versions':
      return toolQueryDependencyVersions(
        args as Parameters<typeof toolQueryDependencyVersions>[0],
      );
    case 'query_prerelease_usage':
      return toolQueryPrereleaseUsage(
        args as Parameters<typeof toolQueryPrereleaseUsage>[0],
      );
    case 'query_tooling_distribution':
      return toolQueryToolingDistribution(
        args as Parameters<typeof toolQueryToolingDistribution>[0],
      );
    case 'query_component_usage':
      return toolQueryComponentUsage(
        args as Parameters<typeof toolQueryComponentUsage>[0],
      );
    case 'query_prop_usage':
      return toolQueryPropUsage(args as Parameters<typeof toolQueryPropUsage>[0]);
    case 'query_component_adoption_trend':
      return toolQueryComponentAdoptionTrend(
        args as Parameters<typeof toolQueryComponentAdoptionTrend>[0],
      );
    case 'query_export_usage':
      return toolQueryExportUsage(args as Parameters<typeof toolQueryExportUsage>[0]);
    case 'query_export_adoption_trend':
      return toolQueryExportAdoptionTrend(
        args as Parameters<typeof toolQueryExportAdoptionTrend>[0],
      );
    case 'get_source_context':
      return toolGetSourceContext(args as Parameters<typeof toolGetSourceContext>[0]);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ─── MCP server (tmcp) ───────────────────────────────────────────────────────

// Use a runtime dynamic import to load ESM-only packages (tmcp, transport-stdio,
// adapter-zod) from this CommonJS-compiled module.
// eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, unknown>>;

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ServerLike = {
  tool: (opts: Record<string, unknown>, exec: (args: Record<string, unknown>) => Promise<ToolResult>) => void;
};
type TransportLike = { listen: () => void };

function wrap(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2) }] };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runMcp(opts: McpOptions = {}): Promise<void> {
  const verbose = opts.verbose ?? false;

  process.stderr.write(
    chalk.green('usegraph MCP server started') +
      chalk.dim(' (stdio transport, tmcp)\n'),
  );
  process.stderr.write(chalk.dim(`  Parquet dir: ${BUILT_DIR}\n`));

  if (!existsSync(BUILT_DIR)) {
    process.stderr.write(
      chalk.yellow(
        `  Warning: ${BUILT_DIR} does not exist. Run \`usegraph build\` first.\n`,
      ),
    );
  }

  const [{ McpServer }, { ZodJsonSchemaAdapter }, { StdioTransport }] = await Promise.all([
    esmImport('tmcp'),
    esmImport('@tmcp/adapter-zod'),
    esmImport('@tmcp/transport-stdio'),
  ]) as [
    { McpServer: new (info: unknown, opts: unknown) => ServerLike },
    { ZodJsonSchemaAdapter: new () => unknown },
    { StdioTransport: new (server: unknown) => TransportLike },
  ];

  const server = new McpServer(
    { name: 'usegraph', version: '0.1.0' },
    { capabilities: { tools: {} }, adapter: new ZodJsonSchemaAdapter() },
  );

  if (verbose) {
    process.stderr.write(chalk.dim('[mcp] registering tools\n'));
  }

  // ── Discovery tools ────────────────────────────────────────────────────────

  server.tool(
    {
      name: 'get_scan_metadata',
      description: 'Return overall statistics about the usegraph data store: project count, oldest/newest scan, schema versions in use, and any projects with stale data.',
    },
    async () => wrap(await toolGetScanMetadata()),
  );

  server.tool(
    {
      name: 'list_projects',
      description: 'List projects with their latest scan metadata, optionally filtered by framework or build tool.',
      schema: z.object({
        framework: z.string().optional().describe('Filter to projects using this framework (e.g. "react", "next")'),
        build_tool: z.string().optional().describe('Filter to projects using this build tool (e.g. "vite", "webpack")'),
        stale_after_days: z.number().int().min(1).optional().describe('Flag projects not scanned within this many days'),
      }),
    },
    async (input) => wrap(await toolListProjects(input as Parameters<typeof toolListProjects>[0])),
  );

  server.tool(
    {
      name: 'list_packages',
      description: 'List npm packages detected across all projects, ranked by adoption count. Filter by scope, dependency type, or internal-only.',
      schema: z.object({
        scope: z.string().optional().describe('npm scope prefix, e.g. "@acme" to filter to @acme/* packages'),
        dep_type: z.string().optional().describe('Dependency section: "dependencies", "devDependencies", "peerDependencies", or "optionalDependencies"'),
        internal_only: z.boolean().optional().describe('If true, return only packages flagged as internal'),
      }),
    },
    async (input) => wrap(await toolListPackages(input as Parameters<typeof toolListPackages>[0])),
  );

  server.tool(
    {
      name: 'get_project_snapshot',
      description: 'Return the full latest snapshot for a project: tooling metadata and all its dependencies.',
      schema: z.object({
        project_id: z.string().describe('Project slug (e.g. "my-org--my-repo")'),
      }),
    },
    async (input) => wrap(await toolGetProjectSnapshot(input as Parameters<typeof toolGetProjectSnapshot>[0])),
  );

  // ── Dependency tools ───────────────────────────────────────────────────────

  server.tool(
    {
      name: 'query_dependency_versions',
      description: 'Show the distribution of resolved versions for a specific npm package across all projects.',
      schema: z.object({
        package_name: z.string().describe('Exact npm package name, e.g. "react"'),
        dep_type: z.string().optional().describe('Filter by dependency section (optional)'),
        include_prerelease: z.boolean().optional().describe('Include prerelease versions (default: false)'),
      }),
    },
    async (input) => wrap(await toolQueryDependencyVersions(input as Parameters<typeof toolQueryDependencyVersions>[0])),
  );

  server.tool(
    {
      name: 'query_prerelease_usage',
      description: 'Find projects using prerelease (alpha/beta/rc) builds of an npm package.',
      schema: z.object({
        package_name: z.string().describe('Exact npm package name'),
        prerelease_filter: z.string().optional().describe('Substring to match inside the prerelease tag (e.g. "beta", "acme")'),
      }),
    },
    async (input) => wrap(await toolQueryPrereleaseUsage(input as Parameters<typeof toolQueryPrereleaseUsage>[0])),
  );

  server.tool(
    {
      name: 'query_tooling_distribution',
      description: 'Show the distribution of a tooling category (framework, build tool, etc.) across all projects.',
      schema: z.object({
        category: z.enum(Array.from(TOOLING_CATEGORY_ALLOWLIST) as [string, ...string[]]).describe('Tooling category column name'),
      }),
    },
    async (input) => wrap(await toolQueryToolingDistribution(input as Parameters<typeof toolQueryToolingDistribution>[0])),
  );

  // ── Component tools ────────────────────────────────────────────────────────

  server.tool(
    {
      name: 'query_component_usage',
      description: 'Find all call sites where a React component from an npm package is used.',
      schema: z.object({
        package_name: z.string().describe('npm package that exports the component'),
        component_name: z.string().describe('Component name, e.g. "Button"'),
        package_version: z.number().int().optional().describe('Filter to a specific major version'),
        include_prerelease: z.boolean().optional().describe('Include prerelease package versions (default: false)'),
      }),
    },
    async (input) => wrap(await toolQueryComponentUsage(input as Parameters<typeof toolQueryComponentUsage>[0])),
  );

  server.tool(
    {
      name: 'query_prop_usage',
      description: 'Show how a specific prop is used on a React component across all projects: value types, static values, and source snippets for dynamic values.',
      schema: z.object({
        package_name: z.string().describe('npm package that exports the component'),
        component_name: z.string().describe('Component name'),
        prop_name: z.string().describe('Prop name, e.g. "variant"'),
        package_version: z.number().int().optional().describe('Filter to a specific major version'),
        include_prerelease: z.boolean().optional().describe('Include prerelease package versions'),
      }),
    },
    async (input) => wrap(await toolQueryPropUsage(input as Parameters<typeof toolQueryPropUsage>[0])),
  );

  server.tool(
    {
      name: 'query_component_adoption_trend',
      description: 'Show how many projects adopted a component (or an entire package) over time, grouped by month.',
      schema: z.object({
        package_name: z.string().describe('npm package name'),
        component_name: z.string().optional().describe('Optional: filter to a specific component'),
        period_months: z.number().int().min(1).optional().describe('How many months back to look (default: 12)'),
      }),
    },
    async (input) => wrap(await toolQueryComponentAdoptionTrend(input as Parameters<typeof toolQueryComponentAdoptionTrend>[0])),
  );

  // ── Function / export tools ────────────────────────────────────────────────

  server.tool(
    {
      name: 'query_export_usage',
      description: 'Find all call sites for a specific function export from an npm package, including argument values.',
      schema: z.object({
        package_name: z.string().describe('npm package that exports the function'),
        export_name: z.string().describe('Exported function name, e.g. "createTheme"'),
        package_version: z.number().int().optional().describe('Filter to a specific major version'),
        include_prerelease: z.boolean().optional().describe('Include prerelease package versions'),
      }),
    },
    async (input) => wrap(await toolQueryExportUsage(input as Parameters<typeof toolQueryExportUsage>[0])),
  );

  server.tool(
    {
      name: 'query_export_adoption_trend',
      description: 'Show how many projects call a specific function export over time, grouped by month.',
      schema: z.object({
        package_name: z.string().describe('npm package name'),
        export_name: z.string().describe('Exported function name'),
        period_months: z.number().int().min(1).optional().describe('How many months back to look (default: 12)'),
      }),
    },
    async (input) => wrap(await toolQueryExportAdoptionTrend(input as Parameters<typeof toolQueryExportAdoptionTrend>[0])),
  );

  server.tool(
    {
      name: 'get_source_context',
      description: 'Retrieve the stored source snippet and value for a specific prop or argument at a call site.',
      schema: z.object({
        project_id: z.string().describe('Project slug'),
        file_path: z.string().describe('Relative file path within the project'),
        line: z.number().int().min(1).describe('Line number of the call site'),
        prop_name: z.string().optional().describe('Prop name (for component props)'),
        arg_index: z.number().int().min(0).optional().describe('Argument index (for function calls)'),
      }),
    },
    async (input) => wrap(await toolGetSourceContext(input as Parameters<typeof toolGetSourceContext>[0])),
  );

  const transport = new StdioTransport(server as unknown);
  transport.listen();

  // Keep the process alive until stdin closes (StdioTransport calls process.exit on close)
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
  });
}
