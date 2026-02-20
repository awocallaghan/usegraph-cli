/**
 * Persist and retrieve ScanResult objects from disk.
 *
 * Layout inside a project's output directory (.usegraph by default):
 *   <outputDir>/
 *     scans/
 *       <scanId>.json    — full scan result
 *     latest.json        — symlink (or copy) to the most recent scan
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { copyFileSync } from 'fs';
import { join } from 'path';
import type { ScanResult } from './types';

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

/** List all saved scan IDs (newest first) */
export function listScans(outputDir: string): string[] {
  const scansDir = join(outputDir, 'scans');
  if (!existsSync(scansDir)) return [];
  return readdirSync(scansDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .reverse();
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
