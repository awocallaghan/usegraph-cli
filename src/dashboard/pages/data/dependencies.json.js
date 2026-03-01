/**
 * Observable Framework data loader: dependencies.json.js
 *
 * Queries ~/.usegraph/built/dependencies.parquet via the shared queryParquet
 * helper and writes a JSON summary to stdout.
 *
 * USEGRAPH_HOME env var is forwarded by `usegraph dashboard`.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Import the compiled shared helper from the CLI's dist/ directory.
// Path: src/dashboard/pages/data/ → (4 levels up) → dist/parquet-query.js
const __dirname = dirname(fileURLToPath(import.meta.url));
const { queryParquet, getBuiltDir } = await import(
  join(__dirname, '../../../../dist/parquet-query.js')
);

const builtDir = getBuiltDir();
const depsFile = join(builtDir, 'dependencies.parquet');

if (!existsSync(depsFile)) {
  process.stderr.write(
    `usegraph: No dependencies Parquet data found at ${builtDir}\nRun \`usegraph build\` first.\n`,
  );
  process.exit(1);
}

/** Return a read_parquet(...) expression for a file in builtDir. */
function p(filename) {
  return `read_parquet('${join(builtDir, filename).replace(/'/g, "''")}')`;
}

const deps = p('dependencies.parquet');

const [topPackagesRaw, allDeps, prereleaseExposure] = await Promise.all([
  // Top 50 packages by project count
  queryParquet(
    `SELECT
       package_name,
       COUNT(DISTINCT project_id)::INTEGER AS project_count,
       COUNT(DISTINCT CASE WHEN dep_type = 'dependencies'         THEN project_id END)::INTEGER AS prod_count,
       COUNT(DISTINCT CASE WHEN dep_type = 'devDependencies'      THEN project_id END)::INTEGER AS dev_count,
       COUNT(DISTINCT CASE WHEN dep_type = 'peerDependencies'     THEN project_id END)::INTEGER AS peer_count,
       COUNT(DISTINCT CASE WHEN dep_type = 'optionalDependencies' THEN project_id END)::INTEGER AS optional_count,
       bool_or(version_is_prerelease) AS any_prerelease,
       bool_or(is_internal) AS any_internal
     FROM ${deps}
     WHERE is_latest = true
     GROUP BY package_name
     ORDER BY project_count DESC
     LIMIT 50`,
  ),
  // All latest dependency rows for client-side filtering
  queryParquet(
    `SELECT project_id, package_name, version_range, version_resolved,
            version_major, version_minor, version_patch,
            version_prerelease, version_is_prerelease, dep_type, is_internal
     FROM ${deps}
     WHERE is_latest = true
     ORDER BY package_name, project_id`,
  ),
  // Prerelease exposure
  queryParquet(
    `SELECT project_id, package_name, version_resolved, version_prerelease, dep_type, version_range
     FROM ${deps}
     WHERE is_latest = true AND version_is_prerelease = true
     ORDER BY package_name, project_id`,
  ),
]);

// Nest the 4 dep_type count columns into a dep_type_breakdown object
const topPackages = topPackagesRaw.map(({ prod_count, dev_count, peer_count, optional_count, ...rest }) => ({
  ...rest,
  dep_type_breakdown: { prod_count, dev_count, peer_count, optional_count },
}));

process.stdout.write(
  JSON.stringify({ topPackages, allDeps, prereleaseExposure }),
);
