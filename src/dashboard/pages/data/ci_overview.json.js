/**
 * Observable Framework data loader: ci_overview.json.js
 *
 * Produces a JSON summary of CI template usage across the fleet:
 *   - total usage count
 *   - distinct project count
 *   - per-provider breakdown
 *   - top 20 templates by adoption
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
const ciFile = join(builtDir, 'ci_template_usages.parquet');

if (!existsSync(ciFile)) {
  // No CI data yet — return empty summary so pages still render
  process.stdout.write(
    JSON.stringify({
      totalUsages: 0,
      projectCount: 0,
      providerCounts: [],
      topTemplates: [],
    }),
  );
  process.exit(0);
}

function p(filename) {
  return `read_parquet('${join(builtDir, filename).replace(/'/g, "''")}')`;
}

const [totals, providerCounts, topTemplates] = await Promise.all([
  queryParquet(
    `SELECT
       COUNT(*)::INTEGER                    AS total_usages,
       COUNT(DISTINCT project_id)::INTEGER  AS project_count
     FROM ${p('ci_template_usages.parquet')}
     WHERE is_latest = true`,
  ),
  queryParquet(
    `SELECT
       provider                             AS name,
       COUNT(*)::INTEGER                    AS count
     FROM ${p('ci_template_usages.parquet')}
     WHERE is_latest = true
     GROUP BY provider
     ORDER BY count DESC`,
  ),
  queryParquet(
    `SELECT
       source,
       provider,
       template_type,
       COUNT(DISTINCT project_id)::INTEGER  AS project_count
     FROM ${p('ci_template_usages.parquet')}
     WHERE is_latest = true
     GROUP BY source, provider, template_type
     ORDER BY project_count DESC
     LIMIT 20`,
  ),
]);

process.stdout.write(
  JSON.stringify({
    totalUsages: totals[0]?.total_usages ?? 0,
    projectCount: totals[0]?.project_count ?? 0,
    providerCounts,
    topTemplates,
  }),
);
