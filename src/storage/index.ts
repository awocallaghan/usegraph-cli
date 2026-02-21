export type { StorageBackend } from './backend';
export { FilesystemBackend, GLOBAL_STORE_ROOT } from './filesystem';

import { FilesystemBackend } from './filesystem';
import type { UsegraphConfig } from '../types';
import type { StorageBackend } from './backend';

/**
 * Factory function used by all commands.
 *
 * @param projectPath  Absolute path to the project being scanned/reported.
 * @param projectSlug  Stable identity key for this project (from computeProjectSlug).
 * @param opts         CLI options object (may contain `output` override).
 * @param config       Resolved usegraph config (may contain `outputDir`).
 */
export function createStorageBackend(
  projectPath: string,
  projectSlug: string,
  opts: { output?: string },
  config: UsegraphConfig,
): StorageBackend {
  const dir = FilesystemBackend.resolveDir(projectPath, projectSlug, opts.output, config);
  return new FilesystemBackend(dir);
}
