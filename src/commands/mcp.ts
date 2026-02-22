/**
 * usegraph mcp — Model Context Protocol server over stdio.
 *
 * Implements the MCP JSON-RPC 2.0 protocol directly (without the
 * @modelcontextprotocol/sdk package) using newline-delimited JSON over stdin/stdout.
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

import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import chalk from 'chalk';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Root of the global store.
 * Override with the `USEGRAPH_HOME` environment variable (useful for testing).
 */
const STORE_ROOT = process.env.USEGRAPH_HOME ?? join(homedir(), '.usegraph');
const BUILT_DIR = join(STORE_ROOT, 'built');

const PARQUET = {
  project_snapshots: join(BUILT_DIR, 'project_snapshots.parquet'),
  dependencies: join(BUILT_DIR, 'dependencies.parquet'),
  component_usages: join(BUILT_DIR, 'component_usages.parquet'),
  component_prop_usages: join(BUILT_DIR, 'component_prop_usages.parquet'),
  function_usages: join(BUILT_DIR, 'function_usages.parquet'),
  function_arg_usages: join(BUILT_DIR, 'function_arg_usages.parquet'),
} as const;

/** Tooling categories that may appear as a SQL column name */
const TOOLING_CATEGORY_ALLOWLIST = new Set([
  'test_framework',
  'build_tool',
  'package_manager',
  'bundler',
  'linter',
  'formatter',
  'css_approach',
  'framework',
  'typescript',
]);

// ─── CLI options ──────────────────────────────────────────────────────────────

export interface McpOptions {
  /** No longer a network port — MCP runs over stdio */
  verbose?: boolean;
}

// ─── MCP protocol types ───────────────────────────────────────────────────────

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── JSON Schema helpers for tool input schemas ───────────────────────────────

type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[] }
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'integer'; description?: string; minimum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'number'; description?: string };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
}

// ─── Tool definitions (SPEC §MCP Tools) ──────────────────────────────────────

const TOOLS: ToolDef[] = [
  // ── Discovery ────────────────────────────────────────────────────────────
  {
    name: 'get_scan_metadata',
    description:
      'Return overall statistics about the usegraph data store: project count, oldest/newest scan, schema versions in use, and any projects with stale data.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_projects',
    description:
      'List projects with their latest scan metadata, optionally filtered by framework or build tool.',
    inputSchema: {
      type: 'object',
      properties: {
        framework: { type: 'string', description: 'Filter to projects using this framework (e.g. "react", "next")' },
        build_tool: { type: 'string', description: 'Filter to projects using this build tool (e.g. "vite", "webpack")' },
        stale_after_days: {
          type: 'integer',
          description: 'Flag projects not scanned within this many days',
          minimum: 1,
        },
      },
    },
  },
  {
    name: 'list_packages',
    description:
      'List npm packages detected across all projects, ranked by adoption count. Filter by scope, dependency type, or internal-only.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'npm scope prefix, e.g. "@acme" to filter to @acme/* packages' },
        dep_type: {
          type: 'string',
          description: 'Dependency section: "dependencies", "devDependencies", "peerDependencies", or "optionalDependencies"',
        },
        internal_only: { type: 'boolean', description: 'If true, return only packages flagged as internal' },
      },
    },
  },
  {
    name: 'get_project_snapshot',
    description:
      'Return the full latest snapshot for a project: tooling metadata and all its dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project slug (e.g. "my-org--my-repo")' },
      },
      required: ['project_id'],
    },
  },

  // ── Dependency tools ─────────────────────────────────────────────────────
  {
    name: 'query_dependency_versions',
    description:
      'Show the distribution of resolved versions for a specific npm package across all projects.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'Exact npm package name, e.g. "react"' },
        dep_type: { type: 'string', description: 'Filter by dependency section (optional)' },
        include_prerelease: { type: 'boolean', description: 'Include prerelease versions (default: false)' },
      },
      required: ['package_name'],
    },
  },
  {
    name: 'query_prerelease_usage',
    description:
      'Find projects using prerelease (alpha/beta/rc) builds of an npm package.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'Exact npm package name' },
        prerelease_filter: {
          type: 'string',
          description: 'Substring to match inside the prerelease tag (e.g. "beta", "acme")',
        },
      },
      required: ['package_name'],
    },
  },
  {
    name: 'query_tooling_distribution',
    description:
      'Show the distribution of a tooling category (framework, build tool, etc.) across all projects.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Tooling category column name',
          enum: Array.from(TOOLING_CATEGORY_ALLOWLIST),
        },
      },
      required: ['category'],
    },
  },

  // ── Component tools ──────────────────────────────────────────────────────
  {
    name: 'query_component_usage',
    description:
      'Find all call sites where a React component from an npm package is used.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'npm package that exports the component' },
        component_name: { type: 'string', description: 'Component name, e.g. "Button"' },
        package_version: { type: 'integer', description: 'Filter to a specific major version' },
        include_prerelease: { type: 'boolean', description: 'Include prerelease package versions (default: false)' },
      },
      required: ['package_name', 'component_name'],
    },
  },
  {
    name: 'query_prop_usage',
    description:
      'Show how a specific prop is used on a React component across all projects: value types, static values, and source snippets for dynamic values.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'npm package that exports the component' },
        component_name: { type: 'string', description: 'Component name' },
        prop_name: { type: 'string', description: 'Prop name, e.g. "variant"' },
        package_version: { type: 'integer', description: 'Filter to a specific major version' },
        include_prerelease: { type: 'boolean', description: 'Include prerelease package versions' },
      },
      required: ['package_name', 'component_name', 'prop_name'],
    },
  },
  {
    name: 'query_component_adoption_trend',
    description:
      'Show how many projects adopted a component (or an entire package) over time, grouped by month.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'npm package name' },
        component_name: { type: 'string', description: 'Optional: filter to a specific component' },
        period_months: {
          type: 'integer',
          description: 'How many months back to look (default: 12)',
          minimum: 1,
        },
      },
      required: ['package_name'],
    },
  },

  // ── Function / export tools ──────────────────────────────────────────────
  {
    name: 'query_export_usage',
    description:
      'Find all call sites for a specific function export from an npm package, including argument values.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'npm package that exports the function' },
        export_name: { type: 'string', description: 'Exported function name, e.g. "createTheme"' },
        package_version: { type: 'integer', description: 'Filter to a specific major version' },
        include_prerelease: { type: 'boolean', description: 'Include prerelease package versions' },
      },
      required: ['package_name', 'export_name'],
    },
  },
  {
    name: 'query_export_adoption_trend',
    description:
      'Show how many projects call a specific function export over time, grouped by month.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'npm package name' },
        export_name: { type: 'string', description: 'Exported function name' },
        period_months: {
          type: 'integer',
          description: 'How many months back to look (default: 12)',
          minimum: 1,
        },
      },
      required: ['package_name', 'export_name'],
    },
  },
  {
    name: 'get_source_context',
    description:
      'Retrieve the stored source snippet and value for a specific prop or argument at a call site.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project slug' },
        file_path: { type: 'string', description: 'Relative file path within the project' },
        line: { type: 'integer', description: 'Line number of the call site', minimum: 1 },
        prop_name: { type: 'string', description: 'Prop name (for component props)' },
        arg_index: { type: 'integer', description: 'Argument index (for function calls)', minimum: 0 },
      },
      required: ['project_id', 'file_path', 'line'],
    },
  },
];

// ─── DuckDB helper ────────────────────────────────────────────────────────────

/** Open an in-memory DuckDB and run a query against the Parquet files. */
async function queryParquet(sql: string): Promise<Record<string, unknown>[]> {
  // Dynamic import — only load native module when mcp is invoked
  let duckdb: typeof import('duckdb');
  try {
    duckdb = await import('duckdb');
  } catch (err) {
    throw new Error(
      'DuckDB failed to load. Run `pnpm add duckdb && pnpm rebuild duckdb`.\n' +
        `  Original error: ${String(err)}`,
    );
  }

  const db = await new Promise<import('duckdb').Database>((resolve, reject) => {
    const inst = new duckdb.Database(':memory:', (err) => {
      if (err) reject(err);
      else resolve(inst);
    });
  });

  const conn = db.connect();

  try {
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      conn.all(sql, (err, result) => {
        if (err) reject(new Error((err as Error).message ?? String(err)));
        else resolve((result ?? []) as Record<string, unknown>[]);
      });
    });
    return rows;
  } finally {
    conn.close();
    await new Promise<void>((res) => db.close(() => res()));
  }
}

/** Escape a string value for embedding inside a SQL string literal. */
function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}

/** Check if a Parquet file exists, throw a clear error if not. */
function requireParquet(name: keyof typeof PARQUET): string {
  const path = PARQUET[name];
  if (!existsSync(path)) {
    throw new Error(
      `Parquet file not found: ${path}\n  Run \`usegraph build\` first.`,
    );
  }
  return path;
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
        WHEN scanned_at < current_timestamp - INTERVAL 7 DAY
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
      (scanned_at < current_timestamp - INTERVAL ${staleDays} DAY) AS is_stale
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

async function callTool(
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

// ─── MCP JSON-RPC server (stdio) ──────────────────────────────────────────────

/** Write a JSON-RPC response to stdout (newline-delimited JSON). */
function writeResponse(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n');
}

/** Handle a single parsed JSON-RPC request. */
async function handleRequest(req: JsonRpcRequest, verbose: boolean): Promise<void> {
  const id = req.id ?? null;

  if (verbose) {
    process.stderr.write(chalk.dim(`[mcp] → ${req.method}\n`));
  }

  // ── Protocol handshake ────────────────────────────────────────────────────
  if (req.method === 'initialize') {
    writeResponse({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'usegraph', version: '0.1.0' },
      },
    });
    return;
  }

  if (req.method === 'notifications/initialized' || req.method === 'initialized') {
    // Notification — no response required
    return;
  }

  if (req.method === 'ping') {
    writeResponse({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  // ── Tool listing ──────────────────────────────────────────────────────────
  if (req.method === 'tools/list') {
    writeResponse({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  // ── Tool execution ────────────────────────────────────────────────────────
  if (req.method === 'tools/call') {
    const params = req.params ?? {};
    const name = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (!name) {
      writeResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing tool name in params.name' },
      });
      return;
    }

    try {
      const result = await callTool(name, args);
      writeResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
    } catch (err) {
      const code = (err as { code?: number }).code ?? -32000;
      const message = err instanceof Error ? err.message : String(err);
      if (verbose) {
        process.stderr.write(chalk.red(`[mcp] tool error: ${message}\n`));
      }
      writeResponse({
        jsonrpc: '2.0',
        id,
        error: { code, message },
      });
    }
    return;
  }

  // ── Unknown method ────────────────────────────────────────────────────────
  if (id !== null) {
    writeResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runMcp(opts: McpOptions = {}): Promise<void> {
  const verbose = opts.verbose ?? false;

  process.stderr.write(
    chalk.green('usegraph MCP server started') +
      chalk.dim(' (stdio transport, newline-delimited JSON)\n'),
  );
  process.stderr.write(chalk.dim(`  Parquet dir: ${BUILT_DIR}\n`));

  if (!existsSync(BUILT_DIR)) {
    process.stderr.write(
      chalk.yellow(
        `  Warning: ${BUILT_DIR} does not exist. Run \`usegraph build\` first.\n`,
      ),
    );
  }

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    // Fire-and-forget — errors are caught inside handleRequest
    handleRequest(req, verbose).catch((err) => {
      process.stderr.write(
        chalk.red(`[mcp] Unhandled error: ${(err as Error).message ?? String(err)}\n`),
      );
    });
  });

  // Keep the process alive until stdin closes
  await new Promise<void>((resolve) => {
    rl.on('close', resolve);
  });
}
