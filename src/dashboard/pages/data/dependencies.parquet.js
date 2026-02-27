/**
 * Observable Framework data loader: dependencies.parquet.js
 *
 * Proxies ~/.usegraph/built/dependencies.parquet to the browser.
 * If the file doesn't exist, outputs a valid empty parquet with the correct
 * schema so DuckDBClient.of() always succeeds on the Project Detail page.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import duckdb from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { getBuiltDir } = await import(join(__dirname, '../../../../dist/parquet-query.js'));

const srcFile = join(getBuiltDir(), 'dependencies.parquet');

if (existsSync(srcFile)) {
  process.stdout.write(readFileSync(srcFile));
} else {
  // Generate an empty parquet with the correct schema so DuckDB WASM can still load it.
  const tmpFile = join(tmpdir(), `usegraph_empty_deps_${Date.now()}.parquet`);
  const db = await new Promise((res, rej) => {
    const inst = new duckdb.Database(':memory:', e => (e ? rej(e) : res(inst)));
  });
  const conn = db.connect();
  await new Promise((res, rej) =>
    conn.run(
      `COPY (
         SELECT
           NULL::VARCHAR    AS project_id,
           NULL::VARCHAR    AS scanned_at,
           NULL::BOOLEAN    AS is_latest,
           NULL::VARCHAR    AS package_name,
           NULL::VARCHAR    AS version_range,
           NULL::VARCHAR    AS version_resolved,
           NULL::INTEGER    AS version_major,
           NULL::INTEGER    AS version_minor,
           NULL::INTEGER    AS version_patch,
           NULL::VARCHAR    AS version_prerelease,
           NULL::BOOLEAN    AS version_is_prerelease,
           NULL::VARCHAR    AS dep_type,
           NULL::BOOLEAN    AS is_internal
         WHERE false
       ) TO '${tmpFile}' (FORMAT PARQUET)`,
      e => (e ? rej(e) : res()),
    ),
  );
  conn.close();
  await new Promise(res => db.close(res));
  process.stdout.write(readFileSync(tmpFile));
  unlinkSync(tmpFile);
}
