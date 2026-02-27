/**
 * Observable Framework data loader: component_prop_usages.parquet.js
 *
 * Proxies ~/.usegraph/built/component_prop_usages.parquet to the browser.
 * If the file doesn't exist, outputs a valid empty parquet with the correct
 * schema so DuckDBClient.of() always succeeds on the Component Explorer page.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import duckdb from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { getBuiltDir } = await import(join(__dirname, '../../../../dist/parquet-query.js'));

const srcFile = join(getBuiltDir(), 'component_prop_usages.parquet');

if (existsSync(srcFile)) {
  process.stdout.write(readFileSync(srcFile));
} else {
  const tmpFile = join(tmpdir(), `usegraph_empty_cpu_${Date.now()}.parquet`);
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
           NULL::VARCHAR    AS package_version_resolved,
           NULL::INTEGER    AS package_version_major,
           NULL::INTEGER    AS package_version_minor,
           NULL::VARCHAR    AS component_name,
           NULL::VARCHAR    AS file_path,
           NULL::INTEGER    AS line,
           NULL::VARCHAR    AS prop_name,
           NULL::VARCHAR    AS value_type,
           NULL::VARCHAR    AS value,
           NULL::VARCHAR    AS source_snippet
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
