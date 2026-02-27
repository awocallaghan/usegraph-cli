/**
 * Persist and retrieve ScanResult objects from disk.
 *
 * Layout inside a project's output directory (.usegraph by default):
 *   <outputDir>/
 *     scans/
 *       <scanId>.json    — full scan result
 *     latest.json        — symlink (or copy) to the most recent scan
 *     file-cache.json   — per-file mtime/size cache for incremental scans
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { copyFileSync } from 'fs';
import { join } from 'path';
import type { ScanResult, FileAnalysis } from './types.js';

/**
 * Save a scan result to disk. The scan is stored as `<outputDir>/scans/<result.id>.json`.
 *
 * When `result.id` is a commit SHA (set by scanProject when git is available),
 * calling save twice for the same commit will overwrite the previous result for
 * that commit — this is intentional and enables idempotent history scanning.
 */
export function saveScanResult(outputDir: string, result: ScanResult): string {
  const scansDir = join(outputDir, 'scans');
  mkdirSync(scansDir, { recursive: true });

  const fileName = `${result.id}.json`;
  const filePath = join(scansDir, fileName);
  writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');

  // Update latest.json
  const latestPath = join(outputDir, 'latest.json');
  copyFileSync(filePath, latestPath);

  return filePath;
}

export function loadLatestScanResult(outputDir: string): ScanResult | null {
  const latestPath = join(outputDir, 'latest.json');
  if (!existsSync(latestPath)) return null;
  try {
    return JSON.parse(readFileSync(latestPath, 'utf-8')) as ScanResult;
  } catch {
    return null;
  }
}

export function loadScanResult(outputDir: string, scanId: string): ScanResult | null {
  const filePath = join(outputDir, 'scans', `${scanId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as ScanResult;
  } catch {
    return null;
  }
}

/** List all saved scan IDs. Returns IDs in undefined order when IDs are commit SHAs. */
export function listScans(outputDir: string): string[] {
  const scansDir = join(outputDir, 'scans');
  if (!existsSync(scansDir)) return [];
  return readdirSync(scansDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .reverse();
}

/**
 * Check whether a scan for the given commit SHA already exists on disk.
 * Returns the SHA (which is also the scan ID) if found, null otherwise.
 * This allows callers to skip re-scanning a commit that was already scanned.
 */
export function getScanIdForCommit(outputDir: string, commitSha: string): string | null {
  const filePath = join(outputDir, 'scans', `${commitSha}.json`);
  return existsSync(filePath) ? commitSha : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// File-level incremental scan cache
// ─────────────────────────────────────────────────────────────────────────────

// Increment when extractor output shape changes to force full re-analysis
const CACHE_VERSION = 2;
const CACHE_FILENAME = 'file-cache.json';

/** One cached entry per source file */
export interface FileCacheEntry {
  /** File modification time in milliseconds (from fs.stat.mtimeMs) */
  mtime: number;
  /** File size in bytes (from fs.stat.size) */
  size: number;
  /** Previously computed analysis for this file */
  analysis: FileAnalysis;
}

/**
 * On-disk structure for the file-level cache.
 * The cache is invalidated wholesale when the version or target packages change.
 */
export interface FileCache {
  version: typeof CACHE_VERSION;
  /** Sorted target packages — changing these invalidates all entries */
  targetPackages: string[];
  /** Map from absolute file path -> cached entry */
  entries: Record<string, FileCacheEntry>;
}

/** Load (or create a blank) file cache from outputDir. */
export function loadFileCache(outputDir: string, targetPackages: string[]): FileCache {
  const blank = (): FileCache => ({
    version: CACHE_VERSION,
    targetPackages: [...targetPackages].sort(),
    entries: {},
  });

  const cachePath = join(outputDir, CACHE_FILENAME);
  if (!existsSync(cachePath)) return blank();

  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as FileCache;
    if (raw.version !== CACHE_VERSION) return blank();
    // Invalidate if the set of tracked packages changed
    const sortedNew = [...targetPackages].sort().join('\0');
    const sortedOld = [...(raw.targetPackages ?? [])].sort().join('\0');
    if (sortedNew !== sortedOld) return blank();
    return raw;
  } catch {
    return blank();
  }
}

/** Persist the file cache to outputDir. */
export function saveFileCache(outputDir: string, cache: FileCache): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, CACHE_FILENAME), JSON.stringify(cache), 'utf-8');
}

/**
 * Load results from multiple project directories.
 * Used by the dashboard to aggregate cross-project data.
 */
export function loadAllProjectResults(
  projectDirs: Array<{ projectPath: string; outputDir: string }>,
): ScanResult[] {
  const results: ScanResult[] = [];
  for (const { projectPath: _p, outputDir } of projectDirs) {
    const result = loadLatestScanResult(outputDir);
    if (result) results.push(result);
  }
  return results;
}
