/**
 * Git test helpers: initialise ephemeral git repos for test fixtures.
 *
 * Usage:
 *   import { initTestRepo, initHistoricalRepo, cleanupTestRepo } from './helpers/git.js';
 *
 *   // Single commit (all existing files)
 *   const [sha] = await initTestRepo(dir);
 *
 *   // Multiple commits (with optional per-commit dates)
 *   const [sha1, sha2] = await initTestRepo(dir, [
 *     { message: 'initial commit', date: '2024-09-01T10:00:00Z' },
 *     { message: 'second commit', files: { 'src/extra.ts': 'export const x = 1;' } },
 *   ]);
 *
 *   // Full historical repo built from scratch (file contents defined per commit)
 *   const shas = await initHistoricalRepo(workDir, [
 *     { date: '2024-09-01T10:00:00Z', message: 'initial setup', files: { 'package.json': '...' } },
 *     { date: '2024-10-01T10:00:00Z', message: 'add feature',   files: { 'src/App.tsx': '...' } },
 *   ], { remote: 'https://github.com/org/repo.git' });
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
 * Run a git command in `cwd` with extra environment variables.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} extraEnv
 */
function gitWithEnv(cwd, args, extraEnv) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...extraEnv },
  });
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
 * @param {Array<{ message: string, files?: Record<string, string>, date?: string }>} [commits]
 *   Commits to create. Defaults to a single "initial commit" that stages all files.
 *   `date` is an ISO string used for both GIT_AUTHOR_DATE and GIT_COMMITTER_DATE.
 * @param {{ remote?: string }} [options]
 *   Optional settings. `remote` sets the `origin` remote URL (e.g. a fake GitHub URL).
 * @returns {Promise<string[]>} Array of commit SHAs (one per commit).
 */
export async function initTestRepo(dir, commits, options) {
  const commitDefs = commits ?? [{ message: 'initial commit' }];

  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);

  if (options?.remote) {
    git(dir, ['remote', 'add', 'origin', options.remote]);
  }

  const shas = [];

  for (const { message, files, date } of commitDefs) {
    if (files) {
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = join(dir, filePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, 'utf-8');
      }
    }

    git(dir, ['add', '.']);

    const dateEnv = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
    gitWithEnv(dir, ['commit', '-m', message, '--allow-empty'], dateEnv);

    const sha = git(dir, ['rev-parse', 'HEAD']);
    shas.push(sha);
  }

  return shas;
}

/**
 * Build a git repo from scratch in `dir` by applying a sequence of commit snapshots.
 *
 * Each commit's `files` map is applied on top of accumulated state: new files are
 * written, and paths mapped to `null` are deleted. Files not mentioned carry forward
 * from the previous commit. The first commit should list all initial files.
 *
 * `dir` must already exist. Any pre-existing files in `dir` are left as-is before
 * the first commit (they won't be staged unless listed in the first commit's `files`).
 *
 * @param {string} dir
 * @param {Array<{ date: string, message: string, files: Record<string, string|null> }>} commits
 * @param {{ remote?: string }} [options]
 * @returns {Promise<string[]>} Array of commit SHAs (one per commit).
 */
export async function initHistoricalRepo(dir, commits, options) {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);

  if (options?.remote) {
    git(dir, ['remote', 'add', 'origin', options.remote]);
  }

  const shas = [];

  for (const { date, message, files } of commits) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(dir, filePath);
      if (content === null) {
        if (existsSync(fullPath)) unlinkSync(fullPath);
      } else {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, 'utf-8');
      }
    }

    git(dir, ['add', '-A']);
    gitWithEnv(dir, ['commit', '-m', message, '--allow-empty'], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });

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
