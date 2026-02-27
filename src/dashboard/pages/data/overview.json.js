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
const [projects, frameworkCounts, buildToolCounts, pmCounts] = await Promise.all([
  queryParquet(
    `SELECT project_id, scanned_at, code_at, framework, build_tool, package_manager
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true
     ORDER BY scanned_at DESC`,
  ),
  queryParquet(
    `SELECT framework AS name, COUNT(*) AS count
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true AND framework IS NOT NULL
     GROUP BY framework ORDER BY count DESC`,
  ),
  queryParquet(
    `SELECT build_tool AS name, COUNT(*) AS count
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true AND build_tool IS NOT NULL
     GROUP BY build_tool ORDER BY count DESC`,
  ),
  queryParquet(
    `SELECT package_manager AS name, COUNT(*) AS count
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true AND package_manager IS NOT NULL
     GROUP BY package_manager ORDER BY count DESC`,
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
  }),
);
