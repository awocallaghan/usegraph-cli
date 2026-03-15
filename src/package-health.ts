/**
 * Query layer for the get_package_health MCP tool.
 *
 * Provides composable async functions that query the Parquet tables produced
 * by `usegraph build` and assemble a PackageHealthResult.
 *
 * Key schema notes (confirmed from src/commands/build.ts):
 *   - project_snapshots:   project_id, scanned_at, code_at, framework, python_framework
 *   - dependencies:        project_id, scanned_at, code_at, package_name, version_resolved,
 *                          version_major, version_prerelease, version_is_prerelease
 *   - component_usages:    project_id, scanned_at, code_at, package_name, component_name,
 *                          file_path, line
 *   - component_prop_usages: ...same + prop_name, value_type, value, source_snippet
 *   - function_usages:     project_id, scanned_at, code_at, package_name, export_name,
 *                          file_path, line   (note: column is export_name, not function_name)
 *   - function_arg_usages: ...same + arg_index, value_type ('static'|'dynamic'), value,
 *                          source_snippet
 *
 * Both JS/TS and Python function calls land in function_usages / function_arg_usages.
 * Python files produce no component_usages (componentUsages: []).
 */

import { requireParquet, queryParquet, sqlStr } from './parquet-query.js';
import type {
  PackageHealthResult,
  UsageSite,
  ArgDetail,
  ComponentDelta,
  VersionBucket,
} from './health.js';

// ─── Period parsing ────────────────────────────────────────────────────────────

/**
 * Resolve a period string to an absolute ISO date string (YYYY-MM-DD).
 * Relative formats: Xd (days), Xw (weeks), Xm (months), Xy (years).
 * ISO date strings are returned as-is.
 */
export function parsePeriod(s: string): string {
  const match = s.match(/^(\d+)(d|w|m|y)$/);
  if (!match) {
    // Return as-is (assume it's already a valid ISO date)
    return s.slice(0, 10);
  }
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();
  switch (unit) {
    case 'd': now.setDate(now.getDate() - num); break;
    case 'w': now.setDate(now.getDate() - num * 7); break;
    case 'm': now.setMonth(now.getMonth() - num); break;
    case 'y': now.setFullYear(now.getFullYear() - num); break;
  }
  return now.toISOString().slice(0, 10);
}

/** Compute the midpoint between two ISO date strings */
function midpointDate(from: string, to: string): string {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  return new Date((fromMs + toMs) / 2).toISOString().slice(0, 10);
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

interface ScanRef {
  project_id: string;
  scanned_at: string;
}

/** SQL helper: build an IN clause from an array of strings */
function sqlIn(values: string[]): string {
  if (values.length === 0) return '(NULL)';
  return `(${values.map((v) => `'${sqlStr(v)}'`).join(', ')})`;
}

/** SQL helper: test file exclusion WHERE clause (for both JS/TS and Python) */
const TEST_FILE_EXCLUSION = `
  AND NOT (
    file_path LIKE '%.test.ts'  OR file_path LIKE '%.test.tsx'
    OR file_path LIKE '%.test.js'  OR file_path LIKE '%.test.jsx'
    OR file_path LIKE '%.spec.ts'  OR file_path LIKE '%.spec.tsx'
    OR file_path LIKE '%.spec.js'  OR file_path LIKE '%.spec.jsx'
    OR file_path LIKE '%.stories.ts'  OR file_path LIKE '%.stories.tsx'
    OR file_path LIKE '%.stories.js'  OR file_path LIKE '%.stories.jsx'
  )
  AND NOT (
    file_path LIKE '%_test.py'
    OR (file_path LIKE '%.py' AND regexp_matches(file_path, '(^|/)test_[^/]+\\.py$'))
  )
`.trim();

// ─── Core query functions ──────────────────────────────────────────────────────

/**
 * For a given package and period window, returns the most recent scan per project
 * (scanned_at value) where the project had the package in its dependencies.
 *
 * When a project has multiple scans in the period, only the most recent is returned.
 * The effective date for ordering is COALESCE(code_at, scanned_at).
 */
export async function getLatestScanPerProject(
  pkg: string,
  from: string,
  to: string,
): Promise<ScanRef[]> {
  const dp = requireParquet('dependencies');
  const sql = `
    WITH ranked AS (
      SELECT
        project_id,
        scanned_at,
        ROW_NUMBER() OVER (
          PARTITION BY project_id
          ORDER BY COALESCE(code_at::VARCHAR, scanned_at::VARCHAR) DESC
        ) AS rn
      FROM read_parquet('${sqlStr(dp)}')
      WHERE package_name = '${sqlStr(pkg)}'
        AND COALESCE(code_at::VARCHAR, scanned_at::VARCHAR) >= '${sqlStr(from)}'
        AND COALESCE(code_at::VARCHAR, scanned_at::VARCHAR) <= '${sqlStr(to)} 23:59:59'
    )
    SELECT project_id, scanned_at
    FROM ranked
    WHERE rn = 1
    ORDER BY project_id
  `;
  return queryParquet(sql) as unknown as Promise<ScanRef[]>;
}

/**
 * Returns stable/added/removed project classification.
 *
 * Uses a FULL OUTER JOIN between projects scanned in each half-period.
 * The corpus is defined by projects that had the package in their dependencies.
 *
 * - stable: scanned in both period A and period B
 * - added: scanned in period B but not period A (new to corpus — excluded from deltas)
 * - removed: scanned in period A but not period B (dropped — excluded from deltas)
 */
export async function getStableCorpus(
  pkg: string,
  periodA: { from: string; to: string },
  periodB: { from: string; to: string },
): Promise<{ stable: string[]; added: string[]; removed: string[] }> {
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(pkg, periodA.from, periodA.to),
    getLatestScanPerProject(pkg, periodB.from, periodB.to),
  ]);

  const setA = new Set(scansA.map((s) => s.project_id));
  const setB = new Set(scansB.map((s) => s.project_id));

  const stable = [...setA].filter((p) => setB.has(p)).sort();
  const added = [...setB].filter((p) => !setA.has(p)).sort();
  const removed = [...setA].filter((p) => !setB.has(p)).sort();

  return { stable, added, removed };
}

/**
 * Returns adoption delta for the stable corpus.
 *
 * A project "adopts" the package in a period if it has the package listed
 * in its dependencies in its latest scan for that period.
 * (All stable corpus projects have it by definition, since corpus membership
 * is based on having it as a dependency — so this measures churn: projects
 * that DROPPED the dependency between periods.)
 */
export async function getAdoptionDelta(
  pkg: string,
  stableCorpus: string[],
  scansA: ScanRef[],
  scansB: ScanRef[],
): Promise<{
  start: number;
  end: number;
  delta: number;
  newAdopters: string[];
  churned: string[];
}> {
  if (stableCorpus.length === 0) {
    return { start: 0, end: 0, delta: 0, newAdopters: [], churned: [] };
  }

  const dp = requireParquet('dependencies');

  // Stable scans in each period
  const stableSet = new Set(stableCorpus);
  const stableScansA = scansA.filter((s) => stableSet.has(s.project_id));
  const stableScansB = scansB.filter((s) => stableSet.has(s.project_id));

  // For each period, find which projects have the package as a dependency
  // in their latest scan (i.e., they actually still list it).
  const buildAdoptersQuery = (scans: ScanRef[]): string => {
    if (scans.length === 0) return `SELECT NULL AS project_id WHERE 1=0`;
    const conditions = scans
      .map((s) => `(project_id = '${sqlStr(s.project_id)}' AND scanned_at = '${sqlStr(s.scanned_at)}')`)
      .join(' OR ');
    return `
      SELECT DISTINCT project_id
      FROM read_parquet('${sqlStr(dp)}')
      WHERE package_name = '${sqlStr(pkg)}'
        AND (${conditions})
    `;
  };

  const [adoptersARows, adoptersBRows] = await Promise.all([
    queryParquet(buildAdoptersQuery(stableScansA)),
    queryParquet(buildAdoptersQuery(stableScansB)),
  ]);

  const adoptersA = new Set(adoptersARows.map((r) => r.project_id as string));
  const adoptersB = new Set(adoptersBRows.map((r) => r.project_id as string));

  const start = adoptersA.size;
  const end = adoptersB.size;
  const newAdopters = [...adoptersB].filter((p) => !adoptersA.has(p)).sort();
  const churned = [...adoptersA].filter((p) => !adoptersB.has(p)).sort();

  return { start, end, delta: end - start, newAdopters, churned };
}

/**
 * Returns version distribution for period B (current state).
 * Flags prerelease versions (alpha/beta/rc) and projects lagging > 1 major.
 */
export async function getVersionDistribution(
  pkg: string,
  scansB: ScanRef[],
): Promise<{
  distribution: VersionBucket[];
  lagging: string[];
  prerelease: string[];
}> {
  if (scansB.length === 0) {
    return { distribution: [], lagging: [], prerelease: [] };
  }

  const dp = requireParquet('dependencies');
  const conditions = scansB
    .map((s) => `(project_id = '${sqlStr(s.project_id)}' AND scanned_at = '${sqlStr(s.scanned_at)}')`)
    .join(' OR ');

  const rows = await queryParquet(`
    SELECT
      project_id,
      version_resolved,
      version_major,
      version_prerelease,
      version_is_prerelease
    FROM read_parquet('${sqlStr(dp)}')
    WHERE package_name = '${sqlStr(pkg)}'
      AND (${conditions})
    ORDER BY project_id
  `);

  // Group into version buckets
  const bucketMap = new Map<string, { count: number; projects: string[] }>();
  let maxMajor = 0;
  const prereleaseProjects: string[] = [];

  for (const row of rows) {
    const version = (row.version_resolved as string | null) ?? 'unknown';
    const project = row.project_id as string;
    const major = (row.version_major as number | null) ?? 0;
    const isPrerelease = row.version_is_prerelease as boolean | null;
    const prerelease = (row.version_prerelease as string | null) ?? '';

    if (!bucketMap.has(version)) {
      bucketMap.set(version, { count: 0, projects: [] });
    }
    const bucket = bucketMap.get(version)!;
    bucket.count++;
    if (!bucket.projects.includes(project)) {
      bucket.projects.push(project);
    }

    if (major > maxMajor) maxMajor = major;

    // Flag as prerelease if version_is_prerelease or contains alpha/beta/rc
    if (
      isPrerelease === true ||
      /alpha|beta|rc/i.test(version) ||
      /alpha|beta|rc/i.test(prerelease)
    ) {
      if (!prereleaseProjects.includes(project)) {
        prereleaseProjects.push(project);
      }
    }
  }

  const distribution: VersionBucket[] = [...bucketMap.entries()].map(([version, d]) => ({
    version,
    count: d.count,
    projects: d.projects.sort(),
  }));

  // Lagging: more than 1 major behind the highest seen
  const lagging: string[] = [];
  for (const row of rows) {
    const major = (row.version_major as number | null) ?? 0;
    const project = row.project_id as string;
    if (maxMajor - major > 1 && !lagging.includes(project)) {
      lagging.push(project);
    }
  }

  return {
    distribution,
    lagging: lagging.sort(),
    prerelease: prereleaseProjects.sort(),
  };
}

// ─── Component / function delta ────────────────────────────────────────────────

/** Raw usage site row from a SQL query */
interface RawUsageRow {
  project_id: string;
  file_path: string;
  name: string;         // component_name or export_name
  kind: 'component' | 'function';
  line: number;
  // For components:
  props?: string | null; // JSON array of prop names, or null
  // For functions:
  args?: string | null;  // JSON array of ArgDetail, or null
}

/** Normalize file_path to be relative (strip any absolute prefix) */
function normalizeFilePath(filePath: string): string {
  // If it's already relative, return as-is
  // Strip anything before and including the first occurrence of 'src/'
  // or return the basename portion if it looks absolute
  if (filePath.startsWith('/')) {
    // Find the src/ marker or just drop leading slashes
    const srcIdx = filePath.indexOf('/src/');
    if (srcIdx !== -1) return filePath.slice(srcIdx + 1);
    // Otherwise keep everything after the first directory segment
    const parts = filePath.split('/');
    return parts.slice(1).join('/');
  }
  return filePath;
}

/**
 * Returns the component and function usage delta for the stable corpus.
 *
 * Queries both component_usages (JS/TS JSX) and function_usages (JS/TS + Python).
 * Identity key: (project_id, file_path, component_name|export_name).
 * Test/story files are excluded at the query level.
 */
export async function getComponentDeltas(
  pkg: string,
  stableCorpus: string[],
  scansA: ScanRef[],
  scansB: ScanRef[],
): Promise<{
  deltas: ComponentDelta[];
  unchanged: string[];
}> {
  if (stableCorpus.length === 0) {
    return { deltas: [], unchanged: [] };
  }

  const cu = requireParquet('component_usages');
  const cpu = requireParquet('component_prop_usages');
  const fu = requireParquet('function_usages');
  const fau = requireParquet('function_arg_usages');

  const stableSet = new Set(stableCorpus);
  const stableScansA = scansA.filter((s) => stableSet.has(s.project_id));
  const stableScansB = scansB.filter((s) => stableSet.has(s.project_id));

  const buildScanFilter = (scans: ScanRef[], alias: string): string => {
    if (scans.length === 0) return '1=0';
    return scans
      .map((s) => `(${alias}.project_id = '${sqlStr(s.project_id)}' AND ${alias}.scanned_at = '${sqlStr(s.scanned_at)}')`)
      .join(' OR ');
  };

  const filterA = buildScanFilter(stableScansA, 'cu');
  const filterB = buildScanFilter(stableScansB, 'cu');
  const filterFuA = buildScanFilter(stableScansA, 'fu');
  const filterFuB = buildScanFilter(stableScansB, 'fu');

  /** Query component usages for a period, joining props */
  const buildComponentQuery = (filter: string, fuFilter: string): string => {
    // Components (JS/TS JSX only)
    const compQuery = stableScansA.length > 0 || stableScansB.length > 0 ? `
      SELECT
        cu.project_id,
        cu.file_path,
        cu.component_name AS name,
        'component' AS kind,
        MIN(cu.line) AS line,
        list(DISTINCT cpu.prop_name) FILTER (WHERE cpu.prop_name IS NOT NULL) AS props,
        NULL::VARCHAR AS args
      FROM read_parquet('${sqlStr(cu)}') cu
      LEFT JOIN read_parquet('${sqlStr(cpu)}') cpu
        ON  cu.project_id   = cpu.project_id
        AND cu.scanned_at   = cpu.scanned_at
        AND cu.file_path    = cpu.file_path
        AND cu.component_name = cpu.component_name
      WHERE cu.package_name = '${sqlStr(pkg)}'
        AND (${filter})
        ${TEST_FILE_EXCLUSION.replace(/file_path/g, 'cu.file_path')}
      GROUP BY cu.project_id, cu.file_path, cu.component_name
    ` : `SELECT NULL::VARCHAR AS project_id, NULL::VARCHAR AS file_path, NULL::VARCHAR AS name, NULL::VARCHAR AS kind, NULL::INTEGER AS line, NULL::VARCHAR[] AS props, NULL::VARCHAR AS args WHERE 1=0`;

    // Functions (JS/TS and Python — both land in function_usages)
    const funcQuery = stableScansA.length > 0 || stableScansB.length > 0 ? `
      SELECT
        fu.project_id,
        fu.file_path,
        fu.export_name AS name,
        'function' AS kind,
        MIN(fu.line) AS line,
        NULL::VARCHAR[] AS props,
        to_json(
          list({
            index: fau.arg_index,
            type: fau.value_type,
            value: CASE WHEN fau.value_type = 'static' THEN fau.value ELSE NULL END
          }) FILTER (WHERE fau.arg_index IS NOT NULL)
        )::VARCHAR AS args
      FROM read_parquet('${sqlStr(fu)}') fu
      LEFT JOIN read_parquet('${sqlStr(fau)}') fau
        ON  fu.project_id  = fau.project_id
        AND fu.scanned_at  = fau.scanned_at
        AND fu.file_path   = fau.file_path
        AND fu.export_name = fau.export_name
        AND fu.line        = fau.line
      WHERE fu.package_name = '${sqlStr(pkg)}'
        AND (${fuFilter})
        ${TEST_FILE_EXCLUSION.replace(/file_path/g, 'fu.file_path')}
      GROUP BY fu.project_id, fu.file_path, fu.export_name
    ` : `SELECT NULL::VARCHAR AS project_id, NULL::VARCHAR AS file_path, NULL::VARCHAR AS name, NULL::VARCHAR AS kind, NULL::INTEGER AS line, NULL::VARCHAR[] AS props, NULL::VARCHAR AS args WHERE 1=0`;

    return `${compQuery} UNION ALL ${funcQuery}`;
  };

  // Build queries using the correct filters
  const compQueryA = buildComponentQuery(filterA, filterFuA);
  const compQueryB = buildComponentQuery(filterB, filterFuB);

  const [rowsA, rowsB] = await Promise.all([
    stableScansA.length > 0 ? queryParquet(compQueryA) : Promise.resolve([]),
    stableScansB.length > 0 ? queryParquet(compQueryB) : Promise.resolve([]),
  ]);

  // Build maps: "kind:name:project_id:file_path" → UsageSite
  type SiteKey = string;
  const buildSiteMap = (rows: Record<string, unknown>[]): Map<SiteKey, UsageSite & { kind: string; name: string }> => {
    const map = new Map<SiteKey, UsageSite & { kind: string; name: string }>();
    for (const row of rows) {
      if (!row.name || !row.project_id) continue;
      const project = row.project_id as string;
      const file = normalizeFilePath(row.file_path as string ?? '');
      const name = row.name as string;
      const kind = row.kind as string;
      const line = (row.line as number) ?? 0;
      const key: SiteKey = `${kind}:${name}:${project}:${file}`;

      // Parse props (array of prop name strings)
      let props: string[] | undefined;
      if (kind === 'component' && row.props !== null && row.props !== undefined) {
        if (Array.isArray(row.props)) {
          props = (row.props as string[]).filter(Boolean).sort();
        }
      }

      // Parse args (JSON string of ArgDetail[])
      let args: ArgDetail[] | undefined;
      if (kind === 'function' && row.args !== null && row.args !== undefined) {
        try {
          const parsed = JSON.parse(row.args as string) as Array<{
            index: number; type: string; value: string | null;
          }>;
          if (Array.isArray(parsed) && parsed.length > 0) {
            args = parsed.map((a) => {
              const detail: ArgDetail = { index: a.index, type: a.type };
              if (a.type === 'static' && a.value !== null && a.value !== undefined) {
                detail.value = a.value;
              }
              return detail;
            });
          }
        } catch {
          // ignore parse errors
        }
      }

      const site: UsageSite & { kind: string; name: string } = {
        project,
        file,
        line,
        kind,
        name,
      };
      if (props !== undefined) site.props = props;
      if (args !== undefined) site.args = args;

      map.set(key, site);
    }
    return map;
  };

  const mapA = buildSiteMap(rowsA);
  const mapB = buildSiteMap(rowsB);

  // Compute per-component/function delta
  const allNames = new Map<string, 'component' | 'function'>(); // "kind:name" → kind
  for (const [key, site] of mapA) {
    const kindName = `${site.kind}:${site.name}`;
    allNames.set(kindName, site.kind as 'component' | 'function');
  }
  for (const [key, site] of mapB) {
    const kindName = `${site.kind}:${site.name}`;
    allNames.set(kindName, site.kind as 'component' | 'function');
  }

  const deltas: ComponentDelta[] = [];
  const unchanged: string[] = [];

  for (const [kindName, kind] of allNames) {
    const [, name] = kindName.split(':', 2);
    // Collect all sites for this component across all stable projects
    const sitesA = [...mapA.entries()]
      .filter(([k]) => k.startsWith(kindName + ':'))
      .map(([, s]) => s);
    const sitesB = [...mapB.entries()]
      .filter(([k]) => k.startsWith(kindName + ':'))
      .map(([, s]) => s);

    const keysA = new Set(sitesA.map((s) => `${s.project}:${s.file}`));
    const keysB = new Set(sitesB.map((s) => `${s.project}:${s.file}`));

    const added = sitesB.filter((s) => !keysA.has(`${s.project}:${s.file}`));
    const removed = sitesA.filter((s) => !keysB.has(`${s.project}:${s.file}`));
    const stable = sitesA.filter((s) => keysB.has(`${s.project}:${s.file}`)).length;

    if (added.length === 0 && removed.length === 0) {
      unchanged.push(name);
    } else {
      // Strip internal kind/name fields from UsageSite
      const toUsageSite = (s: UsageSite & { kind: string; name: string }): UsageSite => {
        const site: UsageSite = { project: s.project, file: s.file, line: s.line };
        if (s.props !== undefined) site.props = s.props;
        if (s.args !== undefined) site.args = s.args;
        return site;
      };
      deltas.push({
        name,
        kind,
        added: added.map(toUsageSite),
        removed: removed.map(toUsageSite),
        stable,
      });
    }
  }

  return { deltas, unchanged: unchanged.sort() };
}

// ─── Coverage info ─────────────────────────────────────────────────────────────

/**
 * Returns coverage information: how many of the "ever-scanned" projects were
 * seen in the current period. Emits a warning if coverage < 80%.
 */
export async function getCoverageInfo(
  pkg: string,
  from: string,
  to: string,
): Promise<{
  projectsCovered: number;
  projectsExpected: number;
  gaps: string[];
  warning?: string;
}> {
  const dp = requireParquet('dependencies');

  // All projects ever scanned for this package
  const allProjects = await queryParquet(`
    SELECT DISTINCT project_id
    FROM read_parquet('${sqlStr(dp)}')
    WHERE package_name = '${sqlStr(pkg)}'
    ORDER BY project_id
  `);

  const expected = allProjects.map((r) => r.project_id as string);

  // Projects covered in the period
  const covered = await getLatestScanPerProject(pkg, from, to);
  const coveredSet = new Set(covered.map((s) => s.project_id));

  const gaps = expected.filter((p) => !coveredSet.has(p)).sort();

  const projectsCovered = coveredSet.size;
  const projectsExpected = expected.length;

  const result: {
    projectsCovered: number;
    projectsExpected: number;
    gaps: string[];
    warning?: string;
  } = { projectsCovered, projectsExpected, gaps };

  if (projectsExpected > 0 && projectsCovered / projectsExpected < 0.8) {
    const pct = Math.round((projectsCovered / projectsExpected) * 100);
    result.warning = `Only ${projectsCovered}/${projectsExpected} (${pct}%) of known projects were scanned in this period. Data may be incomplete.`;
  }

  return result;
}

// ─── Language detection ────────────────────────────────────────────────────────

/**
 * Determine the language mix for the stable corpus.
 * Projects with python_framework or python_package_manager are considered Python.
 */
async function detectLanguage(
  stableCorpus: string[],
  scansB: ScanRef[],
): Promise<'js' | 'python' | 'mixed'> {
  if (stableCorpus.length === 0) return 'js';

  const sp = requireParquet('project_snapshots');
  const stableSet = new Set(stableCorpus);
  const stableScansB = scansB.filter((s) => stableSet.has(s.project_id));

  if (stableScansB.length === 0) return 'js';

  const conditions = stableScansB
    .map((s) => `(project_id = '${sqlStr(s.project_id)}' AND scanned_at = '${sqlStr(s.scanned_at)}')`)
    .join(' OR ');

  const rows = await queryParquet(`
    SELECT
      project_id,
      python_framework,
      python_package_manager,
      framework,
      package_manager
    FROM read_parquet('${sqlStr(sp)}')
    WHERE (${conditions})
  `);

  let hasJs = false;
  let hasPython = false;

  for (const row of rows) {
    const isPython =
      row.python_framework !== null ||
      row.python_package_manager !== null;
    const isJs =
      row.framework !== null ||
      row.package_manager !== null ||
      (!isPython);

    if (isPython) hasPython = true;
    if (isJs && !isPython) hasJs = true;
    // A project that has both would be unusual but would count as both
    if (isPython && (row.framework !== null || row.package_manager !== null)) {
      hasJs = true;
    }
  }

  if (hasJs && hasPython) return 'mixed';
  if (hasPython) return 'python';
  return 'js';
}

// ─── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Main entry point: assembles a complete PackageHealthResult.
 *
 * @param pkg - The package name (e.g. "@acme/ui" or "django")
 * @param from - Start of the full period (ISO date or relative: "3m", "30d")
 * @param to   - End of the full period (ISO date or relative, default: today)
 */
export async function getPackageHealth(args: {
  package: string;
  from: string;
  to?: string;
}): Promise<PackageHealthResult> {
  const from = parsePeriod(args.from);
  const to = args.to ? parsePeriod(args.to) : new Date().toISOString().slice(0, 10);
  const mid = midpointDate(from, to);

  const periodA = { from, to: mid };
  const periodB = { from: mid, to };

  // 1. Get stable corpus
  const { stable: stableCorpus, added: addedProjects, removed: removedProjects } =
    await getStableCorpus(args.package, periodA, periodB);

  // 2. Get latest scans for each period (needed for all subsequent queries)
  const [scansA, scansB] = await Promise.all([
    getLatestScanPerProject(args.package, periodA.from, periodA.to),
    getLatestScanPerProject(args.package, periodB.from, periodB.to),
  ]);

  // Fail fast if the package has no data at all
  if (scansA.length === 0 && scansB.length === 0) {
    throw new Error(`No scan data found for package "${args.package}" in the specified period.`);
  }

  // 3. Run all queries in parallel
  const [adoption, versions, deltas, coverage, language] = await Promise.all([
    getAdoptionDelta(args.package, stableCorpus, scansA, scansB),
    getVersionDistribution(args.package, scansB),
    getComponentDeltas(args.package, stableCorpus, scansA, scansB),
    getCoverageInfo(args.package, from, to),
    detectLanguage(stableCorpus, scansB),
  ]);

  // 4. Compute componentChanges summary
  const componentsWithAdditions = deltas.deltas.filter(
    (d) => d.kind === 'component' && d.added.length > 0,
  ).length;
  const componentsWithRemovals = deltas.deltas.filter(
    (d) => d.kind === 'component' && d.removed.length > 0,
  ).length;
  const functionsWithAdditions = deltas.deltas.filter(
    (d) => d.kind === 'function' && d.added.length > 0,
  ).length;
  const functionsWithRemovals = deltas.deltas.filter(
    (d) => d.kind === 'function' && d.removed.length > 0,
  ).length;
  const totalAddedSites = deltas.deltas.reduce((n, d) => n + d.added.length, 0);
  const totalRemovedSites = deltas.deltas.reduce((n, d) => n + d.removed.length, 0);

  return {
    package: args.package,
    language,
    generatedAt: new Date().toISOString(),
    period: { from, to },
    corpus: {
      stable: stableCorpus.length,
      addedProjects,
      removedProjects,
    },
    adoption: {
      start: adoption.start,
      end: adoption.end,
      delta: adoption.end - adoption.start,
      newAdopters: adoption.newAdopters,
      churned: adoption.churned,
    },
    versions: {
      distribution: versions.distribution,
      lagging: versions.lagging,
      prerelease: versions.prerelease,
    },
    componentChanges: {
      summary: {
        componentsWithAdditions,
        componentsWithRemovals,
        functionsWithAdditions,
        functionsWithRemovals,
        totalAddedSites,
        totalRemovedSites,
      },
      deltas: deltas.deltas,
      unchanged: deltas.unchanged,
    },
    coverage,
  };
}
