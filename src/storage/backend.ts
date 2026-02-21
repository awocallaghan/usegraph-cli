import type { ScanResult } from '../types';

/**
 * Abstraction over the storage backend.
 * All scan persistence operations go through this interface, keeping the
 * command layer decoupled from the underlying storage mechanism.
 *
 * The current default implementation is FilesystemBackend (local disk).
 * Future implementations could target S3, HTTP endpoints, etc.
 */
export interface StorageBackend {
  /** Persist a scan result (also updates the "latest" pointer). */
  save(result: ScanResult): void;
  /** Load the most recent scan, or null if none exists. */
  loadLatest(): ScanResult | null;
  /** Load a specific scan by UUID, or null if not found. */
  load(scanId: string): ScanResult | null;
  /** List all saved scan UUIDs, newest first. */
  list(): string[];
  /**
   * Return a filesystem path suitable for the SWC incremental file cache.
   * Returns undefined for backends that don't support local caching (e.g. S3).
   */
  getCacheDir(): string | undefined;
}
