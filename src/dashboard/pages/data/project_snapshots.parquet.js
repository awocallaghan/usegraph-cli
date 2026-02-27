/**
 * Observable Framework data loader: project_snapshots.parquet.js
 *
 * Proxies ~/.usegraph/built/project_snapshots.parquet to the browser as a
 * binary file attachment so the Project Detail page can load it into DuckDB WASM.
 *
 * Migration: if the Parquet was built before `code_at` was added, this loader
 * adds the column (as NULL::VARCHAR) on the fly so browser-side queries don't fail.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import duckdb from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { getBuiltDir } = await import(join(__dirname, '../../../../dist/parquet-query.js'));

const file = join(getBuiltDir(), 'project_snapshots.parquet');

if (!existsSync(file)) {
  process.stderr.write(
    `usegraph: No Parquet data found: ${file}\nRun \`usegraph build\` first.\n`,
  );
  process.exit(1);
}

// Open an in-memory DuckDB to inspect the schema and optionally migrate.
const db = await new Promise((res, rej) => {
  const d = new duckdb.Database(':memory:', e => e ? rej(e) : res(d));
});
const conn = db.connect();
const runAll = (sql) => new Promise((res, rej) => conn.all(sql, (e, rows) => e ? rej(e) : res(rows)));
const runVoid = (sql) => new Promise((res, rej) => conn.run(sql, e => e ? rej(e) : res()));

const safeFile = file.replace(/'/g, "''");
const schema = await runAll(`DESCRIBE SELECT * FROM read_parquet('${safeFile}')`);
const hasCodeAt = schema.some(c => c.column_name === 'code_at');

let output;
if (hasCodeAt) {
  output = readFileSync(file);
} else {
  // Old Parquet file (pre code_at): add the column as NULL so browser queries work
  const tmp = join(tmpdir(), `usegraph-migrate-snapshots-${Date.now()}.parquet`);
  const safeTmp = tmp.replace(/'/g, "''");
  await runVoid(
    `COPY (SELECT *, NULL::VARCHAR AS code_at FROM read_parquet('${safeFile}'))` +
    ` TO '${safeTmp}' (FORMAT PARQUET)`,
  );
  output = readFileSync(tmp);
  try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
}

conn.close();
await new Promise(res => db.close(() => res()));

process.stdout.write(output);

