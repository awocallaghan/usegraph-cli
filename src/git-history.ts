/**
 * Pure helpers for time-range and interval-based git history scanning.
 *
 * All functions are side-effect-free except getCommitsInRange, which runs
 * a git subprocess (injected as a parameter so it can be stubbed in tests).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ParsedPeriod =
  | { type: 'relative'; ms: number }
  | { type: 'absolute'; date: Date };

export interface CommitEntry {
  sha: string;
  date: string;   // ISO 8601
  epochMs: number;
}

// ── parsePeriod ───────────────────────────────────────────────────────────────

const RELATIVE_RE = /^(\d+)(y|m|w|d)$/i;

/**
 * Parse a period string into a ParsedPeriod.
 *
 * Relative formats: 1y, 6m, 2w, 30d (case-insensitive)
 *   y = 365 days, m = 30 days, w = 7 days, d = 1 day
 *
 * Absolute formats: any ISO date string accepted by `new Date()`, e.g. 2024-01-01
 */
export function parsePeriod(raw: string): ParsedPeriod {
  const rel = RELATIVE_RE.exec(raw);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const daysMap: Record<string, number> = { y: 365, m: 30, w: 7, d: 1 };
    const ms = n * daysMap[unit] * 24 * 60 * 60 * 1000;
    return { type: 'relative', ms };
  }

  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return { type: 'absolute', date: d };
  }

  throw new Error(
    `Invalid period "${raw}". Use a relative format like 1y, 6m, 2w, 30d, ` +
    `or an absolute ISO date like 2024-01-01.`,
  );
}

// ── resolveDate ───────────────────────────────────────────────────────────────

/**
 * Resolve a ParsedPeriod to a concrete Date.
 *
 * Relative periods are subtracted from `now` (defaults to current time).
 * Absolute periods return their fixed date directly.
 */
export function resolveDate(period: ParsedPeriod, now: Date = new Date()): Date {
  if (period.type === 'relative') {
    return new Date(now.getTime() - period.ms);
  }
  return period.date;
}

// ── getCommitsInRange ─────────────────────────────────────────────────────────

/** Signature of a synchronous git runner (matches spawnSync-based helpers). */
export type GitRawFn = (cwd: string, args: string[]) => string | null;

/**
 * Return all commits in [sinceDate, untilDate] (both inclusive), newest first.
 *
 * Returns [] when the directory is not a git repo, git is not installed, or
 * the range contains no commits.
 */
export function getCommitsInRange(
  projectPath: string,
  sinceDate: Date,
  untilDate: Date,
  gitRaw: GitRawFn,
): CommitEntry[] {
  // git --after is exclusive, so subtract 1 second to make sinceDate inclusive
  const afterDate = new Date(sinceDate.getTime() - 1000);

  const output = gitRaw(projectPath, [
    'log',
    `--after=${afterDate.toISOString()}`,
    `--before=${untilDate.toISOString()}`,
    '--format=%H %cI',
  ]);

  if (!output) return [];

  const entries: CommitEntry[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;
    const sha = trimmed.slice(0, spaceIdx);
    const date = trimmed.slice(spaceIdx + 1).trim();
    const epochMs = new Date(date).getTime();
    if (isNaN(epochMs)) continue;
    entries.push({ sha, date, epochMs });
  }

  return entries; // git log already returns newest-first
}

// ── getCommitAtOrBefore ───────────────────────────────────────────────────────

/**
 * Return the latest commit at or before `date`, or null if none exists.
 *
 * Used to find a "baseline" commit for the start of a `--since` scan window:
 * if a project was last changed before the `--since` boundary, this gives us
 * the commit that represents the project state at that boundary, even though
 * the commit itself is older.  The caller is responsible for overriding
 * `codeAt` to `date` on the resulting scan so data shows the correct period.
 */
export function getCommitAtOrBefore(
  projectPath: string,
  date: Date,
  gitRaw: GitRawFn,
): CommitEntry | null {
  // git --before is exclusive, so add 1 second to make `date` inclusive
  const beforeDate = new Date(date.getTime() + 1000);

  const output = gitRaw(projectPath, [
    'log',
    `--before=${beforeDate.toISOString()}`,
    '-n', '1',
    '--format=%H %cI',
  ]);

  if (!output) return null;

  const trimmed = output.trim();
  if (!trimmed) return null;

  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return null;

  const sha = trimmed.slice(0, spaceIdx);
  const commitDate = trimmed.slice(spaceIdx + 1).trim();
  const epochMs = new Date(commitDate).getTime();
  if (isNaN(epochMs)) return null;

  return { sha, date: commitDate, epochMs };
}

// ── selectCheckpointCommits ───────────────────────────────────────────────────

/**
 * Downsample a list of commits to at most one per interval bucket.
 *
 * Buckets are aligned to the UTC epoch (bucketIndex = floor(epochMs / intervalMs)),
 * so results are stable across re-runs with the same inputs.
 *
 * For each non-empty bucket, the **latest** commit is kept (best represents the
 * state at the end of that interval). Empty buckets are silently skipped.
 *
 * Returns newest-first, consistent with --history display order.
 */
export function selectCheckpointCommits(
  commits: CommitEntry[],
  _sinceMs: number,
  _untilMs: number,
  intervalMs: number,
): CommitEntry[] {
  const buckets = new Map<number, CommitEntry>();

  for (const commit of commits) {
    const bucketIndex = Math.floor(commit.epochMs / intervalMs);
    const existing = buckets.get(bucketIndex);
    // Keep the latest commit in each bucket (highest epochMs)
    if (!existing || commit.epochMs > existing.epochMs) {
      buckets.set(bucketIndex, commit);
    }
  }

  // Sort newest-first
  return Array.from(buckets.values()).sort((a, b) => b.epochMs - a.epochMs);
}
