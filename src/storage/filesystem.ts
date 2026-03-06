import { join } from 'path';
import { homedir } from 'os';
import {
  saveScanResult,
  loadLatestScanResult,
  loadScanResult,
  listScans,
} from '../storage.js';
import type { ScanResult } from '../types.js';
import type { StorageBackend } from './backend.js';

/**
 * Root directory for the global cross-project store.
 * Override with the `USEGRAPH_HOME` environment variable (useful for testing).
 */
export const GLOBAL_STORE_ROOT = process.env.USEGRAPH_HOME ?? join(homedir(), '.usegraph');

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
   * Resolve the on-disk storage directory for a project.
   * Always uses the global store: ~/.usegraph/<slug-segments...>
   */
  static resolveDir(
    projectSlug: string,
  ): string {
    // Slug may contain '/' separators (e.g. "github.com/org/repo") — split so
    // each segment becomes its own directory level under GLOBAL_STORE_ROOT.
    return join(GLOBAL_STORE_ROOT, ...projectSlug.split('/'));
  }
}
