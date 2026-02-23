/**
 * Shared DuckDB/Parquet query helpers used by `usegraph mcp` and `usegraph view`.
 */
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Root of the global store.
 * Override with the `USEGRAPH_HOME` environment variable (useful for testing).
 */
export const STORE_ROOT = process.env.USEGRAPH_HOME ?? join(homedir(), '.usegraph');
export const BUILT_DIR = join(STORE_ROOT, 'built');

export const PARQUET = {
  project_snapshots: join(BUILT_DIR, 'project_snapshots.parquet'),
  dependencies: join(BUILT_DIR, 'dependencies.parquet'),
  component_usages: join(BUILT_DIR, 'component_usages.parquet'),
  component_prop_usages: join(BUILT_DIR, 'component_prop_usages.parquet'),
  function_usages: join(BUILT_DIR, 'function_usages.parquet'),
  function_arg_usages: join(BUILT_DIR, 'function_arg_usages.parquet'),
} as const;

/** Tooling categories that may appear as a SQL column name */
export const TOOLING_CATEGORY_ALLOWLIST = new Set([
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Escape a string value for embedding inside a SQL string literal. */
export function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}

/** Check if a Parquet file exists, throw a clear error if not. */
export function requireParquet(name: keyof typeof PARQUET): string {
  const path = PARQUET[name];
  if (!existsSync(path)) {
    throw new Error(
      `Parquet file not found: ${path}\n  Run \`usegraph build\` first.`,
    );
  }
  return path;
}

/** Recursively convert BigInt values to Number so rows are JSON-serializable. */
function sanitizeBigInt(val: unknown): unknown {
  if (typeof val === 'bigint') return Number(val);
  if (Array.isArray(val)) return val.map(sanitizeBigInt);
  if (val !== null && typeof val === 'object')
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, sanitizeBigInt(v)]),
    );
  return val;
}

/** Open an in-memory DuckDB and run a query against the Parquet files. */
export async function queryParquet(sql: string): Promise<Record<string, unknown>[]> {
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
        else resolve((result ?? []).map((r) => sanitizeBigInt(r) as Record<string, unknown>));
      });
    });
    return rows;
  } finally {
    conn.close();
    await new Promise<void>((res) => db.close(() => res()));
  }
}
