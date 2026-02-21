/**
 * Lockfile parsers — resolve exact installed versions from various package
 * manager lockfiles.
 *
 * Each parser implements the `LockfileParser` interface and returns a
 * `Map<packageName, ResolvedDependency>`. Parsers are independent; Phase 2.2–2.4
 * will add pnpm and yarn implementations alongside this file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** Resolved version information for a single package */
export interface ResolvedDependency {
  name: string;
  /** Exact installed version string (e.g. "18.2.0" or "1.0.0-beta.3") */
  versionResolved: string;
  versionMajor: number;
  versionMinor: number;
  versionPatch: number;
  /** Prerelease label after the first `-` (e.g. "beta.3" or "acme-fork.3"); null for stable */
  versionPrerelease: string | null;
  /** True when versionPrerelease is non-null */
  versionIsPrerelease: boolean;
}

/** Common interface for all lockfile parsers */
export interface LockfileParser {
  /** Parse lockfile text and return a map of package name → resolved dependency */
  parse(lockfileContent: string): Map<string, ResolvedDependency>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semver helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a semver string into its numeric components.
 * Handles: "1.2.3", "1.2.3-beta.1", "1.2.3-acme-fork.3", "1.2.3-rc.1+build"
 * Returns zeroed values for unrecognised formats.
 */
export function parseSemver(
  version: string,
): Pick<
  ResolvedDependency,
  'versionMajor' | 'versionMinor' | 'versionPatch' | 'versionPrerelease' | 'versionIsPrerelease'
> {
  // Strip build metadata (after +) before matching
  const withoutBuild = version.split('+')[0];
  const match = withoutBuild.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) {
    return {
      versionMajor: 0,
      versionMinor: 0,
      versionPatch: 0,
      versionPrerelease: null,
      versionIsPrerelease: false,
    };
  }
  const prerelease = match[4] ?? null;
  return {
    versionMajor: parseInt(match[1], 10),
    versionMinor: parseInt(match[2], 10),
    versionPatch: parseInt(match[3], 10),
    versionPrerelease: prerelease,
    versionIsPrerelease: prerelease !== null,
  };
}

/** Build a full ResolvedDependency from a name and resolved version string */
function makeResolved(name: string, versionResolved: string): ResolvedDependency {
  return { name, versionResolved, ...parseSemver(versionResolved) };
}

// ─────────────────────────────────────────────────────────────────────────────
// npm — package-lock.json (v1, v2, v3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parser for npm's `package-lock.json`.
 *
 * Supports all three lockfileVersion values:
 *  - v1: reads `dependencies[name].version` (flat map at top level)
 *  - v2/v3: reads `packages["node_modules/<name>"].version`
 *    (only top-level entries; nested `a/node_modules/b` entries are skipped)
 *
 * For v1, nested `dependencies` blocks within a package entry are traversed
 * recursively, but the outermost occurrence of each package name wins.
 */
export class NpmLockfileParser implements LockfileParser {
  parse(lockfileContent: string): Map<string, ResolvedDependency> {
    const result = new Map<string, ResolvedDependency>();

    let lock: Record<string, unknown>;
    try {
      lock = JSON.parse(lockfileContent) as Record<string, unknown>;
    } catch {
      return result; // unparseable — return empty map
    }

    const lockfileVersion = typeof lock['lockfileVersion'] === 'number'
      ? lock['lockfileVersion']
      : 1; // missing = v1

    if (lockfileVersion >= 2) {
      this._parseV2(lock, result);
    } else {
      this._parseV1(lock, result);
    }

    return result;
  }

  /** v2/v3: iterate packages["node_modules/<name>"] entries */
  private _parseV2(
    lock: Record<string, unknown>,
    result: Map<string, ResolvedDependency>,
  ): void {
    const packages = lock['packages'];
    if (!packages || typeof packages !== 'object') return;

    for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
      const name = extractV2Name(key);
      if (!name) continue;
      if (result.has(name)) continue; // top-level entry already recorded

      const pkg = entry as Record<string, unknown>;
      const version = typeof pkg['version'] === 'string' ? pkg['version'] : null;
      if (!version) continue;

      result.set(name, makeResolved(name, version));
    }
  }

  /** v1: read top-level dependencies map, then recurse into nested blocks */
  private _parseV1(
    lock: Record<string, unknown>,
    result: Map<string, ResolvedDependency>,
  ): void {
    const deps = lock['dependencies'];
    if (!deps || typeof deps !== 'object') return;
    this._walkV1Deps(deps as Record<string, unknown>, result);
  }

  private _walkV1Deps(
    deps: Record<string, unknown>,
    result: Map<string, ResolvedDependency>,
  ): void {
    for (const [name, entry] of Object.entries(deps)) {
      const pkg = entry as Record<string, unknown>;
      const version = typeof pkg['version'] === 'string' ? pkg['version'] : null;

      // Record outermost (first seen) version; nested duplicates are skipped
      if (version && !result.has(name)) {
        result.set(name, makeResolved(name, version));
      }

      // Recurse into nested dependency blocks
      if (pkg['dependencies'] && typeof pkg['dependencies'] === 'object') {
        this._walkV1Deps(pkg['dependencies'] as Record<string, unknown>, result);
      }
    }
  }
}

/**
 * Extract the package name from a v2/v3 packages key.
 *
 * Rules:
 *  - Key must start with `node_modules/`
 *  - After stripping the prefix, name must not contain another `node_modules/`
 *    (those are nested, hoisted-under-a-different-package entries)
 *  - Empty name (root `""` entry) is skipped
 *
 * Examples:
 *  "node_modules/react"           → "react"
 *  "node_modules/@types/react"    → "@types/react"
 *  "node_modules/a/node_modules/b" → null  (nested dep — skip)
 *  ""                             → null  (root package)
 */
function extractV2Name(key: string): string | null {
  const PREFIX = 'node_modules/';
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  if (!rest) return null;
  if (rest.includes('/node_modules/')) return null; // nested hoisted dep
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instances
// ─────────────────────────────────────────────────────────────────────────────

export const npmLockfileParser = new NpmLockfileParser();
