/**
 * Observable Framework data loader: ci_template_usages.parquet.js
 *
 * Proxies ~/.usegraph/built/ci_template_usages.parquet to the browser.
 * If the file doesn't exist, outputs a valid empty parquet with the correct
 * schema so DuckDBClient.of() always succeeds on dashboard pages.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import duckdb from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { getBuiltDir } = await import(join(__dirname, '../../../../dist/parquet-query.js'));

const srcFile = join(getBuiltDir(), 'ci_template_usages.parquet');

if (existsSync(srcFile)) {
  process.stdout.write(readFileSync(srcFile));
} else {
  const tmpFile = join(tmpdir(), `usegraph_empty_citu_${Date.now()}.parquet`);
  const db = await new Promise((res, rej) => {
    const inst = new duckdb.Database(':memory:', e => (e ? rej(e) : res(inst)));
  });
  const conn = db.connect();
  await new Promise((res, rej) =>
    conn.run(
      `COPY (
         SELECT
           NULL::VARCHAR  AS project_id,
           NULL::VARCHAR  AS scanned_at,
           NULL::VARCHAR  AS code_at,
           NULL::BOOLEAN  AS is_latest,
           NULL::VARCHAR  AS provider,
           NULL::VARCHAR  AS template_type,
           NULL::VARCHAR  AS source,
           NULL::VARCHAR  AS version,
           NULL::VARCHAR  AS file_path,
           NULL::INTEGER  AS line
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
