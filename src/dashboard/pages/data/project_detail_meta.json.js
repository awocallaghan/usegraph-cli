/**
 * Observable Framework data loader: project_detail_meta.json.js
 *
 * Returns the list of all known project IDs for the project selector dropdown
 * on the Project Detail page. Intentionally lightweight — no large row sets.
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

function p(filename) {
  return `read_parquet('${join(builtDir, filename).replace(/'/g, "''")}')`;
}

const rows = await queryParquet(
  `SELECT DISTINCT project_id FROM ${p('project_snapshots.parquet')} ORDER BY project_id`,
);

process.stdout.write(JSON.stringify({ projectIds: rows.map(r => r.project_id) }));
