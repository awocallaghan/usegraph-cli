/**
 * Observable Framework data loader: overview.json.js
 *
 * Runs as a Node.js child process on demand. Queries Parquet tables produced
 * by `usegraph build` via DuckDB and writes JSON to stdout.
 *
 * USEGRAPH_HOME env var is set by `usegraph dashboard` to point at ~/.usegraph.
 */
import duckdb from 'duckdb';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const usegraphHome = process.env.USEGRAPH_HOME ?? join(homedir(), '.usegraph');
const builtDir = join(usegraphHome, 'built');
const snapshotFile = join(builtDir, 'project_snapshots.parquet');

if (!existsSync(snapshotFile)) {
  process.stderr.write(
    `usegraph: No Parquet data found at ${builtDir}\nRun \`usegraph build\` first.\n`,
  );
  process.exit(1);
}

// Open an in-memory DuckDB instance
const db = await new Promise((resolve, reject) => {
  const inst = new duckdb.Database(':memory:', (err) => {
    if (err) reject(err);
    else resolve(inst);
  });
});

const conn = db.connect();

/** Run a SQL query and return all rows. */
function query(sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => {
      if (err) reject(new Error(err.message ?? String(err)));
      else resolve(result ?? []);
    });
  });
}

/** Return a read_parquet(...) expression for a file in builtDir. */
function p(filename) {
  // Escape single quotes in the path (unusual but safe)
  const safePath = join(builtDir, filename).replace(/'/g, "''");
  return `read_parquet('${safePath}')`;
}

// Always-present queries
const [projects, frameworkCounts, buildToolCounts, pmCounts] = await Promise.all([
  query(
    `SELECT project_id, scanned_at, framework, build_tool, package_manager
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true
     ORDER BY scanned_at DESC`,
  ),
  query(
    `SELECT framework AS name, COUNT(*) AS count
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true AND framework IS NOT NULL
     GROUP BY framework ORDER BY count DESC`,
  ),
  query(
    `SELECT build_tool AS name, COUNT(*) AS count
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true AND build_tool IS NOT NULL
     GROUP BY build_tool ORDER BY count DESC`,
  ),
  query(
    `SELECT package_manager AS name, COUNT(*) AS count
     FROM ${p('project_snapshots.parquet')}
     WHERE is_latest = true AND package_manager IS NOT NULL
     GROUP BY package_manager ORDER BY count DESC`,
  ),
]);

// Optional tables (may be absent if there was no data at build time)
let totalComponentUsages = 0;
let totalFunctionUsages = 0;

if (existsSync(join(builtDir, 'component_usages.parquet'))) {
  const rows = await query(
    `SELECT COUNT(*)::INTEGER AS n FROM ${p('component_usages.parquet')} WHERE is_latest = true`,
  );
  totalComponentUsages = rows[0]?.n ?? 0;
}

if (existsSync(join(builtDir, 'function_usages.parquet'))) {
  const rows = await query(
    `SELECT COUNT(*)::INTEGER AS n FROM ${p('function_usages.parquet')} WHERE is_latest = true`,
  );
  totalFunctionUsages = rows[0]?.n ?? 0;
}

conn.close();
await new Promise((resolve) => db.close(() => resolve()));

const output = {
  projects,
  totalComponentUsages,
  totalFunctionUsages,
  frameworkCounts,
  buildToolCounts,
  packageManagerCounts: pmCounts,
};

process.stdout.write(JSON.stringify(output));
