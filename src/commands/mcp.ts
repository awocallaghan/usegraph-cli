/**
 * usegraph mcp — Model Context Protocol server over stdio.
 *
 * Exposes 13 tools that query the Parquet tables produced by `usegraph build`:
 *
 *   Discovery:
 *     get_scan_metadata         — overall stats about the data store
 *     query_scan_coverage       — project count scanned per month (for interpreting adoption trends)
 *     get_ecosystem_summary     — one-shot summary (counts, top packages, tooling)
 *     list_projects             — filtered project list
 *     list_packages             — packages used across projects
 *     get_project_snapshot      — full detail for one project
 *
 *   Dependencies:
 *     query_dependency_versions      — version distribution for a package
 *     query_prerelease_usage         — which projects use prerelease builds
 *     query_dependency_adoption_trend — adoption over time (any npm/Python package)
 *     query_tooling_distribution    — breakdown of a tooling category
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
import { McpServer } from 'tmcp';
import { ZodJsonSchemaAdapter } from '@tmcp/adapter-zod';
import { StdioTransport } from '@tmcp/transport-stdio';
import {
  getBuiltDir,
  TOOLING_CATEGORY_ALLOWLIST,
  queryParquet,
  requireParquet,
  sqlStr,
} from '../parquet-query.js';

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
      MIN(code_at)::VARCHAR                        AS oldest_code_at,
      MAX(code_at)::VARCHAR                        AS newest_code_at,
      array_agg(DISTINCT schema_version)           AS schema_versions,
      -- Staleness uses scanned_at: we want to know when the scan was last *run*
      COUNT(DISTINCT CASE
        WHEN scanned_at::TIMESTAMP < current_timestamp - INTERVAL 7 DAY
        THEN project_id END)::INTEGER              AS stale_project_count
    FROM read_parquet('${sqlStr(snapshotsPath)}')
  `);
  return rows[0] ?? {};
}

async function toolQueryScanCoverage(args: {
  period_months?: number;
}): Promise<unknown> {
  const p = requireParquet('project_snapshots');
  const months = typeof args.period_months === 'number' ? args.period_months : 12;
  return queryParquet(`
    WITH
      months AS (
        SELECT date_trunc('month', current_date - INTERVAL (g) MONTH)::DATE AS period
        FROM (SELECT unnest(generate_series(0, ${months - 1})) AS g)
      ),
      by_month AS (
        SELECT
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS period,
          COUNT(DISTINCT project_id)::INTEGER AS projects_scanned
        FROM read_parquet('${sqlStr(p)}')
        GROUP BY 1
      )
    SELECT
      m.period::VARCHAR AS period,
      COALESCE(b.projects_scanned, 0)::INTEGER AS projects_scanned
    FROM months m
    LEFT JOIN by_month b ON b.period = m.period
    ORDER BY m.period
  `);
}

const ECOSYSTEM_TOOLING_CATEGORIES = [
  'framework',
  'build_tool',
  'package_manager',
  'test_framework',
  'python_framework',
  'python_package_manager',
] as const;

async function toolGetEcosystemSummary(args: {
  top_packages_limit?: number;
  language?: 'javascript' | 'python';
}): Promise<unknown> {
  const limit = Math.min(Math.max(1, args.top_packages_limit ?? 20), 200);
  const sp = requireParquet('project_snapshots');
  const dp = requireParquet('dependencies');
  const langFilter = args.language === 'python'
    ? `AND (python_package_manager IS NOT NULL OR python_framework IS NOT NULL)`
    : args.language === 'javascript'
    ? `AND (python_package_manager IS NULL AND python_framework IS NULL)`
    : '';

  const [projectCountsRows, jsPackages, pyPackages, toolingResult] = await Promise.all([
    queryParquet(`
      SELECT
        CASE
          WHEN (python_package_manager IS NOT NULL OR python_framework IS NOT NULL)
               AND (framework IS NOT NULL OR package_manager IS NOT NULL) THEN 'both'
          WHEN python_package_manager IS NOT NULL OR python_framework IS NOT NULL THEN 'python'
          ELSE 'javascript'
        END AS language,
        COUNT(DISTINCT project_id)::INTEGER AS project_count
      FROM read_parquet('${sqlStr(sp)}')
      WHERE is_latest = true ${langFilter}
      GROUP BY 1
    `),
    args.language === 'python'
      ? Promise.resolve([])
      : queryParquet(`
          SELECT package_name, COUNT(DISTINCT project_id)::INTEGER AS project_count
          FROM read_parquet('${sqlStr(dp)}')
          WHERE is_latest = true AND language = 'javascript'
          GROUP BY package_name
          ORDER BY project_count DESC
          LIMIT ${limit}
        `),
    args.language === 'javascript'
      ? Promise.resolve([])
      : queryParquet(`
          SELECT package_name, COUNT(DISTINCT project_id)::INTEGER AS project_count
          FROM read_parquet('${sqlStr(dp)}')
          WHERE is_latest = true AND language = 'python'
          GROUP BY package_name
          ORDER BY project_count DESC
          LIMIT ${limit}
        `),
    toolQueryToolingDistribution({
      categories: [...ECOSYSTEM_TOOLING_CATEGORIES],
    }) as Promise<Record<string, Array<{ value: string; project_count: number; projects: string[] }>>>,
  ]);

  const project_counts_by_language: Record<string, number> = {};
  for (const row of projectCountsRows as Array<{ language: string; project_count: number }>) {
    project_counts_by_language[row.language] = row.project_count;
  }

  const top_packages: Record<string, Array<{ package_name: string; project_count: number }>> = {};
  if (!args.language || args.language === 'javascript') {
    top_packages.javascript = (jsPackages as Array<{ package_name: string; project_count: number }>).map((r) => ({
      package_name: r.package_name,
      project_count: r.project_count,
    }));
  }
  if (!args.language || args.language === 'python') {
    top_packages.python = (pyPackages as Array<{ package_name: string; project_count: number }>).map((r) => ({
      package_name: r.package_name,
      project_count: r.project_count,
    }));
  }

  return {
    project_counts_by_language,
    top_packages,
    tooling: toolingResult,
  };
}

async function toolListProjects(args: {
  framework?: string;
  build_tool?: string;
  stale_after_days?: number;
  language?: 'javascript' | 'python';
  count_only?: boolean;
}): Promise<unknown> {
  const p = requireParquet('project_snapshots');
  const frameworkFilter = args.framework
    ? `AND (framework = '${sqlStr(args.framework)}' OR python_framework = '${sqlStr(args.framework)}')`
    : '';
  const buildToolFilter = args.build_tool
    ? `AND build_tool = '${sqlStr(args.build_tool)}'`
    : '';
  const staleDays = typeof args.stale_after_days === 'number' ? args.stale_after_days : 7;
  const languageFilter = args.language === 'python'
    ? `AND (python_package_manager IS NOT NULL OR python_framework IS NOT NULL)`
    : args.language === 'javascript'
    ? `AND (python_package_manager IS NULL AND python_framework IS NULL)`
    : '';
  if (args.count_only === true) {
    const rows = await queryParquet(`
      SELECT COUNT(DISTINCT project_id)::INTEGER AS project_count
      FROM read_parquet('${sqlStr(p)}')
      WHERE is_latest = true
        ${frameworkFilter}
        ${buildToolFilter}
        ${languageFilter}
    `);
    const count = (rows[0] as { project_count: number })?.project_count ?? 0;
    return { project_count: count, ...(args.language && { language: args.language }) };
  }
  return queryParquet(`
    SELECT
      project_id,
      repo_url,
      scanned_at::VARCHAR                                        AS scanned_at,
      COALESCE(framework, python_framework)                      AS framework,
      build_tool,
      test_framework,
      typescript,
      COALESCE(package_manager, python_package_manager)         AS package_manager,
      python_version,
      CASE
        WHEN (python_package_manager IS NOT NULL OR python_framework IS NOT NULL)
             AND (framework IS NOT NULL OR package_manager IS NOT NULL) THEN 'both'
        WHEN python_package_manager IS NOT NULL OR python_framework IS NOT NULL THEN 'python'
        ELSE 'javascript'
      END AS language,
      (scanned_at::TIMESTAMP < current_timestamp - INTERVAL ${staleDays} DAY) AS is_stale
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${frameworkFilter}
      ${buildToolFilter}
      ${languageFilter}
    ORDER BY project_id
    LIMIT 100
  `);
}

async function toolListPackages(args: {
  scope?: string;
  name_prefix?: string;
  dep_type?: string;
  language?: string;
  limit?: number;
  include_versions?: boolean;
  min_projects?: number;
}): Promise<unknown> {
  const p = requireParquet('dependencies');
  const scopeFilter = args.scope
    ? `AND package_name LIKE '${sqlStr(args.scope)}/%'`
    : '';
  const namePrefixFilter = args.name_prefix
    ? `AND package_name LIKE '${sqlStr(args.name_prefix)}%'`
    : '';
  const depTypeFilter = args.dep_type
    ? `AND dep_type = '${sqlStr(args.dep_type)}'`
    : '';
  const langFilter = args.language
    ? `AND language = '${sqlStr(args.language)}'`
    : '';
  const limit = Math.min(Math.max(1, args.limit ?? 100), 1000);
  const havingFilter =
    typeof args.min_projects === 'number' && args.min_projects >= 1
      ? `HAVING COUNT(DISTINCT project_id) >= ${args.min_projects}`
      : '';
  const versionsSelect =
    args.include_versions !== false
      ? ', array_agg(DISTINCT version_resolved) AS versions_seen'
      : '';
  return queryParquet(`
    SELECT
      package_name,
      COUNT(DISTINCT project_id)::INTEGER AS project_count
      ${versionsSelect}
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${scopeFilter}
      ${namePrefixFilter}
      ${depTypeFilter}
      ${langFilter}
    GROUP BY package_name
    ${havingFilter}
    ORDER BY project_count DESC
    LIMIT ${limit}
  `);
}

async function toolGetProjectSnapshot(args: {
  project_id: string;
  as_of_period?: string;
}): Promise<unknown> {
  const sp = requireParquet('project_snapshots');
  const dp = requireParquet('dependencies');
  const id = sqlStr(args.project_id);
  const asOfPeriod = args.as_of_period;
  const periodFilter =
    asOfPeriod != null && asOfPeriod !== ''
      ? `AND date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE <= '${sqlStr(asOfPeriod)}'::DATE`
      : '';

  const [snapshot, deps] = await Promise.all([
    queryParquet(`
      SELECT * FROM read_parquet('${sqlStr(sp)}')
      WHERE project_id = '${id}' AND is_latest = true
      ${periodFilter}
      LIMIT 1
    `),
    queryParquet(`
      SELECT package_name, version_range, version_resolved, dep_type
      FROM read_parquet('${sqlStr(dp)}')
      WHERE project_id = '${id}' AND is_latest = true
      ${periodFilter}
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
  language?: string;
  as_of_period?: string;
}): Promise<unknown> {
  const p = requireParquet('dependencies');
  const nameFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const depTypeFilter = args.dep_type
    ? `AND dep_type = '${sqlStr(args.dep_type)}'`
    : '';
  const prereleaseFilter =
    args.include_prerelease === true ? '' : `AND version_is_prerelease = false`;
  const langFilter = args.language
    ? `AND language = '${sqlStr(args.language)}'`
    : '';
  const asOfPeriod = args.as_of_period;
  if (asOfPeriod == null || asOfPeriod === '') {
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
        ${langFilter}
      GROUP BY version_resolved, version_major, version_minor, version_patch, version_prerelease
      ORDER BY version_major DESC, version_minor DESC, version_patch DESC
      LIMIT 100
    `);
  }
  // Restrict to projects whose last scan month is on or before as_of_period (same carry-forward as adoption trend).
  const periodStr = sqlStr(asOfPeriod);
  return queryParquet(`
    WITH deps AS (
      SELECT
        project_id,
        version_resolved,
        version_major,
        version_minor,
        version_patch,
        version_prerelease,
        date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
      FROM read_parquet('${sqlStr(p)}')
      WHERE is_latest = true
        ${nameFilter}
        ${depTypeFilter}
        ${prereleaseFilter}
        ${langFilter}
    )
    SELECT
      d.version_resolved,
      d.version_major,
      d.version_minor,
      d.version_patch,
      d.version_prerelease,
      COUNT(DISTINCT d.project_id)::INTEGER AS project_count,
      array_agg(DISTINCT d.project_id)     AS projects
    FROM deps d
    WHERE d.scan_month <= '${periodStr}'::DATE
    GROUP BY d.version_resolved, d.version_major, d.version_minor, d.version_patch, d.version_prerelease
    ORDER BY d.version_major DESC, d.version_minor DESC, d.version_patch DESC
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

function applyProjectsLimit<T extends { projects?: string[] }>(
  rows: T[],
  limit?: number,
): (T & { projects_truncated?: boolean })[] {
  if (limit == null || limit < 1) return rows as (T & { projects_truncated?: boolean })[];
  return rows.map((row) => {
    const projects = row.projects;
    if (!Array.isArray(projects) || projects.length <= limit) return row as T & { projects_truncated?: boolean };
    return {
      ...row,
      projects: projects.slice(0, limit),
      projects_truncated: true,
    };
  });
}

async function toolQueryDependencyAdoptionTrend(args: {
  package_name: string;
  language?: string;
  period_months?: number;
  include_projects?: boolean;
  projects_limit?: number;
}): Promise<unknown> {
  const p = requireParquet('dependencies');
  const months = typeof args.period_months === 'number' ? args.period_months : 12;
  const includeProjects = args.include_projects === true;
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const langFilter = args.language
    ? `AND language = '${sqlStr(args.language)}'`
    : '';
  const projectsSelect = includeProjects
    ? ', array_agg(DISTINCT lpm.project_id) AS projects'
    : '';
  // Carry-forward CTE: for each month in the window, count projects whose most recent scan
  // up to that month showed them depending on this package. Supports any npm or Python package.
  const rows = await queryParquet(`
    WITH
      months AS (
        SELECT date_trunc('month', current_date - INTERVAL (g) MONTH)::DATE AS period
        FROM (SELECT unnest(generate_series(0, ${months - 1})) AS g)
      ),
      project_scan_months AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE is_latest = true
          ${pkgFilter}
          ${langFilter}
      ),
      latest_per_project_month AS (
        SELECT
          m.period,
          psm.project_id,
          MAX(psm.scan_month) AS latest_scan_month
        FROM months m
        JOIN project_scan_months psm ON psm.scan_month <= m.period
        GROUP BY m.period, psm.project_id
      ),
      adopters AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE is_latest = true
          ${pkgFilter}
          ${langFilter}
      )
    SELECT
      lpm.period::VARCHAR AS period,
      COUNT(DISTINCT lpm.project_id)::INTEGER AS adopting_projects
      ${projectsSelect}
    FROM latest_per_project_month lpm
    JOIN adopters a
      ON a.project_id = lpm.project_id
      AND a.scan_month = lpm.latest_scan_month
    GROUP BY lpm.period
    ORDER BY lpm.period
  `);
  if (!includeProjects) return rows;
  return applyProjectsLimit(
    rows as Array<{ period: string; adopting_projects: number; projects?: string[] }>,
    args.projects_limit,
  );
}

async function toolQueryToolingDistribution(args: {
  category?: string;
  categories?: string[];
}): Promise<unknown> {
  const rawCategories = args.categories ?? (args.category ? [args.category] : []);
  const categories = rawCategories.length > 0
    ? rawCategories
    : Array.from(TOOLING_CATEGORY_ALLOWLIST);
  for (const c of categories) {
    if (!TOOLING_CATEGORY_ALLOWLIST.has(c)) {
      throw new Error(
        `Invalid category "${c}". Must be one of: ${Array.from(TOOLING_CATEGORY_ALLOWLIST).join(', ')}`,
      );
    }
  }
  const p = requireParquet('project_snapshots');
  const results = await Promise.all(
    categories.map(async (col) => {
      const rows = await queryParquet(`
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
      return { category: col, rows };
    }),
  );
  const out: Record<string, Array<{ value: string; project_count: number; projects: string[] }>> = {};
  for (const { category, rows } of results) {
    out[category] = rows as Array<{ value: string; project_count: number; projects: string[] }>;
  }
  return out;
}

async function toolQueryComponentUsage(args: {
  package_name: string;
  component_name: string;
  package_version?: number;
  include_prerelease?: boolean;
  project_id?: string;
  as_of_period?: string;
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
  const projectFilter = args.project_id
    ? `AND project_id = '${sqlStr(args.project_id)}'`
    : '';
  const asOfPeriod = args.as_of_period;
  const periodFilter =
    asOfPeriod != null && asOfPeriod !== ''
      ? `AND date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE <= '${sqlStr(asOfPeriod)}'::DATE`
      : '';
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
      ${projectFilter}
      ${periodFilter}
    ORDER BY project_id, file_path, line
    LIMIT 100
  `);
}

async function toolQueryPropUsage(args: {
  package_name: string;
  component_name: string;
  prop_name?: string;
  package_version?: number;
  include_prerelease?: boolean;
}): Promise<unknown> {
  const p = requireParquet('component_prop_usages');
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const compFilter = `AND component_name = '${sqlStr(args.component_name)}'`;
  const propFilter = args.prop_name
    ? `AND prop_name = '${sqlStr(args.prop_name)}'`
    : '';
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
      prop_name,
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
    ORDER BY prop_name, project_id, file_path, line
    LIMIT 200
  `);
}

async function toolQueryComponentAdoptionTrend(args: {
  package_name: string;
  component_name?: string;
  period_months?: number;
  include_projects?: boolean;
  projects_limit?: number;
}): Promise<unknown> {
  const p = requireParquet('component_usages');
  const months = typeof args.period_months === 'number' ? args.period_months : 12;
  const includeProjects = args.include_projects === true;
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const compFilter = args.component_name
    ? `AND component_name = '${sqlStr(args.component_name)}'`
    : '';
  const projectsSelect = includeProjects
    ? ', array_agg(DISTINCT lpm.project_id) AS projects'
    : '';
  // Carry-forward CTE: for each month in the window, count projects whose most recent scan
  // up to that month showed them using the package. This ensures projects last scanned before
  // the window still contribute their last known state rather than being silently dropped.
  const rows = await queryParquet(`
    WITH
      months AS (
        SELECT date_trunc('month', current_date - INTERVAL (g) MONTH)::DATE AS period
        FROM (SELECT unnest(generate_series(0, ${months - 1})) AS g)
      ),
      project_scan_months AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)
          ${pkgFilter}
          ${compFilter}
      ),
      latest_per_project_month AS (
        SELECT
          m.period,
          psm.project_id,
          MAX(psm.scan_month) AS latest_scan_month
        FROM months m
        JOIN project_scan_months psm ON psm.scan_month <= m.period
        GROUP BY m.period, psm.project_id
      ),
      adopters AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)
          ${pkgFilter}
          ${compFilter}
      )
    SELECT
      lpm.period::VARCHAR AS period,
      COUNT(DISTINCT lpm.project_id)::INTEGER AS adopting_projects
      ${projectsSelect}
    FROM latest_per_project_month lpm
    JOIN adopters a
      ON a.project_id = lpm.project_id
      AND a.scan_month = lpm.latest_scan_month
    GROUP BY lpm.period
    ORDER BY lpm.period
  `);
  if (!includeProjects) return rows;
  return applyProjectsLimit(
    rows as Array<{ period: string; adopting_projects: number; projects?: string[] }>,
    args.projects_limit,
  );
}

async function toolQueryExportUsage(args: {
  package_name: string;
  export_name: string;
  package_version?: number;
  include_prerelease?: boolean;
  project_id?: string;
  as_of_period?: string;
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
  const projectFilter = args.project_id
    ? `AND fu.project_id = '${sqlStr(args.project_id)}'`
    : '';
  const asOfPeriod = args.as_of_period;
  const periodFilter =
    asOfPeriod != null && asOfPeriod !== ''
      ? `AND date_trunc('month', COALESCE(fu.code_at::VARCHAR, fu.scanned_at::VARCHAR)::TIMESTAMP)::DATE <= '${sqlStr(asOfPeriod)}'::DATE`
      : '';
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
      ${projectFilter}
      ${periodFilter}
    ORDER BY fu.project_id, fu.file_path, fu.line, fau.arg_index
    LIMIT 100
  `);
}

async function toolQueryExportAdoptionTrend(args: {
  package_name: string;
  export_name: string;
  period_months?: number;
  include_projects?: boolean;
  projects_limit?: number;
}): Promise<unknown> {
  const p = requireParquet('function_usages');
  const months = typeof args.period_months === 'number' ? args.period_months : 12;
  const includeProjects = args.include_projects === true;
  const pkgFilter = `AND package_name = '${sqlStr(args.package_name)}'`;
  const expFilter = `AND export_name = '${sqlStr(args.export_name)}'`;
  const projectsSelect = includeProjects
    ? ', array_agg(DISTINCT lpm.project_id) AS projects'
    : '';
  // Carry-forward CTE: for each month in the window, count projects whose most recent scan
  // up to that month showed them calling this export. This ensures projects last scanned before
  // the window still contribute their last known state rather than being silently dropped.
  const rows = await queryParquet(`
    WITH
      months AS (
        SELECT date_trunc('month', current_date - INTERVAL (g) MONTH)::DATE AS period
        FROM (SELECT unnest(generate_series(0, ${months - 1})) AS g)
      ),
      project_scan_months AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)
          ${pkgFilter}
          ${expFilter}
      ),
      latest_per_project_month AS (
        SELECT
          m.period,
          psm.project_id,
          MAX(psm.scan_month) AS latest_scan_month
        FROM months m
        JOIN project_scan_months psm ON psm.scan_month <= m.period
        GROUP BY m.period, psm.project_id
      ),
      adopters AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE (package_version_is_prerelease = false OR package_version_is_prerelease IS NULL)
          ${pkgFilter}
          ${expFilter}
      )
    SELECT
      lpm.period::VARCHAR AS period,
      COUNT(DISTINCT lpm.project_id)::INTEGER AS adopting_projects
      ${projectsSelect}
    FROM latest_per_project_month lpm
    JOIN adopters a
      ON a.project_id = lpm.project_id
      AND a.scan_month = lpm.latest_scan_month
    GROUP BY lpm.period
    ORDER BY lpm.period
  `);
  if (!includeProjects) return rows;
  return applyProjectsLimit(
    rows as Array<{ period: string; adopting_projects: number; projects?: string[] }>,
    args.projects_limit,
  );
}

// ─── CI template tools ────────────────────────────────────────────────────────

async function toolListCiTemplates(args: {
  provider?: string;
  template_type?: string;
}): Promise<unknown> {
  const p = requireParquet('ci_template_usages');
  const providerFilter = args.provider
    ? `AND provider = '${sqlStr(args.provider)}'`
    : '';
  const typeFilter = args.template_type
    ? `AND template_type = '${sqlStr(args.template_type)}'`
    : '';
  return queryParquet(`
    SELECT
      source,
      provider,
      template_type,
      COUNT(DISTINCT project_id)::INTEGER AS project_count,
      array_agg(DISTINCT version)         AS versions_seen,
      array_agg(DISTINCT project_id)      AS projects
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${providerFilter}
      ${typeFilter}
    GROUP BY source, provider, template_type
    ORDER BY project_count DESC
    LIMIT 100
  `);
}

async function toolQueryCiTemplateUsage(args: {
  source: string;
  provider?: string;
}): Promise<unknown> {
  const p = requireParquet('ci_template_usages');
  const srcFilter = `AND source = '${sqlStr(args.source)}'`;
  const providerFilter = args.provider
    ? `AND provider = '${sqlStr(args.provider)}'`
    : '';
  return queryParquet(`
    SELECT
      project_id,
      provider,
      template_type,
      version,
      file_path,
      line
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${srcFilter}
      ${providerFilter}
    ORDER BY project_id, file_path, line
    LIMIT 200
  `);
}

async function toolQueryCiTemplateInputs(args: {
  source: string;
  input_name?: string;
}): Promise<unknown> {
  const p = requireParquet('ci_template_inputs');
  const srcFilter = `AND source = '${sqlStr(args.source)}'`;
  const nameFilter = args.input_name
    ? `AND input_name = '${sqlStr(args.input_name)}'`
    : '';
  return queryParquet(`
    SELECT
      input_name,
      value_type,
      value,
      COUNT(DISTINCT project_id)::INTEGER AS project_count,
      array_agg(DISTINCT project_id)      AS projects
    FROM read_parquet('${sqlStr(p)}')
    WHERE is_latest = true
      ${srcFilter}
      ${nameFilter}
    GROUP BY input_name, value_type, value
    ORDER BY input_name, project_count DESC
    LIMIT 200
  `);
}

async function toolQueryCiTemplateAdoptionTrend(args: {
  source: string;
  period_months?: number;
  include_projects?: boolean;
  projects_limit?: number;
}): Promise<unknown> {
  const p = requireParquet('ci_template_usages');
  const months = typeof args.period_months === 'number' ? args.period_months : 12;
  const includeProjects = args.include_projects === true;
  const srcFilter = `AND source = '${sqlStr(args.source)}'`;
  const projectsSelect = includeProjects
    ? ', array_agg(DISTINCT lpm.project_id) AS projects'
    : '';
  const rows = await queryParquet(`
    WITH
      months AS (
        SELECT date_trunc('month', current_date - INTERVAL (g) MONTH)::DATE AS period
        FROM (SELECT unnest(generate_series(0, ${months - 1})) AS g)
      ),
      project_scan_months AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE true ${srcFilter}
      ),
      latest_per_project_month AS (
        SELECT
          m.period,
          psm.project_id,
          MAX(psm.scan_month) AS latest_scan_month
        FROM months m
        JOIN project_scan_months psm ON psm.scan_month <= m.period
        GROUP BY m.period, psm.project_id
      ),
      adopters AS (
        SELECT DISTINCT
          project_id,
          date_trunc('month', COALESCE(code_at::VARCHAR, scanned_at::VARCHAR)::TIMESTAMP)::DATE AS scan_month
        FROM read_parquet('${sqlStr(p)}')
        WHERE true ${srcFilter}
      )
    SELECT
      lpm.period::VARCHAR AS period,
      COUNT(DISTINCT lpm.project_id)::INTEGER AS adopting_projects
      ${projectsSelect}
    FROM latest_per_project_month lpm
    JOIN adopters a
      ON a.project_id = lpm.project_id
      AND a.scan_month = lpm.latest_scan_month
    GROUP BY lpm.period
    ORDER BY lpm.period
  `);
  if (!includeProjects) return rows;
  return applyProjectsLimit(
    rows as Array<{ period: string; adopting_projects: number; projects?: string[] }>,
    args.projects_limit,
  );
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
    case 'query_scan_coverage':
      return toolQueryScanCoverage(args as Parameters<typeof toolQueryScanCoverage>[0]);
    case 'get_ecosystem_summary':
      return toolGetEcosystemSummary(args as Parameters<typeof toolGetEcosystemSummary>[0]);
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
    case 'query_dependency_adoption_trend':
      return toolQueryDependencyAdoptionTrend(
        args as Parameters<typeof toolQueryDependencyAdoptionTrend>[0],
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
    case 'list_ci_templates':
      return toolListCiTemplates(args as Parameters<typeof toolListCiTemplates>[0]);
    case 'query_ci_template_usage':
      return toolQueryCiTemplateUsage(args as Parameters<typeof toolQueryCiTemplateUsage>[0]);
    case 'query_ci_template_inputs':
      return toolQueryCiTemplateInputs(args as Parameters<typeof toolQueryCiTemplateInputs>[0]);
    case 'query_ci_template_adoption_trend':
      return toolQueryCiTemplateAdoptionTrend(args as Parameters<typeof toolQueryCiTemplateAdoptionTrend>[0]);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ─── MCP server (tmcp) ───────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

function wrap(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2) }] };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runMcp(opts: McpOptions = {}): Promise<void> {
  const verbose = opts.verbose ?? false;
  const builtDir = getBuiltDir();

  process.stderr.write(
    chalk.green('usegraph MCP server started') +
      chalk.dim(' (stdio transport, tmcp)\n'),
  );
  process.stderr.write(chalk.dim(`  Parquet dir: ${builtDir}\n`));

  if (!existsSync(builtDir)) {
    process.stderr.write(
      chalk.yellow(
        `  Warning: ${builtDir} does not exist. Run \`usegraph build\` first.\n`,
      ),
    );
  }

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
      name: 'query_scan_coverage',
      description: 'Return how many projects had at least one scan in each month over a time window. Use this to interpret adoption trends: low counts in early months may be due to fewer projects scanned in that period rather than lower adoption. Compare with query_dependency_adoption_trend to distinguish real adoption from scan rollout.',
      schema: z.object({
        period_months: z.number().int().min(1).optional().describe('How many months back to include (default: 12)'),
      }),
    },
    async (input) => wrap(await toolQueryScanCoverage(input as Parameters<typeof toolQueryScanCoverage>[0])),
  );

  server.tool(
    {
      name: 'get_ecosystem_summary',
      description: 'One-shot summary: project counts by language (javascript, python, both), top N packages per language (no versions_seen), and key tooling distributions (framework, build_tool, package_manager, test_framework, python_framework, python_package_manager). Reduces round-trips for "current state by language".',
      schema: z.object({
        top_packages_limit: z.number().int().min(1).max(200).optional().describe('Max number of top packages per language (default: 20)'),
        language: z.enum(['javascript', 'python']).optional().describe('If set, limit summary to this language only'),
      }),
    },
    async (input) => wrap(await toolGetEcosystemSummary(input as Parameters<typeof toolGetEcosystemSummary>[0])),
  );

  server.tool(
    {
      name: 'list_projects',
      description: 'List projects with their latest scan metadata, optionally filtered by framework, build tool, or language. Use count_only: true to get just the project count without the full list.',
      schema: z.object({
        framework: z.string().optional().describe('Filter to projects using this framework (e.g. "react", "next", "fastapi", "flask")'),
        build_tool: z.string().optional().describe('Filter to projects using this build tool (e.g. "vite", "webpack")'),
        stale_after_days: z.number().int().min(1).optional().describe('Flag projects not scanned within this many days'),
        language: z.enum(['javascript', 'python']).optional().describe('Filter to projects of a specific language ecosystem'),
        count_only: z.boolean().optional().describe('If true, return only { project_count, language? } without the project list'),
      }),
    },
    async (input) => wrap(await toolListProjects(input as Parameters<typeof toolListProjects>[0])),
  );

  server.tool(
    {
      name: 'list_packages',
      description: 'List packages (npm or Python) detected across all projects, ranked by adoption count. Filter by scope (npm), name_prefix (e.g. Python internal packages), dependency type, or language. For internal packages use scope (npm, e.g. "@mintel") and name_prefix (Python, e.g. "mintel").',
      schema: z.object({
        scope: z.string().optional().describe('npm scope prefix, e.g. "@acme" to filter to @acme/* packages'),
        name_prefix: z.string().optional().describe('Filter to packages whose name starts with this string (e.g. "mintel" for Python internal packages)'),
        dep_type: z.string().optional().describe('Dependency section: "dependencies", "devDependencies", "peerDependencies", or "optionalDependencies"'),
        language: z.string().optional().describe('Filter to a specific language ecosystem: "javascript" or "python"'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max number of packages to return (default: 100)'),
        include_versions: z.boolean().optional().describe('If false, omit versions_seen to reduce payload size (default: true)'),
        min_projects: z.number().int().min(1).optional().describe('Only include packages used in at least this many projects'),
      }),
    },
    async (input) => wrap(await toolListPackages(input as Parameters<typeof toolListPackages>[0])),
  );

  server.tool(
    {
      name: 'get_project_snapshot',
      description: 'Return the full latest snapshot for a project: tooling metadata and all its dependencies. Use as_of_period to get the project\'s state as of a past month; then diff with a call without it to see what changed. If as_of_period is set and the project had not been scanned on or before that month, snapshot and dependencies are null/empty.',
      schema: z.object({
        project_id: z.string().describe('Project slug (e.g. "my-org--my-repo")'),
        as_of_period: z.string().optional().describe('ISO date (e.g. first day of month). If set, return snapshot only if the project had been scanned on or before that month; otherwise snapshot and dependencies are null/empty.'),
      }),
    },
    async (input) => wrap(await toolGetProjectSnapshot(input as Parameters<typeof toolGetProjectSnapshot>[0])),
  );

  // ── Dependency tools ───────────────────────────────────────────────────────

  server.tool(
    {
      name: 'query_dependency_versions',
      description: 'Show the distribution of resolved versions for a specific npm or Python package across all projects. Use as_of_period to get version distribution and project list as of a past month (e.g. "2026-01-01"); you can then diff with current state to see new vs removed adopters.',
      schema: z.object({
        package_name: z.string().describe('Exact package name, e.g. "react" or "fastapi"'),
        dep_type: z.string().optional().describe('Filter by dependency section (optional)'),
        include_prerelease: z.boolean().optional().describe('Include prerelease versions (default: false)'),
        language: z.string().optional().describe('Filter to a specific language ecosystem: "javascript" or "python"'),
        as_of_period: z.string().optional().describe('ISO date (e.g. first day of month). If set, return version distribution and project list as of that month (projects scanned on or before that month).'),
      }),
    },
    async (input) => wrap(await toolQueryDependencyVersions(input as Parameters<typeof toolQueryDependencyVersions>[0])),
  );

  server.tool(
    {
      name: 'query_prerelease_usage',
      description: 'Find projects using prerelease (alpha/beta/rc) builds of an npm or Python package.',
      schema: z.object({
        package_name: z.string().describe('Exact package name (npm or Python)'),
        prerelease_filter: z.string().optional().describe('Substring to match inside the prerelease tag (e.g. "beta", "acme")'),
      }),
    },
    async (input) => wrap(await toolQueryPrereleaseUsage(input as Parameters<typeof toolQueryPrereleaseUsage>[0])),
  );

  server.tool(
    {
      name: 'query_dependency_adoption_trend',
      description: 'Show how many projects have a given package as a dependency over time, grouped by month. Works for both npm and Python packages (e.g. react, webpack, fastapi, mintel-logging). Each month reflects each project\'s last known state; projects not scanned within the window are carried forward. Set include_projects: true to get the list of project IDs per period so you can diff consecutive months for "new" vs "removed" adopters. Returns an empty array if the package is not in the graph or has no scan data in the requested period. Counts in early months may be low if fewer projects were scanned then; interpret slopes with caution and use query_scan_coverage to compare with scan rollout.',
      schema: z.object({
        package_name: z.string().describe('Exact package name, e.g. "react", "webpack", "fastapi"'),
        language: z.string().optional().describe('Filter to "javascript" or "python"'),
        period_months: z.number().int().min(1).optional().describe('How many months back to look (default: 12)'),
        include_projects: z.boolean().optional().describe('If true, include the list of project IDs per period (same carry-forward semantics as the count). May increase payload size.'),
        projects_limit: z.number().int().min(1).max(2000).optional().describe('When include_projects is true, cap the number of project IDs per period; if exceeded, projects_truncated is set.'),
      }),
    },
    async (input) => wrap(await toolQueryDependencyAdoptionTrend(input as Parameters<typeof toolQueryDependencyAdoptionTrend>[0])),
  );

  server.tool(
    {
      name: 'query_tooling_distribution',
      description: 'Show the distribution of one or more tooling categories across all projects. Returns a keyed object, e.g. { "framework": [...], "build_tool": [...] }. Categories: framework, build_tool, package_manager, test_framework, linter, formatter, css_approach, typescript, python_framework, python_package_manager, python_version. Omit both params to get all categories.',
      schema: z.object({
        category: z.string().optional().describe('Single category (use categories for multiple)'),
        categories: z.array(z.string()).optional().describe('Category names to query in one call, e.g. ["framework", "build_tool", "test_framework"]'),
      }),
    },
    async (input) => wrap(await toolQueryToolingDistribution(input as Parameters<typeof toolQueryToolingDistribution>[0])),
  );

  // ── Component tools ────────────────────────────────────────────────────────

  server.tool(
    {
      name: 'query_component_usage',
      description: 'Find all call sites where a React component from an npm package is used. Use project_id to restrict to one project and as_of_period to get call sites as of a past month; diff two calls to see which component usages were added or removed in that project.',
      schema: z.object({
        package_name: z.string().describe('npm package that exports the component'),
        component_name: z.string().describe('Component name, e.g. "Button"'),
        package_version: z.number().int().optional().describe('Filter to a specific major version'),
        include_prerelease: z.boolean().optional().describe('Include prerelease package versions (default: false)'),
        project_id: z.string().optional().describe('If set, restrict results to this project.'),
        as_of_period: z.string().optional().describe('ISO date (e.g. first day of month). If set, return call sites only if the project had been scanned on or before that month.'),
      }),
    },
    async (input) => wrap(await toolQueryComponentUsage(input as Parameters<typeof toolQueryComponentUsage>[0])),
  );

  server.tool(
    {
      name: 'query_prop_usage',
      description: 'Show how props are used on a React component across all projects: value types, static values, and source snippets for dynamic values. Omit prop_name to return all props used on this component (useful for discovery).',
      schema: z.object({
        package_name: z.string().describe('npm package that exports the component'),
        component_name: z.string().describe('Component name'),
        prop_name: z.string().optional().describe('Prop name to filter to, e.g. "variant". Omit to return all props used on this component.'),
        package_version: z.number().int().optional().describe('Filter to a specific major version'),
        include_prerelease: z.boolean().optional().describe('Include prerelease package versions'),
      }),
    },
    async (input) => wrap(await toolQueryPropUsage(input as Parameters<typeof toolQueryPropUsage>[0])),
  );

  server.tool(
    {
      name: 'query_component_adoption_trend',
      description: 'Show how many projects use JSX components from an npm package over time, grouped by month. Data comes from component_usages (JSX call sites only). Set include_projects: true to get the list of project IDs per period for diffing "new" vs "removed" adopters. For general dependency adoption (e.g. webpack, @playwright/test), use query_dependency_adoption_trend instead. Returns an empty array if the package has no component usage data in the graph or no scans in the requested period.',
      schema: z.object({
        package_name: z.string().describe('npm package that exports the components'),
        component_name: z.string().optional().describe('Optional: filter to a specific component'),
        period_months: z.number().int().min(1).optional().describe('How many months back to look (default: 12)'),
        include_projects: z.boolean().optional().describe('If true, include the list of project IDs per period (same carry-forward semantics as the count). May increase payload size.'),
        projects_limit: z.number().int().min(1).max(2000).optional().describe('When include_projects is true, cap the number of project IDs per period; if exceeded, projects_truncated is set.'),
      }),
    },
    async (input) => wrap(await toolQueryComponentAdoptionTrend(input as Parameters<typeof toolQueryComponentAdoptionTrend>[0])),
  );

  // ── Function / export tools ────────────────────────────────────────────────

  server.tool(
    {
      name: 'query_export_usage',
      description: 'Find all call sites for a specific function or class export from an npm or Python package, including argument values. Use project_id to restrict to one project and as_of_period to get call sites as of a past month; diff two calls to see which export usages were added or removed in that project.',
      schema: z.object({
        package_name: z.string().describe('Package name (npm or Python) that exports the function, e.g. "fastapi" or "@acme/ui"'),
        export_name: z.string().describe('Exported function or class name, e.g. "FastAPI" or "createTheme"'),
        package_version: z.number().int().optional().describe('Filter to a specific major version'),
        include_prerelease: z.boolean().optional().describe('Include prerelease package versions'),
        project_id: z.string().optional().describe('If set, restrict results to this project.'),
        as_of_period: z.string().optional().describe('ISO date (e.g. first day of month). If set, return call sites only if the project had been scanned on or before that month.'),
      }),
    },
    async (input) => wrap(await toolQueryExportUsage(input as Parameters<typeof toolQueryExportUsage>[0])),
  );

  server.tool(
    {
      name: 'query_export_adoption_trend',
      description: 'Show how many projects call a specific function or class export over time, grouped by month. Works for both npm and Python packages. Each month reflects each project\'s last known state as of that month — projects not scanned within the window are carried forward from their most recent scan, so the count accurately represents adoption rather than scan activity. Set include_projects: true to get the list of project IDs per period for diffing "new" vs "removed" adopters.',
      schema: z.object({
        package_name: z.string().describe('Package name (npm or Python), e.g. "fastapi" or "@acme/ui"'),
        export_name: z.string().describe('Exported function or class name'),
        period_months: z.number().int().min(1).optional().describe('How many months back to look (default: 12)'),
        include_projects: z.boolean().optional().describe('If true, include the list of project IDs per period (same carry-forward semantics as the count). May increase payload size.'),
        projects_limit: z.number().int().min(1).max(2000).optional().describe('When include_projects is true, cap the number of project IDs per period; if exceeded, projects_truncated is set.'),
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

  // ── CI template tools ──────────────────────────────────────────────────────

  server.tool(
    {
      name: 'list_ci_templates',
      description: 'List all CI templates/actions used across the fleet, ranked by project adoption count. Optionally filter by provider (github|gitlab) or template_type.',
      schema: z.object({
        provider: z.string().optional().describe('Filter to a specific CI provider: "github" or "gitlab"'),
        template_type: z.string().optional().describe('Filter to a specific template type, e.g. "action", "reusable_workflow", "gitlab_component"'),
      }),
    },
    async (input) => wrap(await toolListCiTemplates(input as Parameters<typeof toolListCiTemplates>[0])),
  );

  server.tool(
    {
      name: 'query_ci_template_usage',
      description: 'Show which projects use a specific CI template or action, including the version pinned and the CI file where it appears.',
      schema: z.object({
        source: z.string().describe('Template source identifier, e.g. "actions/checkout" or "org/platform/.github/workflows/deploy.yml"'),
        provider: z.string().optional().describe('Filter to a specific CI provider: "github" or "gitlab"'),
      }),
    },
    async (input) => wrap(await toolQueryCiTemplateUsage(input as Parameters<typeof toolQueryCiTemplateUsage>[0])),
  );

  server.tool(
    {
      name: 'query_ci_template_inputs',
      description: 'Show the distribution of input values passed to a CI template across projects. Useful for understanding how teams configure a shared workflow or action.',
      schema: z.object({
        source: z.string().describe('Template source identifier, e.g. "actions/checkout"'),
        input_name: z.string().optional().describe('Filter to a specific input name (e.g. "node-version"). Omit to return all inputs.'),
      }),
    },
    async (input) => wrap(await toolQueryCiTemplateInputs(input as Parameters<typeof toolQueryCiTemplateInputs>[0])),
  );

  server.tool(
    {
      name: 'query_ci_template_adoption_trend',
      description: 'Show how many projects adopted a CI template over time, grouped by month. Uses carry-forward logic so projects not scanned recently still contribute their last known state. Set include_projects: true to get the list of project IDs per period for diffing "new" vs "removed" adopters.',
      schema: z.object({
        source: z.string().describe('Template source identifier, e.g. "actions/checkout"'),
        period_months: z.number().int().min(1).optional().describe('How many months back to look (default: 12)'),
        include_projects: z.boolean().optional().describe('If true, include the list of project IDs per period (same carry-forward semantics as the count). May increase payload size.'),
        projects_limit: z.number().int().min(1).max(2000).optional().describe('When include_projects is true, cap the number of project IDs per period; if exceeded, projects_truncated is set.'),
      }),
    },
    async (input) => wrap(await toolQueryCiTemplateAdoptionTrend(input as Parameters<typeof toolQueryCiTemplateAdoptionTrend>[0])),
  );

  const transport = new StdioTransport(server);
  transport.listen();

  // Keep the process alive until stdin closes (StdioTransport calls process.exit on close)
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
  });
}
