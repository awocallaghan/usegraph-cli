export type { StorageBackend } from './backend.js';
export { FilesystemBackend, GLOBAL_STORE_ROOT } from './filesystem.js';

import { FilesystemBackend } from './filesystem.js';
import type { StorageBackend } from './backend.js';

/**
 * Factory function used by all commands.
 *
 * @param projectSlug  Stable identity key for this project (from computeProjectSlug).
 */
export function createStorageBackend(
  projectSlug: string,
): StorageBackend {
  const dir = FilesystemBackend.resolveDir(projectSlug);
  return new FilesystemBackend(dir);
}
