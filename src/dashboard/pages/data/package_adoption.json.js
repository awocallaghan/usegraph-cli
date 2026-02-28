/**
 * Observable Framework data loader: package_adoption.json.js
 *
 * Queries component_usages and function_usages Parquet files via the shared
 * queryParquet helper and writes a JSON summary to stdout for the Package
 * Adoption dashboard page.
 *
 * USEGRAPH_HOME env var is forwarded by `usegraph dashboard`.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

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

const cuFile = join(builtDir, 'component_usages.parquet');
const fuFile = join(builtDir, 'function_usages.parquet');

const hasCu = existsSync(cuFile);
const hasFu = existsSync(fuFile);

if (!hasCu && !hasFu) {
  process.stderr.write(
    `usegraph: No component_usages or function_usages Parquet data found at ${builtDir}\n` +
    `Run \`usegraph scan\` with target packages configured, then \`usegraph build\`.\n`,
  );
}

// All projects (latest snapshot)
const allProjects = await queryParquet(
  `SELECT DISTINCT project_id FROM ${p('project_snapshots.parquet')} WHERE is_latest = true ORDER BY project_id`,
);

// Current-state usage rows (is_latest = true)
const allComponentUsages = hasCu
  ? await queryParquet(
      `SELECT project_id, package_name,
              package_version_resolved, package_version_major, package_version_minor,
              component_name
       FROM ${p('component_usages.parquet')}
       WHERE is_latest = true
       ORDER BY package_name, project_id, component_name`,
    )
  : [];

const allFunctionUsages = hasFu
  ? await queryParquet(
      `SELECT project_id, package_name,
              package_version_resolved, package_version_major, package_version_minor,
              export_name
       FROM ${p('function_usages.parquet')}
       WHERE is_latest = true
       ORDER BY package_name, project_id, export_name`,
    )
  : [];

// Historical usage counts per (package_name, project_id, effective_date) for trend chart.
// Uses ALL scans (not filtered by is_latest).
// COALESCE(code_at, scanned_at): for --history scans every commit shares the same scanned_at
// (the wall-clock time the command ran) but has a distinct code_at (the commit timestamp).
// For regular scans code_at may be NULL, so we fall back to scanned_at.
const historicalUsages = await (async () => {
  const parts = [];
  if (hasCu) {
    parts.push(
      `SELECT package_name, project_id, COALESCE(code_at, scanned_at) AS scanned_at,
              COUNT(*)::INTEGER AS component_count, 0::INTEGER AS function_count
       FROM ${p('component_usages.parquet')}
       GROUP BY package_name, project_id, COALESCE(code_at, scanned_at)`,
    );
  }
  if (hasFu) {
    parts.push(
      `SELECT package_name, project_id, COALESCE(code_at, scanned_at) AS scanned_at,
              0::INTEGER AS component_count, COUNT(*)::INTEGER AS function_count
       FROM ${p('function_usages.parquet')}
       GROUP BY package_name, project_id, COALESCE(code_at, scanned_at)`,
    );
  }
  if (parts.length === 0) return [];

  const combined =
    parts.length === 1
      ? parts[0]
      : `SELECT package_name, project_id, scanned_at,
                SUM(component_count)::INTEGER AS component_count,
                SUM(function_count)::INTEGER  AS function_count
         FROM (${parts.join(' UNION ALL ')}) t
         GROUP BY package_name, project_id, scanned_at`;

  return queryParquet(`${combined} ORDER BY package_name, scanned_at, project_id`);
})();

process.stdout.write(
  JSON.stringify({ allProjects, allComponentUsages, allFunctionUsages, historicalUsages }),
);
