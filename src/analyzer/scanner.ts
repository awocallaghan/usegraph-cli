/**
 * Project scanner: walks a directory tree, filters source files, and runs
 * analyzeFile() on each one (with a concurrency limit to avoid OOM).
 */
import fg from 'fast-glob';
import { basename } from 'path';
import { analyzeFile } from './file-analyzer';
import { analyzeProjectMeta } from './meta-analyzer';
import type { FileAnalysis, ScanResult, ScanSummary, PackageSummary, UsegraphConfig } from '../types';
import { randomUUID } from 'crypto';

/** Progress callback for CLI feedback */
export type ProgressFn = (done: number, total: number, file: string) => void;

export interface ScanOptions {
  projectPath: string;
  targetPackages: string[];
  config: UsegraphConfig;
  onProgress?: ProgressFn;
  /** Max parallel file analyses (default: 8) */
  concurrency?: number;
}

export async function scanProject(opts: ScanOptions): Promise<ScanResult> {
  const { projectPath, targetPackages, config, onProgress, concurrency = 8 } = opts;
  const targetSet = new Set(targetPackages);

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

  // Analyse files with bounded concurrency
  const results: FileAnalysis[] = [];

  const queue = [...files];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length > 0) {
      const file = queue.shift()!;
      const analysis = await analyzeFile(file, projectPath, targetSet);
      results.push(analysis);
      done++;
      onProgress?.(done, total, analysis.relativePath);
    }
  });

  await Promise.all(workers);

  const summary = buildSummary(results, targetPackages);
  const meta = analyzeProjectMeta(projectPath);

  return {
    id: randomUUID(),
    projectPath,
    projectName: basename(projectPath),
    scannedAt: new Date().toISOString(),
    targetPackages,
    fileCount: files.length,
    files: results,
    summary,
    meta,
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
