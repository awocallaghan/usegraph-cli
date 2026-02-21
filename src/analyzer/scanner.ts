/**
 * Project scanner: walks a directory tree, filters source files, and runs
 * analyzeFile() on each one (with a concurrency limit to avoid OOM).
 *
 * Incremental caching: when `cacheDir` is provided, per-file mtime+size are
 * checked against a persisted cache. Unchanged files skip SWC re-parsing,
 * making repeated scans on large codebases significantly faster.
 */
import fg from 'fast-glob';
import { statSync } from 'fs';
import { basename } from 'path';
import { analyzeFile } from './file-analyzer';
import { analyzeProjectMeta } from './meta-analyzer';
import { loadFileCache, saveFileCache } from '../storage';
import type { FileCacheEntry, FileCache } from '../storage';
import type { FileAnalysis, ScanResult, ScanSummary, PackageSummary, UsegraphConfig } from '../types';
import { randomUUID } from 'crypto';

/** Progress callback for CLI feedback */
export type ProgressFn = (done: number, total: number, file: string, cached: boolean) => void;

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

export async function scanProject(opts: ScanOptions): Promise<ScanResult> {
  const { projectPath, targetPackages, config, onProgress, concurrency = 8, cacheDir } = opts;
  const targetSet = new Set(targetPackages);

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
            analysis = await analyzeFile(file, projectPath, targetSet);
            cache.entries[file] = { mtime: st.mtimeMs, size: st.size, analysis };
          }
        } catch {
          // stat failed; fall back to fresh analysis without caching this file
          analysis = await analyzeFile(file, projectPath, targetSet);
        }
      } else {
        analysis = await analyzeFile(file, projectPath, targetSet);
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
  const meta = analyzeProjectMeta(projectPath);

  return {
    id: randomUUID(),
    projectPath,
    projectName: basename(projectPath),
    projectSlug: opts.projectSlug ?? basename(projectPath),
    scannedAt: new Date().toISOString(),
    targetPackages,
    fileCount: files.length,
    files: results,
    summary,
    meta,
    cacheHits: cache ? cacheHits : undefined,
  };
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
