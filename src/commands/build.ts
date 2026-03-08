/**
 * usegraph build — reads all scan JSON files from ~/.usegraph/ and
 * materialises 6 Parquet tables in ~/.usegraph/built/.
 *
 * Tables written (per SPEC.md §Parquet Tables):
 *   project_snapshots        — one row per project per scan
 *   dependencies             — one row per dependency per project per scan
 *   component_usages         — one row per component use site per scan
 *   component_prop_usages    — one row per prop per component use site per scan
 *   function_usages          — one row per function call per scan
 *   function_arg_usages      — one row per arg per function call per scan
 *
 * Implementation strategy:
 *   1. Walk ~/.usegraph/.../scans/*.json to discover all scan files
 *   2. Parse each file as ScanResult (schema v0 → missing fields → null)
 *   3. Compute is_latest per projectSlug (newest scannedAt wins)
 *   4. Build typed row arrays for all 6 tables
 *   5. Write each array to a temp JSON file, then COPY to Parquet via DuckDB
 */
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import chalk from 'chalk';
import duckdb from 'duckdb';
import type { ScanResult } from '../types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Root of the global cross-project store.
 * Override with the `USEGRAPH_HOME` environment variable (useful for testing).
 */
export const STORE_ROOT = process.env.USEGRAPH_HOME ?? join(homedir(), '.usegraph');

/** Output directory for materialised Parquet files */
export const BUILT_DIR = join(STORE_ROOT, 'built');

// ─── Row-level types (match SPEC.md §Parquet Tables) ─────────────────────────

interface ProjectSnapshotRow {
  project_id: string;
  scanned_at: string;
  code_at: string | null;
  repo_url: string | null;
  branch: string | null;
  commit_sha: string | null;
  schema_version: number;
  is_latest: boolean;
  package_manager: string | null;
  build_tool: string | null;
  test_framework: string | null;
  bundler: string | null;
  linter: string | null;
  formatter: string | null;
  css_approach: string | null;
  typescript: boolean | null;
  typescript_version: string | null;
  node_version: string | null;
  framework: string | null;
  framework_version: string | null;
}

interface DependencyRow {
  project_id: string;
  scanned_at: string;
  code_at: string | null;
  is_latest: boolean;
  package_name: string;
  version_range: string;
  version_resolved: string | null;
  version_major: number | null;
  version_minor: number | null;
  version_patch: number | null;
  version_prerelease: string | null;
  version_is_prerelease: boolean | null;
  dep_type: string;
  is_internal: boolean;
}

interface ComponentUsageRow {
  project_id: string;
  scanned_at: string;
  code_at: string | null;
  is_latest: boolean;
  package_name: string;
  package_version_resolved: string | null;
  package_version_major: number | null;
  package_version_minor: number | null;
  package_version_patch: number | null;
  package_version_prerelease: string | null;
  package_version_is_prerelease: boolean | null;
  component_name: string;
  file_path: string;
  line: number;
}

interface ComponentPropUsageRow extends ComponentUsageRow {
  prop_name: string;
  value_type: string; // 'static' | 'dynamic'
  value: string | null;
  source_snippet: string | null;
}

interface FunctionUsageRow {
  project_id: string;
  scanned_at: string;
  code_at: string | null;
  is_latest: boolean;
  package_name: string;
  package_version_resolved: string | null;
  package_version_major: number | null;
  package_version_minor: number | null;
  package_version_patch: number | null;
  package_version_prerelease: string | null;
  package_version_is_prerelease: boolean | null;
  export_name: string;
  file_path: string;
  line: number;
}

interface FunctionArgUsageRow extends FunctionUsageRow {
  arg_index: number;
  arg_name: string | null;
  value_type: string; // 'static' | 'dynamic'
  value: string | null;
  source_snippet: string | null;
}

interface CiTemplateUsageRow {
  project_id: string;
  scanned_at: string;
  code_at: string | null;
  is_latest: boolean;
  provider: string;
  template_type: string;
  source: string;
  version: string | null;
  file_path: string;
  line: number;
}

interface CiTemplateInputRow extends CiTemplateUsageRow {
  input_name: string;
  value_type: string; // 'static' | 'dynamic'
  value: string | null;
}

interface AllRows {
  project_snapshots: ProjectSnapshotRow[];
  dependencies: DependencyRow[];
  component_usages: ComponentUsageRow[];
  component_prop_usages: ComponentPropUsageRow[];
  function_usages: FunctionUsageRow[];
  function_arg_usages: FunctionArgUsageRow[];
  ci_template_usages: CiTemplateUsageRow[];
  ci_template_inputs: CiTemplateInputRow[];
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runBuild(): Promise<void> {
  // 1. Discover all scan files under ~/.usegraph/
  const scanFiles = discoverScanFiles(STORE_ROOT);

  if (scanFiles.length === 0) {
    console.log(chalk.yellow('No scan files found. Run `usegraph scan` on a project first.'));
    return;
  }

  console.log(chalk.dim(`Found ${scanFiles.length} scan file(s). Reading...`));

  // 2. Parse scans; skip unreadable / invalid files
  const scans: ScanResult[] = [];
  let parseErrors = 0;
  for (const file of scanFiles) {
    try {
      const raw = readFileSync(file, 'utf-8');
      scans.push(JSON.parse(raw) as ScanResult);
    } catch {
      parseErrors++;
    }
  }

  if (scans.length === 0) {
    console.log(chalk.yellow('No valid scans found.'));
    return;
  }

  console.log(chalk.dim(`Loaded ${scans.length} scan(s). Building Parquet tables...`));

  // 3. Ensure output directory exists
  mkdirSync(BUILT_DIR, { recursive: true });

  // 4. Compute is_latest per project
  const latestIds = computeLatestIds(scans);

  // 5. Build all rows
  const rows = buildAllRows(scans, latestIds);

  // 6. Write to Parquet via DuckDB
  await writeParquetFiles(rows);

  // Summary
  const tableNames = Object.keys(rows) as Array<keyof AllRows>;
  console.log(chalk.green('✓ Parquet tables materialised:'));
  for (const name of tableNames) {
    const count = rows[name].length;
    const tag = count > 0
      ? chalk.dim(`${count.toLocaleString()} rows`)
      : chalk.dim('(empty — file skipped)');
    console.log(`  ${chalk.green(name + '.parquet')}  ${tag}`);
  }
  if (parseErrors > 0) {
    console.log(chalk.yellow(`  ${parseErrors} scan file(s) skipped (parse errors)`));
  }
}

// ─── File discovery ───────────────────────────────────────────────────────────

/**
 * Walk storeRoot looking for `scans/<uuid>.json` files.
 * Skips the `built/` subdirectory to avoid reading previously written output.
 */
function discoverScanFiles(storeRoot: string): string[] {
  if (!existsSync(storeRoot)) return [];
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 8) return; // guard against symlink loops
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'built') continue; // skip output directory
      const fullPath = join(dir, entry);

      if (entry === 'scans') {
        // Collect .json files inside this scans/ directory
        try {
          for (const f of readdirSync(fullPath)) {
            if (f.endsWith('.json')) {
              results.push(join(fullPath, f));
            }
          }
        } catch { /* skip unreadable */ }
        continue;
      }

      try {
        if (statSync(fullPath).isDirectory()) walk(fullPath, depth + 1);
      } catch { /* skip unreadable */ }
    }
  }

  walk(storeRoot, 0);
  return results;
}

// ─── is_latest computation ────────────────────────────────────────────────────

/**
 * For each projectSlug, identify the scan with the latest codeAt (falling back
 * to scannedAt for older scans that pre-date codeAt). Historical scans with an
 * older codeAt correctly appear as older rows even when scanned recently.
 * Returns a Set of scan IDs that are the "latest" for their project.
 */
function computeLatestIds(scans: ScanResult[]): Set<string> {
  const latestById = new Map<string, string>(); // slug → scanId
  const latestDate = new Map<string, string>(); // slug → effectiveDate

  for (const scan of scans) {
    const slug = scan.projectSlug ?? scan.projectName ?? scan.id;
    const effectiveDate = (scan as { codeAt?: string | null }).codeAt ?? scan.scannedAt;
    const existing = latestDate.get(slug);
    if (!existing || effectiveDate > existing) {
      latestById.set(slug, scan.id);
      latestDate.set(slug, effectiveDate);
    }
  }

  return new Set(latestById.values());
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function buildAllRows(scans: ScanResult[], latestIds: Set<string>): AllRows {
  const snapshots: ProjectSnapshotRow[] = [];
  const deps: DependencyRow[] = [];
  const compUsages: ComponentUsageRow[] = [];
  const compPropUsages: ComponentPropUsageRow[] = [];
  const funcUsages: FunctionUsageRow[] = [];
  const funcArgUsages: FunctionArgUsageRow[] = [];
  const ciUsages: CiTemplateUsageRow[] = [];
  const ciInputs: CiTemplateInputRow[] = [];

  for (const scan of scans) {
    const project_id = scan.projectSlug ?? scan.projectName ?? scan.id;
    const scanned_at = scan.scannedAt;
    const code_at = (scan as { codeAt?: string | null }).codeAt ?? null;
    const is_latest = latestIds.has(scan.id);
    const schema_version = (scan as { schemaVersion?: number }).schemaVersion ?? 0;
    const tooling = scan.meta?.tooling ?? null;

    // ── project_snapshots ──────────────────────────────────────────────────
    snapshots.push({
      project_id,
      scanned_at,
      code_at,
      repo_url: scan.repoUrl ?? null,
      branch: scan.branch ?? null,
      commit_sha: scan.commitSha ?? null,
      schema_version,
      is_latest,
      package_manager: tooling?.packageManager ?? null,
      build_tool: tooling?.buildTool ?? null,
      test_framework: tooling?.testFramework ?? null,
      bundler: tooling?.bundler ?? null,
      linter: tooling?.linter ?? null,
      formatter: tooling?.formatter ?? null,
      css_approach: tooling?.cssApproach ?? null,
      typescript: tooling?.typescript ?? null,
      typescript_version: tooling?.typescriptVersion ?? null,
      node_version: tooling?.nodeVersion ?? null,
      framework: tooling?.framework ?? null,
      framework_version: tooling?.frameworkVersion ?? null,
    });

    // ── dependencies ───────────────────────────────────────────────────────
    if (scan.meta?.dependencies) {
      const internalPackages: string[] = (scan as { internalPackages?: string[] }).internalPackages ?? [];
      for (const dep of scan.meta.dependencies) {
        const is_internal = internalPackages.some((pat) =>
          pat.endsWith('/') ? dep.name.startsWith(pat) : dep.name === pat,
        );
        deps.push({
          project_id,
          scanned_at,
          code_at,
          is_latest,
          package_name: dep.name,
          version_range: dep.versionRange,
          version_resolved: dep.versionResolved ?? null,
          version_major: dep.versionMajor ?? null,
          version_minor: dep.versionMinor ?? null,
          version_patch: dep.versionPatch ?? null,
          version_prerelease: dep.versionPrerelease ?? null,
          version_is_prerelease: dep.versionIsPrerelease ?? null,
          dep_type: dep.section,
          is_internal,
        });
      }
    }

    // ── component_usages + component_prop_usages ───────────────────────────
    for (const file of scan.files ?? []) {
      for (const usage of file.componentUsages ?? []) {
        const usageBase: ComponentUsageRow = {
          project_id,
          scanned_at,
          code_at,
          is_latest,
          package_name: usage.importedFrom,
          package_version_resolved: usage.packageVersionResolved ?? null,
          package_version_major: usage.packageVersionMajor ?? null,
          package_version_minor: usage.packageVersionMinor ?? null,
          package_version_patch: usage.packageVersionPatch ?? null,
          package_version_prerelease: usage.packageVersionPrerelease ?? null,
          package_version_is_prerelease: usage.packageVersionIsPrerelease ?? null,
          component_name: usage.componentName,
          file_path: file.relativePath ?? usage.file,
          line: usage.line,
        };

        compUsages.push(usageBase);

        for (const prop of usage.props ?? []) {
          compPropUsages.push({
            ...usageBase,
            prop_name: prop.name,
            value_type: prop.isDynamic ? 'dynamic' : 'static',
            value: prop.isDynamic ? null : stringify(prop.value),
            source_snippet: prop.sourceSnippet ?? null,
          });
        }
      }

      // ── function_usages + function_arg_usages ────────────────────────────
      for (const call of file.functionCalls ?? []) {
        const callBase: FunctionUsageRow = {
          project_id,
          scanned_at,
          code_at,
          is_latest,
          package_name: call.importedFrom,
          package_version_resolved: call.packageVersionResolved ?? null,
          package_version_major: call.packageVersionMajor ?? null,
          package_version_minor: call.packageVersionMinor ?? null,
          package_version_patch: call.packageVersionPatch ?? null,
          package_version_prerelease: call.packageVersionPrerelease ?? null,
          package_version_is_prerelease: call.packageVersionIsPrerelease ?? null,
          export_name: call.functionName,
          file_path: file.relativePath ?? call.file,
          line: call.line,
        };

        funcUsages.push(callBase);

        for (const arg of call.args ?? []) {
          const isStatic = ['string', 'number', 'boolean', 'null', 'undefined'].includes(arg.type);
          funcArgUsages.push({
            ...callBase,
            arg_index: arg.index,
            arg_name: null, // reserved; not yet captured by extractor
            value_type: isStatic ? 'static' : 'dynamic',
            value: isStatic && arg.value !== undefined ? stringify(arg.value) : null,
            source_snippet: arg.sourceSnippet ?? null,
          });
        }
      }
    }

    // ── ci_template_usages + ci_template_inputs ────────────────────────────
    for (const ciUsage of (scan as { ciTemplateUsages?: unknown[] }).ciTemplateUsages ?? []) {
      const u = ciUsage as {
        file: string; line: number; provider: string; templateType: string;
        source: string; version: string | null; inputs: Array<{ name: string; isDynamic: boolean; value: string | null }>;
      };
      const ciBase: CiTemplateUsageRow = {
        project_id,
        scanned_at,
        code_at,
        is_latest,
        provider: u.provider,
        template_type: u.templateType,
        source: u.source,
        version: u.version ?? null,
        file_path: u.file,
        line: u.line,
      };
      ciUsages.push(ciBase);

      for (const inp of u.inputs ?? []) {
        ciInputs.push({
          ...ciBase,
          input_name: inp.name,
          value_type: inp.isDynamic ? 'dynamic' : 'static',
          value: inp.isDynamic ? null : inp.value,
        });
      }
    }
  }

  return {
    project_snapshots: snapshots,
    dependencies: deps,
    component_usages: compUsages,
    component_prop_usages: compPropUsages,
    function_usages: funcUsages,
    function_arg_usages: funcArgUsages,
    ci_template_usages: ciUsages,
    ci_template_inputs: ciInputs,
  };
}

/** Safely convert a prop/arg value to a string for storage */
function stringify(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

// ─── DuckDB Parquet writer ────────────────────────────────────────────────────

async function writeParquetFiles(rows: AllRows): Promise<void> {
  const db = await new Promise<duckdb.Database>((resolve, reject) => {
    const instance = new duckdb.Database(':memory:', (err) => {
      if (err) reject(err);
      else resolve(instance);
    });
  });

  const conn = db.connect();

  /** Promisified conn.run for DDL / COPY statements */
  const run = (sql: string): Promise<void> =>
    new Promise((resolve, reject) => {
      conn.run(sql, (err) => {
        if (err) {
          const msg = (err as Error).message ?? String(err);
          reject(new Error(`DuckDB error: ${msg}\n  SQL: ${sql.slice(0, 120)}`));
        } else {
          resolve();
        }
      });
    });

  const tableEntries = Object.entries(rows) as Array<[keyof AllRows, object[]]>;

  for (const [tableName, tableRows] of tableEntries) {
    const outPath = join(BUILT_DIR, `${tableName}.parquet`);

    if (tableRows.length === 0) {
      continue;
    }

    const tmpPath = join(tmpdir(), `usegraph-${tableName}-${Date.now()}.json`);

    try {
      writeFileSync(tmpPath, JSON.stringify(tableRows));

      await run(
        `COPY (` +
          `SELECT * FROM read_json_auto(` +
          `  '${sqlStr(tmpPath)}',` +
          `  maximum_object_size=104857600` + // 100 MB
          `)` +
          `) TO '${sqlStr(outPath)}' (FORMAT PARQUET)`,
      );
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch { /* ignore cleanup errors */ }
    }
  }

  conn.close();
  await new Promise<void>((resolve) => db.close(() => resolve()));
}

/** Escape single quotes in a string for use in a SQL string literal */
function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}
