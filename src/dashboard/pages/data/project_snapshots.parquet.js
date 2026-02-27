/**
 * Observable Framework data loader: project_snapshots.parquet.js
 *
 * Proxies ~/.usegraph/built/project_snapshots.parquet to the browser as a
 * binary file attachment so the Project Detail page can load it into DuckDB WASM.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { getBuiltDir } = await import(join(__dirname, '../../../../dist/parquet-query.js'));

const file = join(getBuiltDir(), 'project_snapshots.parquet');

if (!existsSync(file)) {
  process.stderr.write(
    `usegraph: No Parquet data found: ${file}\nRun \`usegraph build\` first.\n`,
  );
  process.exit(1);
}

process.stdout.write(readFileSync(file));
