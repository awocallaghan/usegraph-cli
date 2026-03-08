/**
 * Project scanner: walks a directory tree, filters source files, and runs
 * analyzeFile() on each one (with a concurrency limit to avoid OOM).
 *
 * Incremental caching: when `cacheDir` is provided, per-file mtime+size are
 * checked against a persisted cache. Unchanged files skip SWC re-parsing,
 * making repeated scans on large codebases significantly faster.
 */
import fg from 'fast-glob';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { analyzeFile } from './file-analyzer.js';
import { analyzeProjectMeta } from './meta-analyzer.js';
import { parseCiFiles } from './ci-parser.js';
import {
  npmLockfileParser,
  pnpmLockfileParser,
  yarnV1LockfileParser,
  yarnBerryLockfileParser,
  type ResolvedDependency,
} from './lockfile.js';
import { loadFileCache, saveFileCache } from '../storage.js';
import type { FileCacheEntry, FileCache } from '../storage.js';
import type { FileAnalysis, ScanResult, ScanSummary, PackageSummary, UsegraphConfig } from '../types.js';
import { randomUUID } from 'crypto';

/** Progress callback for CLI feedback */
export type ProgressFn = (done: number, total: number, file: string, cached: boolean) => void;

export { getCommitSha };

export interface ScanOptions {
  projectPath: string;
  targetPackages: string[];
  config: UsegraphConfig;
  onProgress?: ProgressFn;
  /** Max parallel file analyses (default: 8) */
  concurrency?: number;
  /**
   * Directory where the incremental file cache is stored.
   * Typically the same as the outputDir (e.g. .usegraph).
   * Omit to disable caching.
   */
  cacheDir?: string;
  /** Pre-computed stable identity key; avoids duplicate git calls inside the scanner. */
  projectSlug?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Git metadata helpers — return null on error (no git, no remote, etc.)
// ─────────────────────────────────────────────────────────────────────────────

function gitRaw(projectPath: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', projectPath, ...args], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function getRepoUrl(projectPath: string): string | null {
  return gitRaw(projectPath, ['remote', 'get-url', 'origin']);
}

function getBranch(projectPath: string): string | null {
  return gitRaw(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function getCommitSha(projectPath: string): string | null {
  return gitRaw(projectPath, ['rev-parse', 'HEAD']);
}

function getCommitTimestamp(projectPath: string): string | null {
  return gitRaw(projectPath, ['log', '-1', '--format=%cI', 'HEAD']);
}

/**
 * Find the directory that owns the `package.json` governing this project.
 *
 * Priority:
 *   1. `projectPath` itself (root-level package.json — the common case).
 *   2. A single immediate subdirectory that contains a package.json, e.g.
 *      `frontend/package.json`.  When multiple subdirectories each have their
 *      own package.json (monorepo root), we fall back to `projectPath` so the
 *      caller keeps its normal behaviour.
 *
 * Returns the resolved package-root directory (always an absolute path).
 */
export function findPackageRoot(projectPath: string): string {
  if (existsSync(join(projectPath, 'package.json'))) return projectPath;

  const hits = fg.sync('*/package.json', {
    cwd: projectPath,
    ignore: ['**/node_modules/**'],
  });

  // Exactly one subdirectory package.json → use that directory
  if (hits.length === 1) {
    return join(projectPath, dirname(hits[0]));
  }

  return projectPath;
}

/**
 * Find the directory that contains the project's lockfile, starting at
 * `packageRoot` and walking up the directory tree (up to 4 levels).
 *
 * This allows workspace packages inside a monorepo to locate the root-level
 * lockfile that pnpm / yarn / npm writes at the workspace root rather than
 * inside each individual package directory.
 *
 * Returns `packageRoot` when no lockfile is found anywhere in the chain.
 */
export function findLockfileDir(packageRoot: string): string {
  const lockfiles = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb'];
  let dir = packageRoot;

  for (let i = 0; i < 4; i++) {
    if (lockfiles.some((lf) => existsSync(join(dir, lf)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }

  return packageRoot; // fallback: no lockfile found
}

function readPackageJson(projectPath: string): Record<string, unknown> | null {
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Build a set of known package names from package.json `dependencies` and
 * `devDependencies`.  Used to distinguish real npm imports from project-level
 * path aliases (e.g. webpack/Vite aliases like `@components/Button`).
 */
function readKnownPackages(projectPath: string): Set<string> {
  const packageRoot = findPackageRoot(projectPath);
  const pkg = readPackageJson(packageRoot);
  if (!pkg) return new Set();
  const names: string[] = [];
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field] as Record<string, unknown> | undefined;
    if (deps) names.push(...Object.keys(deps));
  }
  return new Set(names);
}

/**
 * Detect the lockfile present at or above `projectPath` and parse it into a
 * resolved version map.  Priority order mirrors meta-analyzer's packageManager
 * detection: pnpm > bun (no lockfile parser yet) > yarn > npm.
 *
 * When the project is a workspace package inside a monorepo, the lockfile
 * typically lives at the workspace root rather than inside the package
 * directory — `findLockfileDir` walks up the tree to locate it.
 *
 * Returns an empty map when no supported lockfile is found or parsing fails.
 */
function detectAndParseLockfile(projectPath: string): Map<string, ResolvedDependency> {
  const packageRoot = findPackageRoot(projectPath);
  const lockfileDir = findLockfileDir(packageRoot);

  const candidates: Array<{ file: string; parse: (content: string) => Map<string, ResolvedDependency> }> = [
    {
      file: 'pnpm-lock.yaml',
      parse: (c) => pnpmLockfileParser.parse(c),
    },
    {
      file: 'yarn.lock',
      parse: (c) =>
        c.includes('__metadata:')
          ? yarnBerryLockfileParser.parse(c)
          : yarnV1LockfileParser.parse(c),
    },
    {
      file: 'package-lock.json',
      parse: (c) => npmLockfileParser.parse(c),
    },
  ];

  for (const { file, parse } of candidates) {
    const lockPath = join(lockfileDir, file);
    if (!existsSync(lockPath)) continue;
    try {
      const content = readFileSync(lockPath, 'utf-8');
      return parse(content);
    } catch {
      return new Map();
    }
  }

  return new Map();
}

export async function scanProject(opts: ScanOptions): Promise<ScanResult> {
  const { projectPath, targetPackages, config, onProgress, concurrency = 8, cacheDir } = opts;
  const targetSet = new Set(targetPackages);

  // Locate the package.json — it may live in a subdirectory (e.g. frontend/)
  const packageRoot = findPackageRoot(projectPath);
  const knownPackages = readKnownPackages(projectPath);

  // Load incremental cache (returns a blank cache when disabled or cold)
  const cache: FileCache | null = cacheDir
    ? loadFileCache(cacheDir, targetPackages)
    : null;

  // Resolve glob patterns relative to projectPath
  const files = await fg(config.include, {
    cwd: projectPath,
    absolute: true,
    ignore: config.exclude,
    followSymbolicLinks: false,
    suppressErrors: true,
  });

  const total = files.length;
  let done = 0;
  let cacheHits = 0;

  // Analyse files with bounded concurrency
  const results: FileAnalysis[] = [];

  const queue = [...files];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length > 0) {
      const file = queue.shift()!;
      let analysis: FileAnalysis;
      let fromCache = false;

      if (cache) {
        try {
          const st = statSync(file);
          const entry: FileCacheEntry | undefined = cache.entries[file];
          if (entry && entry.mtime === st.mtimeMs && entry.size === st.size) {
            // Cache hit — reuse previous analysis
            analysis = entry.analysis;
            fromCache = true;
            cacheHits++;
          } else {
            // Cache miss — (re-)analyse and update entry
            analysis = await analyzeFile(file, projectPath, targetSet, knownPackages);
            cache.entries[file] = { mtime: st.mtimeMs, size: st.size, analysis };
          }
        } catch {
          // stat failed; fall back to fresh analysis without caching this file
          analysis = await analyzeFile(file, projectPath, targetSet, knownPackages);
        }
      } else {
        analysis = await analyzeFile(file, projectPath, targetSet, knownPackages);
      }

      results.push(analysis);
      done++;
      onProgress?.(done, total, analysis.relativePath, fromCache);
    }
  });

  await Promise.all(workers);

  // Persist updated cache (only when caching is enabled)
  if (cache && cacheDir) {
    saveFileCache(cacheDir, cache);
  }

  const summary = buildSummary(results, targetPackages);

  // Pass the located lockfile directory so analyzeProjectMeta can detect the
  // package manager even when the lockfile lives at the monorepo root.
  const lockfileDir = findLockfileDir(packageRoot);
  const meta = analyzeProjectMeta(packageRoot, lockfileDir);

  // Resolve installed versions from the lockfile and enrich the scan result
  const resolvedVersions = detectAndParseLockfile(projectPath);
  enrichWithResolvedVersions(results, meta, resolvedVersions);

  // Scan CI configuration files (always-on; gracefully absent)
  const ciResult = parseCiFiles(projectPath);
  const ciProviders = [...new Set(ciResult.usages.map((u) => u.provider))];

  const commitSha = getCommitSha(projectPath);
  return {
    id: commitSha ?? randomUUID(),
    schemaVersion: 1,
    projectPath,
    projectName: basename(projectPath),
    projectSlug: opts.projectSlug ?? basename(projectPath),
    scannedAt: new Date().toISOString(),
    repoUrl: getRepoUrl(projectPath),
    branch: getBranch(projectPath),
    commitSha,
    packageJson: readPackageJson(packageRoot),
    targetPackages,
    internalPackages: [],
    fileCount: files.length,
    files: results,
    summary,
    meta,
    cacheHits: cache ? cacheHits : undefined,
    codeAt: getCommitTimestamp(projectPath),
    ...(ciResult.usages.length > 0 || ciResult.errors.length > 0
      ? {
          ciTemplateUsages: ciResult.usages,
          ciScanSummary: {
            totalCiFiles: countCiFiles(projectPath),
            totalTemplateUsages: ciResult.usages.length,
            providers: ciProviders,
            filesWithErrors: ciResult.errors,
          },
        }
      : {}),
  };
}

/** Count CI config files present in the project (for summary reporting). */
function countCiFiles(projectPath: string): number {
  let count = 0;
  try {
    const workflowsDir = join(projectPath, '.github', 'workflows');
    if (existsSync(workflowsDir)) {
      count += readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).length;
    }
  } catch { /* ignore */ }
  if (existsSync(join(projectPath, '.gitlab-ci.yml'))) count++;
  return count;
}

/**
 * Enrich `DependencyEntry[]` in ProjectMeta and all `ComponentUsage` /
 * `FunctionCallInfo` objects with resolved version data from the lockfile.
 *
 * Mutates the input arrays in-place (avoids re-allocation overhead).
 */
function enrichWithResolvedVersions(
  fileResults: FileAnalysis[],
  meta: ReturnType<typeof analyzeProjectMeta> | undefined,
  resolved: Map<string, ResolvedDependency>,
): void {
  if (resolved.size === 0) return;

  // Enrich DependencyEntry items
  if (meta) {
    for (const dep of meta.dependencies) {
      const r = resolved.get(dep.name);
      if (r) {
        dep.versionResolved = r.versionResolved;
        dep.versionMajor = r.versionMajor;
        dep.versionMinor = r.versionMinor;
        dep.versionPatch = r.versionPatch;
        dep.versionPrerelease = r.versionPrerelease;
        dep.versionIsPrerelease = r.versionIsPrerelease;
      }
    }
  }

  // Denormalise resolved version onto each component usage and function call
  for (const file of fileResults) {
    for (const usage of file.componentUsages) {
      const r = resolved.get(usage.importedFrom);
      if (r) {
        usage.packageVersionResolved = r.versionResolved;
        usage.packageVersionMajor = r.versionMajor;
        usage.packageVersionMinor = r.versionMinor;
        usage.packageVersionPatch = r.versionPatch;
        usage.packageVersionPrerelease = r.versionPrerelease;
        usage.packageVersionIsPrerelease = r.versionIsPrerelease;
      }
    }

    for (const call of file.functionCalls) {
      const r = resolved.get(call.importedFrom);
      if (r) {
        call.packageVersionResolved = r.versionResolved;
        call.packageVersionMajor = r.versionMajor;
        call.packageVersionMinor = r.versionMinor;
        call.packageVersionPatch = r.versionPatch;
        call.packageVersionPrerelease = r.versionPrerelease;
        call.packageVersionIsPrerelease = r.versionIsPrerelease;
      }
    }
  }
}

function buildSummary(files: FileAnalysis[], targetPackages: string[]): ScanSummary {
  let filesWithTargetUsage = 0;
  let filesWithErrors = 0;
  let totalComponentUsages = 0;
  let totalFunctionCalls = 0;
  const byPackage: Record<string, PackageSummary> = {};

  for (const file of files) {
    if (file.errors.length > 0) filesWithErrors++;

    const hasUsage = file.componentUsages.length > 0 || file.functionCalls.length > 0;
    if (hasUsage) filesWithTargetUsage++;

    totalComponentUsages += file.componentUsages.length;
    totalFunctionCalls += file.functionCalls.length;

    for (const usage of file.componentUsages) {
      const pkg = usage.importedFrom;
      if (!byPackage[pkg]) byPackage[pkg] = emptyPackageSummary();
      const s = byPackage[pkg];
      s.totalComponentUsages++;
      if (!s.files.includes(file.relativePath)) s.files.push(file.relativePath);
      if (!s.components.includes(usage.componentName)) s.components.push(usage.componentName);
    }

    for (const call of file.functionCalls) {
      const pkg = call.importedFrom;
      if (!byPackage[pkg]) byPackage[pkg] = emptyPackageSummary();
      const s = byPackage[pkg];
      s.totalFunctionCalls++;
      if (!s.files.includes(file.relativePath)) s.files.push(file.relativePath);
      if (!s.functions.includes(call.functionName)) s.functions.push(call.functionName);
    }
  }

  return {
    totalFilesScanned: files.length,
    filesWithErrors,
    filesWithTargetUsage,
    totalComponentUsages,
    totalFunctionCalls,
    byPackage,
  };
}

function emptyPackageSummary(): PackageSummary {
  return { totalComponentUsages: 0, totalFunctionCalls: 0, files: [], components: [], functions: [] };
}
