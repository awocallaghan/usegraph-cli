/**
 * Observable Framework data loader: overview.json.js
 *
 * Queries ~/.usegraph/built/*.parquet via the shared queryParquet helper
 * (which handles DuckDB connection management and BigInt sanitization) and
 * writes a JSON summary to stdout.
 *
 * USEGRAPH_HOME env var is forwarded by `usegraph dashboard`.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Import the compiled shared helper from the CLI's dist/ directory.
// Resolving via import.meta.url keeps this correct regardless of cwd.
// Path: src/dashboard/pages/data/ → (4 levels up) → dist/parquet-query.js
const __dirname = dirname(fileURLToPath(import.meta.url));
const { queryParquet, getBuiltDir } = await import(
  join(__dirname, '../../../../dist/parquet-query.js')
);

const builtDir = getBuiltDir();
const snapshotFile = join(builtDir, 'project_snapshots.parquet');

if (!existsSync(snapshotFile)) {
  process.stderr.write(
    `usegraph: No Parquet data found at ${builtDir}\nRun \`usegraph build\` first.\n`,
  );
  process.exit(1);
}

/** Return a read_parquet(...) expression for a file in builtDir. */
function p(filename) {
  return `read_parquet('${join(builtDir, filename).replace(/'/g, "''")}')`;
}

// Core queries — project_snapshots.parquet is guaranteed to exist at this point.
// Check schema first for backward compat with Parquet files built before code_at was added.
const snapshotSchema = await queryParquet(
  `DESCRIBE SELECT * FROM ${p('project_snapshots.parquet')}`,
);
const snapshotHasCodeAt = snapshotSchema.some(c => c.column_name === 'code_at');
const codeAtExpr = snapshotHasCodeAt ? 'code_at' : 'NULL::VARCHAR AS code_at';

const hasPythonCols = snapshotSchema.some(c => c.column_name === 'python_framework');
const pyFramework = hasPythonCols ? 'python_framework' : 'NULL::VARCHAR AS python_framework';
const pyPkgMgr    = hasPythonCols ? 'python_package_manager' : 'NULL::VARCHAR AS python_package_manager';

const snap = p('project_snapshots.parquet');

const [projects, frameworkCounts, buildToolCounts, pmCounts, languageCounts] = await Promise.all([
  queryParquet(
    `SELECT project_id, scanned_at, ${codeAtExpr},
       CASE
         WHEN (python_package_manager IS NOT NULL OR python_framework IS NOT NULL)
              AND (framework IS NOT NULL OR package_manager IS NOT NULL) THEN 'both'
         WHEN python_package_manager IS NOT NULL OR python_framework IS NOT NULL THEN 'python'
         ELSE 'javascript'
       END AS language,
       COALESCE(framework::VARCHAR, python_framework::VARCHAR)             AS framework,
       build_tool,
       COALESCE(package_manager::VARCHAR, python_package_manager::VARCHAR) AS package_manager
     FROM (SELECT *, ${pyFramework}, ${pyPkgMgr} FROM ${snap}) _s
     WHERE is_latest = true
     ORDER BY scanned_at DESC`,
  ),
  queryParquet(
    `SELECT name, COUNT(*) AS count FROM (
       SELECT framework::VARCHAR AS name FROM ${snap} WHERE is_latest = true AND framework IS NOT NULL
       ${hasPythonCols ? `UNION ALL SELECT python_framework::VARCHAR AS name FROM ${snap} WHERE is_latest = true AND python_framework IS NOT NULL` : ''}
     ) _f GROUP BY name ORDER BY count DESC`,
  ),
  queryParquet(
    `SELECT build_tool AS name, COUNT(*) AS count
     FROM ${snap}
     WHERE is_latest = true AND build_tool IS NOT NULL
     GROUP BY build_tool ORDER BY count DESC`,
  ),
  queryParquet(
    `SELECT name, COUNT(*) AS count FROM (
       SELECT package_manager::VARCHAR AS name FROM ${snap} WHERE is_latest = true AND package_manager IS NOT NULL
       ${hasPythonCols ? `UNION ALL SELECT python_package_manager::VARCHAR AS name FROM ${snap} WHERE is_latest = true AND python_package_manager IS NOT NULL` : ''}
     ) _pm GROUP BY name ORDER BY count DESC`,
  ),
  queryParquet(
    `SELECT
       CASE
         WHEN (python_package_manager IS NOT NULL OR python_framework IS NOT NULL)
              AND (framework IS NOT NULL OR package_manager IS NOT NULL) THEN 'both'
         WHEN python_package_manager IS NOT NULL OR python_framework IS NOT NULL THEN 'python'
         ELSE 'javascript'
       END AS language,
       COUNT(*) AS count
     FROM (SELECT *, ${pyFramework}, ${pyPkgMgr} FROM ${snap}) _s
     WHERE is_latest = true
     GROUP BY language ORDER BY count DESC`,
  ),
]);

// Optional tables — may be absent when there was no matching data at build time.
let totalComponentUsages = 0;
let totalFunctionUsages = 0;

if (existsSync(join(builtDir, 'component_usages.parquet'))) {
  const rows = await queryParquet(
    `SELECT COUNT(*)::INTEGER AS n FROM ${p('component_usages.parquet')} WHERE is_latest = true`,
  );
  totalComponentUsages = rows[0]?.n ?? 0;
}

if (existsSync(join(builtDir, 'function_usages.parquet'))) {
  const rows = await queryParquet(
    `SELECT COUNT(*)::INTEGER AS n FROM ${p('function_usages.parquet')} WHERE is_latest = true`,
  );
  totalFunctionUsages = rows[0]?.n ?? 0;
}

process.stdout.write(
  JSON.stringify({
    projects,
    totalComponentUsages,
    totalFunctionUsages,
    frameworkCounts,
    buildToolCounts,
    packageManagerCounts: pmCounts,
    languageCounts,
  }),
);
