/**
 * Compute a stable, human-readable slug that uniquely identifies a project
 * across machines and directories.
 *
 * Fallback chain:
 *   1. Git remote URL + relative subpath (monorepo support)
 *   2. package.json "name" field
 *   3. basename(projectPath)
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, join, relative } from 'path';

/**
 * Parse an HTTPS or SSH git remote URL into a canonical `host/org/repo` string.
 * Returns null for unrecognised formats.
 *
 * Examples:
 *   https://github.com/org/repo.git   → github.com/org/repo
 *   git@github.com:org/repo.git       → github.com/org/repo
 *   ssh://git@github.com/org/repo.git → github.com/org/repo
 */
export function parseRemoteUrl(url: string): string | null {
  url = url.trim();

  // HTTPS: https://host/org/repo[.git]
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  // SSH protocol: ssh://git@host/org/repo[.git]
  const sshProtoMatch = url.match(/^ssh:\/\/[^@]*@?([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshProtoMatch) {
    return `${sshProtoMatch[1]}/${sshProtoMatch[2]}`;
  }

  // SCP-style SSH: git@host:org/repo[.git]
  const scpMatch = url.match(/^[^@]*@([^:]+):(.+?)(?:\.git)?$/);
  if (scpMatch) {
    return `${scpMatch[1]}/${scpMatch[2]}`;
  }

  return null;
}

/**
 * Derive a stable slug from the git remote URL and, when in a monorepo
 * subdirectory, the relative path from the repo root.
 * Returns null if git is unavailable or no remote is configured.
 */
function slugFromGit(projectPath: string): string | null {
  // Get the remote URL
  const remoteResult = spawnSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
  });
  if (remoteResult.error || remoteResult.status !== 0) return null;

  const parsed = parseRemoteUrl(remoteResult.stdout);
  if (!parsed) return null;

  // Get the repo root to detect monorepo subpaths
  const rootResult = spawnSync('git', ['-C', projectPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  if (rootResult.error || rootResult.status !== 0) return parsed;

  const gitRoot = rootResult.stdout.trim();
  const subPath = relative(gitRoot, projectPath).replace(/\\/g, '/');

  return subPath ? `${parsed}/${subPath}` : parsed;
}

/**
 * Derive a slug from the "name" field in package.json.
 * Returns null if the file is missing, unparseable, or the name is empty.
 */
function slugFromPackageJson(projectPath: string): string | null {
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const name = pkg.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    // Malformed JSON — fall through
  }
  return null;
}

/**
 * Return a stable slug string that identifies this project.
 *
 * Priority:
 *   1. git remote + subpath  → e.g. "github.com/myorg/myapp"
 *   2. package.json name     → e.g. "my-package" or "@scope/pkg"
 *   3. basename              → e.g. "awocallaghan-nextjs"
 */
export function computeProjectSlug(projectPath: string): string {
  return (
    slugFromGit(projectPath) ??
    slugFromPackageJson(projectPath) ??
    basename(projectPath)
  );
}
