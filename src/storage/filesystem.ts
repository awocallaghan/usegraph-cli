import { join, resolve } from 'path';
import { homedir } from 'os';
import {
  saveScanResult,
  loadLatestScanResult,
  loadScanResult,
  listScans,
} from '../storage';
import type { ScanResult, UsegraphConfig } from '../types';
import type { StorageBackend } from './backend';

/** Root directory for the global cross-project store. */
export const GLOBAL_STORE_ROOT = join(homedir(), '.usegraph');

/**
 * Filesystem-based storage backend.
 * Delegates to the existing low-level helpers in storage.ts.
 */
export class FilesystemBackend implements StorageBackend {
  constructor(private readonly dir: string) {}

  save(result: ScanResult): void {
    saveScanResult(this.dir, result);
  }

  loadLatest(): ScanResult | null {
    return loadLatestScanResult(this.dir);
  }

  load(id: string): ScanResult | null {
    return loadScanResult(this.dir, id);
  }

  list(): string[] {
    return listScans(this.dir);
  }

  getCacheDir(): string {
    return this.dir;
  }

  /**
   * Resolve the on-disk storage directory from the available configuration.
   *
   * Priority:
   *   1. Explicit --output flag   → project-relative path
   *   2. config.outputDir (set)   → project-relative path
   *   3. Default                  → ~/.usegraph/<slug-segments...>
   */
  static resolveDir(
    projectPath: string,
    projectSlug: string,
    explicitOutput: string | undefined,
    config: UsegraphConfig,
  ): string {
    if (explicitOutput) return resolve(projectPath, explicitOutput);
    if (config.outputDir) return resolve(projectPath, config.outputDir);
    // Slug may contain '/' separators (e.g. "github.com/org/repo") — split so
    // each segment becomes its own directory level under GLOBAL_STORE_ROOT.
    return join(GLOBAL_STORE_ROOT, ...projectSlug.split('/'));
  }
}
