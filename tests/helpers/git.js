/**
 * Git test helpers: initialise ephemeral git repos for test fixtures.
 *
 * Usage:
 *   import { initTestRepo, cleanupTestRepo } from './helpers/git.js';
 *
 *   // Single commit (all existing files)
 *   const [sha] = await initTestRepo(dir);
 *
 *   // Multiple commits
 *   const [sha1, sha2] = await initTestRepo(dir, [
 *     { message: 'initial commit' },
 *     { message: 'second commit', files: { 'src/extra.ts': 'export const x = 1;' } },
 *   ]);
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Run a git command in `cwd`, throwing if it fails.
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Initialise an ephemeral git repo in `dir` and create commits.
 *
 * @param {string} dir - Directory to initialise (must already exist with files).
 * @param {Array<{ message: string, files?: Record<string, string> }>} [commits]
 *   Commits to create. Defaults to a single "initial commit" that stages all files.
 * @returns {Promise<string[]>} Array of commit SHAs (one per commit).
 */
export async function initTestRepo(dir, commits) {
  const commitDefs = commits ?? [{ message: 'initial commit' }];

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);

  const shas = [];

  for (const { message, files } of commitDefs) {
    if (files) {
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = join(dir, filePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, 'utf-8');
      }
    }

    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', message, '--allow-empty']);

    const sha = git(dir, ['rev-parse', 'HEAD']);
    shas.push(sha);
  }

  return shas;
}

/**
 * Remove the `.git` directory from a project, restoring it to a plain directory.
 * Safe to call even if no `.git` exists.
 * @param {string} dir
 */
export function cleanupTestRepo(dir) {
  const gitDir = join(dir, '.git');
  if (existsSync(gitDir)) {
    rmSync(gitDir, { recursive: true, force: true });
  }
}
