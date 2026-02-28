# usegraph-cli Data Architecture Spec

Reference for implementing agents. Read the relevant section for your current task.

---

## §Schema: Top-level fields (Phase 1.1–1.2)

Add these fields to `ScanResult` in `src/types.ts`:

```typescript
schemaVersion: number;        // Always 1 for new scans
repoUrl: string | null;       // e.g. "https://github.com/org/repo"
branch: string | null;        // e.g. "main"
commitSha: string | null;     // Full SHA
packageJson: Record<string, unknown> | null;  // Verbatim parsed package.json
```

**How to populate in `scanner.ts`:**
- `schemaVersion`: hardcode `1`
- `repoUrl`: `spawnSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'])` —
  use the raw URL (not the parsed slug). Return `null` on error.
- `branch`: `spawnSync('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'])`
- `commitSha`: `spawnSync('git', ['-C', projectPath, 'rev-parse', 'HEAD'])`
- `packageJson`: read + JSON.parse `<projectPath>/package.json`; `null` if absent/invalid

---

## §Schema: tooling block (Phase 1.3)

Replace `ProjectMeta.tooling: ToolingInfo[]` with a flat struct.

**New `ToolingMeta` interface (add to `src/types.ts`):**
```typescript
export interface ToolingMeta {
  packageManager: string | null;         // "npm" | "yarn" | "pnpm" | "bun"
  packageManagerVersion: string | null;  // resolved from lockfile presence
  buildTool: string | null;              // "vite" | "webpack" | "esbuild" | "rollup"
  testFramework: string | null;          // "jest" | "vitest" | "mocha" | "jasmine"
  bundler: string | null;                // if distinct from buildTool
  linter: string | null;                 // "eslint" | "biome" | "oxlint"
  formatter: string | null;             // "prettier" | "biome"
  cssApproach: string | null;            // "tailwind" | "css-modules" | "styled-components"
  typescript: boolean | null;
  typescriptVersion: string | null;
  nodeVersion: string | null;            // from .nvmrc / .node-version / engines
  framework: string | null;             // "react" | "vue" | "angular" | "svelte" | "next"
  frameworkVersion: string | null;
}
```

**Update `ProjectMeta` (replace `tooling: ToolingInfo[]` with):**
```typescript
tooling: ToolingMeta;
```

**Detection heuristics for `meta-analyzer.ts`:**
- `packageManager`: detect by lockfile presence: `pnpm-lock.yaml` → pnpm,
  `yarn.lock` → yarn, `bun.lockb` → bun, `package-lock.json` → npm
- `buildTool`: devDep or config file: vite.config.* → vite, webpack.config.* → webpack,
  build.config.* or `esbuild` devDep → esbuild
- `testFramework`: devDep: vitest → vitest, jest → jest, mocha → mocha
- `linter`: eslint.config.* or .eslintrc* → eslint, biome.json → biome
- `formatter`: .prettierrc* or prettier devDep → prettier; biome → biome
- `cssApproach`: tailwind.config.* → tailwind; styled-components devDep → styled-components
- `typescript`: tsconfig.json presence or typescript devDep
- `typescriptVersion`: from devDep resolved version (Phase 2 lockfile data)
- `framework`: next.config.* → next; nuxt.config.* → nuxt; else check deps for
  react/vue/angular/svelte

---

## §Schema: sourceSnippet (Phase 1.4)

Add `sourceSnippet: string | null` to both `PropInfo` and `ArgInfo`.

- For **static** values (literal strings/numbers/booleans): `sourceSnippet = null`
- For **dynamic** values (`isDynamic = true` / `type = 'identifier' | 'expression' | ...`):
  capture ~5 lines of surrounding source from the original file using the `line` number.

**Implementation in `extractor.ts`:**
- The file source text is passed through as context (or read from disk)
- For dynamic props/args, extract lines `[line-2 .. line+2]` from the source string
- Store as `sourceSnippet: lines.join('\n')`

**Note:** The file source is available in `file-analyzer.ts` after SWC parses it.
Pass it through to the extractor so it can capture snippets without re-reading.

---

## §Lockfile Parsing (Phase 2)

Create `src/analyzer/lockfile.ts`.

**Interface:**
```typescript
export interface ResolvedDependency {
  name: string;
  versionResolved: string;   // e.g. "18.2.0"
  versionMajor: number;
  versionMinor: number;
  versionPatch: number;
  versionPrerelease: string | null;  // e.g. "acme-fork.3" or null
  versionIsPrerelease: boolean;
}

export interface LockfileParser {
  parse(lockfileContent: string): Map<string, ResolvedDependency>;
}
```

**Semver parsing helper:**
```typescript
function parseSemver(version: string): Pick<ResolvedDependency, 'versionMajor'|...> {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  // ...
}
```

**package-lock.json (npm):** `packages["node_modules/<name>"].version`
**pnpm-lock.yaml:** `importers["."].dependencies/<name>.version` or
  `packages["<name>@<version>"]` section
**yarn.lock v1:** Custom text format — entries look like:
  `"<name>@<range>":\n  version "<resolved>"`
**yarn.lock Berry (v2+):** YAML block format —
  `"<name>@npm:<range>":\n  version: <resolved>`

**Integration (Phase 2.5):** In `scanner.ts`, after loading config:
1. Detect which lockfile exists in `projectPath`
2. Parse it to get `Map<packageName, ResolvedDependency>`
3. When building `ScanResult`, look up each dependency name in the map
4. Add resolved version fields to `DependencyEntry`
5. In `extractor.ts` (or scanner), look up the resolved version for each
   `componentUsage.importedFrom` and `functionCall.importedFrom`

---

## §Parquet Tables (Phase 3)

Built by `usegraph build`. Reads from `~/.usegraph/*/scans/*.json`.
Writes to `~/.usegraph/built/*.parquet` using DuckDB.

**File layout:**
```
~/.usegraph/
  built/
    project_snapshots.parquet
    dependencies.parquet
    component_usages.parquet
    component_prop_usages.parquet
    function_usages.parquet
    function_arg_usages.parquet
```

### project_snapshots
One row per project per scan. `is_latest = true` for the newest scan per `project_id`.

| Column | Type | Source |
|--------|------|--------|
| project_id | VARCHAR | ScanResult.projectSlug |
| scanned_at | TIMESTAMP | ScanResult.scannedAt |
| repo_url | VARCHAR | ScanResult.repoUrl |
| branch | VARCHAR | ScanResult.branch |
| commit_sha | VARCHAR | ScanResult.commitSha |
| schema_version | INTEGER | ScanResult.schemaVersion |
| is_latest | BOOLEAN | computed at build time |
| package_manager | VARCHAR | ScanResult.meta.tooling.packageManager |
| build_tool | VARCHAR | ScanResult.meta.tooling.buildTool |
| test_framework | VARCHAR | ScanResult.meta.tooling.testFramework |
| bundler | VARCHAR | ScanResult.meta.tooling.bundler |
| linter | VARCHAR | ScanResult.meta.tooling.linter |
| formatter | VARCHAR | ScanResult.meta.tooling.formatter |
| css_approach | VARCHAR | ScanResult.meta.tooling.cssApproach |
| typescript | BOOLEAN | ScanResult.meta.tooling.typescript |
| typescript_version | VARCHAR | ScanResult.meta.tooling.typescriptVersion |
| node_version | VARCHAR | ScanResult.meta.tooling.nodeVersion |
| framework | VARCHAR | ScanResult.meta.tooling.framework |
| framework_version | VARCHAR | ScanResult.meta.tooling.frameworkVersion |

### dependencies
One row per dependency per project per scan.

| Column | Type | Source |
|--------|------|--------|
| project_id | VARCHAR | ScanResult.projectSlug |
| scanned_at | TIMESTAMP | ScanResult.scannedAt |
| is_latest | BOOLEAN | denormalised from project_snapshots |
| package_name | VARCHAR | DependencyEntry.name |
| version_range | VARCHAR | DependencyEntry.versionRange |
| version_resolved | VARCHAR | DependencyEntry.versionResolved |
| version_major | INTEGER | DependencyEntry.versionMajor |
| version_minor | INTEGER | DependencyEntry.versionMinor |
| version_patch | INTEGER | DependencyEntry.versionPatch |
| version_prerelease | VARCHAR | DependencyEntry.versionPrerelease |
| version_is_prerelease | BOOLEAN | DependencyEntry.versionIsPrerelease |
| dep_type | VARCHAR | DependencyEntry.section |
| is_internal | BOOLEAN | heuristic: name starts with configured internal scope |

### component_usages
One row per component per file per project per scan.

| Column | Type | Source |
|--------|------|--------|
| project_id | VARCHAR | |
| scanned_at | TIMESTAMP | |
| is_latest | BOOLEAN | |
| package_name | VARCHAR | ComponentUsage.importedFrom |
| package_version_resolved | VARCHAR | denormalised from deps |
| package_version_major | INTEGER | |
| package_version_minor | INTEGER | |
| package_version_patch | INTEGER | |
| package_version_prerelease | VARCHAR | |
| package_version_is_prerelease | BOOLEAN | |
| component_name | VARCHAR | ComponentUsage.componentName |
| file_path | VARCHAR | ComponentUsage.file (relative) |
| line | INTEGER | ComponentUsage.line |

### component_prop_usages
One row per prop per call site.

All columns from component_usages PLUS:

| Column | Type | Source |
|--------|------|--------|
| prop_name | VARCHAR | PropInfo.name |
| value_type | VARCHAR | "static" if !isDynamic else "dynamic" |
| value | VARCHAR | PropInfo.value stringified; NULL if dynamic |
| source_snippet | VARCHAR | PropInfo.sourceSnippet |

### function_usages
Mirrors component_usages with `export_name` instead of `component_name`.

| Column | Type | Notes |
|--------|------|-------|
| ... (project_id, scanned_at, is_latest, package_*, file_path, line) | | same as component_usages |
| export_name | VARCHAR | FunctionCallInfo.functionName |

### function_arg_usages
One row per arg per call site.

All columns from function_usages PLUS:

| Column | Type | Source |
|--------|------|--------|
| arg_index | INTEGER | ArgInfo.index |
| arg_name | VARCHAR | NULL (not yet captured; reserved) |
| value_type | VARCHAR | "static" if literal else "dynamic" |
| value | VARCHAR | ArgInfo.value stringified; NULL if dynamic |
| source_snippet | VARCHAR | ArgInfo.sourceSnippet |

---

## §MCP Tools (Phase 4)

MCP server starts on `--port` (default 3000). Queries run against DuckDB opened
on the Parquet files in `~/.usegraph/built/`.

**Default behaviour for all query tools:**
- Filter `is_latest = true` (current state)
- Exclude prerelease (`version_is_prerelease = false`) unless `include_prerelease: true`
- Return max 100 rows

### Discovery tools

**get_scan_metadata** — no input
```sql
SELECT COUNT(DISTINCT project_id) as project_count,
       MIN(scanned_at) as oldest_scan,
       MAX(scanned_at) as newest_scan,
       array_agg(DISTINCT schema_version) as schema_versions
FROM project_snapshots;
-- + projects where scanned_at < now() - INTERVAL 7 DAY → projectsWithStaleData
```

**list_projects** — `{ framework?, build_tool?, stale_after_days? }`
```sql
SELECT project_id, repo_url, scanned_at, framework, build_tool, test_framework, typescript
FROM project_snapshots WHERE is_latest = true
AND (? IS NULL OR framework = ?) AND (? IS NULL OR build_tool = ?)
ORDER BY project_id;
```

**list_packages** — `{ scope?, dep_type?, internal_only? }`
```sql
SELECT package_name, COUNT(DISTINCT project_id) as project_count
FROM dependencies WHERE is_latest = true
AND (? IS NULL OR package_name LIKE ? || '/%')
AND (? IS NULL OR dep_type = ?) AND (? IS NULL OR is_internal = ?)
GROUP BY package_name ORDER BY project_count DESC;
```

**get_project_snapshot** — `{ project_id: string }`
```sql
-- project_snapshots WHERE project_id = ? AND is_latest = true
-- + dependencies WHERE project_id = ? AND is_latest = true
```

### Dependency tools

**query_dependency_versions** — `{ package_name, dep_type?, include_prerelease? }`
```sql
SELECT version_resolved, version_major, version_minor, version_patch, version_prerelease,
       COUNT(*) as project_count, array_agg(project_id) as projects
FROM dependencies WHERE is_latest = true AND package_name = ?
AND (? OR version_is_prerelease = false)
GROUP BY version_resolved, version_major, version_minor, version_patch, version_prerelease
ORDER BY version_major DESC, version_minor DESC, version_patch DESC;
```

**query_prerelease_usage** — `{ package_name, prerelease_filter? }`
```sql
SELECT version_resolved, version_prerelease,
       COUNT(*) as project_count, array_agg(project_id) as projects
FROM dependencies WHERE is_latest = true AND package_name = ?
AND version_is_prerelease = true
AND (? IS NULL OR version_prerelease LIKE '%' || ? || '%')
GROUP BY version_resolved, version_prerelease ORDER BY project_count DESC;
```

**query_tooling_distribution** — `{ category: 'test_framework'|'build_tool'|'package_manager'|'bundler'|'linter'|'formatter'|'css_approach'|'framework'|'typescript' }`
```sql
-- category MUST be validated against allowlist before SQL interpolation
SELECT {category} as value, COUNT(*) as project_count, array_agg(project_id) as projects
FROM project_snapshots WHERE is_latest = true AND {category} IS NOT NULL
GROUP BY {category} ORDER BY project_count DESC;
```

### Component tools

**query_component_usage** — `{ package_name, component_name, package_version?, version_match?, include_prerelease?, include_files? }`
```sql
SELECT project_id, file_path, line, package_version_resolved
FROM component_usages WHERE is_latest = true
AND package_name = ? AND component_name = ?
AND (? IS NULL OR package_version_major = ?)
AND version_is_prerelease = false
ORDER BY project_id, file_path;
```

**query_prop_usage** — `{ package_name, component_name, prop_name, package_version?, version_match?, include_prerelease? }`
```sql
SELECT project_id, file_path, line, value_type, value, source_snippet, package_version_resolved
FROM component_prop_usages WHERE is_latest = true
AND package_name = ? AND component_name = ? AND prop_name = ?
AND (? IS NULL OR package_version_major = ?) AND version_is_prerelease = false
ORDER BY project_id, file_path;
```

**query_component_adoption_trend** — `{ package_name, component_name?, period_months?, granularity? }`
```sql
SELECT date_trunc('month', scanned_at) as period,
       COUNT(DISTINCT project_id) as adopting_projects
FROM component_usages
WHERE package_name = ? AND (? IS NULL OR component_name = ?)
AND scanned_at >= current_date - INTERVAL ? MONTH
AND version_is_prerelease = false
GROUP BY period ORDER BY period;
```

### Function tools

**query_export_usage** — `{ package_name, export_name, package_version?, version_match?, include_prerelease?, include_files? }`
```sql
SELECT fu.project_id, fu.file_path, fu.line,
       fau.arg_index, fau.value_type, fau.value, fau.source_snippet,
       fu.package_version_resolved
FROM function_usages fu
JOIN function_arg_usages fau
  ON fu.project_id = fau.project_id AND fu.scanned_at = fau.scanned_at
     AND fu.file_path = fau.file_path AND fu.line = fau.line
WHERE fu.is_latest = true AND fu.package_name = ? AND fu.export_name = ?
AND (? IS NULL OR fu.package_version_major = ?)
AND fu.version_is_prerelease = false
ORDER BY fu.project_id, fu.file_path;
```

**query_export_adoption_trend** — `{ package_name, export_name, period_months?, granularity? }`
```sql
-- mirrors query_component_adoption_trend against function_usages
```

**get_source_context** — `{ project_id, file_path, line, prop_name?, arg_index? }`
```sql
-- If prop_name provided:
SELECT source_snippet, value_type, value FROM component_prop_usages
WHERE project_id = ? AND file_path = ? AND line = ? AND prop_name = ? AND is_latest = true;
-- If arg_index provided:
SELECT source_snippet, value_type, value FROM function_arg_usages
WHERE project_id = ? AND file_path = ? AND line = ? AND arg_index = ? AND is_latest = true;
```

---

## §Implementation Warnings

1. **Lockfile complexity**: Yarn Berry changed format from v1. Budget extra time.
   Parse v1 and Berry separately; detect by presence of `__metadata:` block.

2. **Column injection**: `query_tooling_distribution` uses a dynamic column name.
   MUST validate `category` against this exact allowlist before SQL interpolation:
   `['test_framework','build_tool','package_manager','bundler','linter','formatter',
     'css_approach','framework','typescript']`

3. **Prerelease versions**: Store as opaque string. Never numeric compare. Default-exclude
   (spec rule: 2.1.0-beta is NOT in ^2.0.0 range).

4. **is_latest computation**: Compute at `usegraph build` time by ranking rows per
   `project_id` by `scanned_at DESC` and flagging the top row.

5. **Schema migration**: Old scan files (no `schemaVersion` field) are treated as v0.
   The build step should handle missing fields gracefully (use NULL).
