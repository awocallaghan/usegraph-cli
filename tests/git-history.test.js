/**
 * Unit tests for src/git-history.ts helpers.
 *
 * All functions under test are pure / injected-dependency, so no git or
 * filesystem access is required.
 *
 * Run: node --test tests/git-history.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  parsePeriod,
  resolveDate,
  getCommitsInRange,
  selectCheckpointCommits,
} = await import('../dist/git-history.js');

// ── helpers ───────────────────────────────────────────────────────────────────

const DAY_MS   = 24 * 60 * 60 * 1000;
const WEEK_MS  = 7  * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS  = 365 * DAY_MS;

// ── parsePeriod ───────────────────────────────────────────────────────────────

describe('parsePeriod', () => {
  test('1y → relative, 365 days in ms', () => {
    const p = parsePeriod('1y');
    assert.equal(p.type, 'relative');
    assert.equal(p.ms, YEAR_MS);
  });

  test('6m → relative, 180 days in ms', () => {
    const p = parsePeriod('6m');
    assert.equal(p.type, 'relative');
    assert.equal(p.ms, 6 * MONTH_MS);
  });

  test('2w → relative, 14 days in ms', () => {
    const p = parsePeriod('2w');
    assert.equal(p.type, 'relative');
    assert.equal(p.ms, 2 * WEEK_MS);
  });

  test('30d → relative, 30 days in ms', () => {
    const p = parsePeriod('30d');
    assert.equal(p.type, 'relative');
    assert.equal(p.ms, 30 * DAY_MS);
  });

  test('case-insensitive: 1Y, 6M, 2W, 30D', () => {
    assert.equal(parsePeriod('1Y').ms, YEAR_MS);
    assert.equal(parsePeriod('6M').ms, 6 * MONTH_MS);
    assert.equal(parsePeriod('2W').ms, 2 * WEEK_MS);
    assert.equal(parsePeriod('30D').ms, 30 * DAY_MS);
  });

  test('2024-01-01 → absolute date', () => {
    const p = parsePeriod('2024-01-01');
    assert.equal(p.type, 'absolute');
    assert.equal(p.date.getFullYear(), 2024);
    assert.equal(p.date.getMonth(), 0); // January
    assert.equal(p.date.getDate(), 1);
  });

  test('ISO datetime string → absolute date', () => {
    const p = parsePeriod('2024-06-15T12:00:00Z');
    assert.equal(p.type, 'absolute');
    assert.equal(p.date.toISOString().startsWith('2024-06-15'), true);
  });

  test('garbage → throws user-friendly error', () => {
    assert.throws(() => parsePeriod('garbage'), /Invalid period/);
  });

  test('empty string → throws', () => {
    assert.throws(() => parsePeriod(''), /Invalid period/);
  });

  test('negative number → not matched (not a valid period)', () => {
    // "-1y" doesn't match the regex, so it falls through to Date parsing which gives NaN
    assert.throws(() => parsePeriod('-1y'), /Invalid period/);
  });
});

// ── resolveDate ───────────────────────────────────────────────────────────────

describe('resolveDate', () => {
  const NOW = new Date('2024-07-01T00:00:00.000Z');

  test('relative 30d → 30 days before now', () => {
    const p = parsePeriod('30d');
    const d = resolveDate(p, NOW);
    const expected = new Date(NOW.getTime() - 30 * DAY_MS);
    assert.equal(d.getTime(), expected.getTime());
  });

  test('relative 1y → 365 days before now', () => {
    const p = parsePeriod('1y');
    const d = resolveDate(p, NOW);
    const expected = new Date(NOW.getTime() - YEAR_MS);
    assert.equal(d.getTime(), expected.getTime());
  });

  test('absolute → returns the fixed date regardless of now', () => {
    const p = parsePeriod('2023-01-15');
    const d = resolveDate(p, NOW);
    assert.equal(d.getFullYear(), 2023);
    assert.equal(d.getMonth(), 0);
    assert.equal(d.getDate(), 15);
  });

  test('defaults now to current time when omitted', () => {
    const before = Date.now();
    const d = resolveDate(parsePeriod('1d'));
    const after = Date.now();
    assert.ok(d.getTime() >= before - DAY_MS - 1000);
    assert.ok(d.getTime() <= after - DAY_MS + 1000);
  });
});

// ── getCommitsInRange ─────────────────────────────────────────────────────────

describe('getCommitsInRange', () => {
  // Build a git stub that returns a fixed log string
  function makeGitStub(output) {
    return (_cwd, _args) => output;
  }

  const SINCE = new Date('2024-01-01T00:00:00Z');
  const UNTIL = new Date('2024-06-30T23:59:59Z');

  test('returns CommitEntry array from git output', () => {
    const log = [
      'abc1234 2024-06-15T10:00:00+00:00',
      'def5678 2024-03-10T08:30:00+00:00',
      '9999aaa 2024-01-20T15:45:00+00:00',
    ].join('\n');

    const entries = getCommitsInRange('/fake', SINCE, UNTIL, makeGitStub(log));
    assert.equal(entries.length, 3);
    assert.equal(entries[0].sha, 'abc1234');
    assert.equal(entries[0].date, '2024-06-15T10:00:00+00:00');
    assert.ok(entries[0].epochMs > 0);
  });

  test('returns [] when git returns null (non-git dir)', () => {
    const entries = getCommitsInRange('/fake', SINCE, UNTIL, makeGitStub(null));
    assert.deepEqual(entries, []);
  });

  test('returns [] when output is empty string', () => {
    const entries = getCommitsInRange('/fake', SINCE, UNTIL, makeGitStub(''));
    assert.deepEqual(entries, []);
  });

  test('skips malformed lines gracefully', () => {
    const log = [
      'abc1234 2024-06-15T10:00:00+00:00',
      'notavalidline',
      '',
      'def5678 2024-03-10T08:30:00+00:00',
    ].join('\n');

    const entries = getCommitsInRange('/fake', SINCE, UNTIL, makeGitStub(log));
    assert.equal(entries.length, 2);
  });

  test('passes --after with sinceDate - 1 second to make it inclusive', () => {
    let capturedArgs;
    const stub = (_cwd, args) => { capturedArgs = args; return null; };
    getCommitsInRange('/fake', SINCE, UNTIL, stub);

    const afterArg = capturedArgs.find(a => a.startsWith('--after='));
    assert.ok(afterArg, '--after argument should be present');
    const afterDate = new Date(afterArg.replace('--after=', ''));
    assert.equal(afterDate.getTime(), SINCE.getTime() - 1000);
  });
});

// ── selectCheckpointCommits ───────────────────────────────────────────────────

describe('selectCheckpointCommits', () => {
  const MONTH_MS = 30 * DAY_MS;

  function makeCommit(sha, isoDate) {
    return { sha, date: isoDate, epochMs: new Date(isoDate).getTime() };
  }

  // 6 commits, one per month starting from Jan 2024
  const monthlyCommits = [
    makeCommit('sha6', '2024-06-15T00:00:00Z'),
    makeCommit('sha5', '2024-05-15T00:00:00Z'),
    makeCommit('sha4', '2024-04-15T00:00:00Z'),
    makeCommit('sha3', '2024-03-15T00:00:00Z'),
    makeCommit('sha2', '2024-02-15T00:00:00Z'),
    makeCommit('sha1', '2024-01-15T00:00:00Z'),
  ];

  const sinceMs = new Date('2024-01-01T00:00:00Z').getTime();
  const untilMs = new Date('2024-06-30T00:00:00Z').getTime();

  test('one commit per month → 6 entries returned', () => {
    const result = selectCheckpointCommits(monthlyCommits, sinceMs, untilMs, MONTH_MS);
    assert.equal(result.length, 6);
  });

  test('returns newest-first', () => {
    const result = selectCheckpointCommits(monthlyCommits, sinceMs, untilMs, MONTH_MS);
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i - 1].epochMs >= result[i].epochMs,
        `result[${i-1}] should be newer than result[${i}]`);
    }
  });

  test('picks the latest commit when multiple fall in same bucket', () => {
    // Both dates must be in the same epoch-aligned 30-day bucket.
    // Bucket 657 spans roughly Dec 22 2023 – Jan 21 2024:
    //   floor(epochMs / 30d) == 657 for both 2024-01-05 and 2024-01-10.
    const commits = [
      makeCommit('later',  '2024-01-10T00:00:00Z'),
      makeCommit('earlier','2024-01-05T00:00:00Z'),
    ];
    // Verify both are in the same bucket before asserting
    const bucket = (isoDate) => Math.floor(new Date(isoDate).getTime() / MONTH_MS);
    assert.equal(bucket('2024-01-10T00:00:00Z'), bucket('2024-01-05T00:00:00Z'),
      'Test setup: both commits must be in the same epoch-aligned bucket');

    const result = selectCheckpointCommits(commits, sinceMs, untilMs, MONTH_MS);
    assert.equal(result.length, 1);
    assert.equal(result[0].sha, 'later');
  });

  test('gap month → fewer than 6 entries', () => {
    // Remove February's commit
    const withGap = monthlyCommits.filter(c => !c.date.startsWith('2024-02'));
    const result = selectCheckpointCommits(withGap, sinceMs, untilMs, MONTH_MS);
    assert.equal(result.length, 5);
  });

  test('empty input → empty output', () => {
    const result = selectCheckpointCommits([], sinceMs, untilMs, MONTH_MS);
    assert.deepEqual(result, []);
  });

  test('single commit → single entry', () => {
    const result = selectCheckpointCommits(
      [makeCommit('only', '2024-03-15T00:00:00Z')],
      sinceMs, untilMs, MONTH_MS,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].sha, 'only');
  });

  test('buckets are stable across re-runs (deterministic)', () => {
    const result1 = selectCheckpointCommits(monthlyCommits, sinceMs, untilMs, MONTH_MS);
    const result2 = selectCheckpointCommits([...monthlyCommits].reverse(), sinceMs, untilMs, MONTH_MS);
    assert.deepEqual(
      result1.map(c => c.sha).sort(),
      result2.map(c => c.sha).sort(),
      'Same commits should be selected regardless of input order',
    );
  });
});
