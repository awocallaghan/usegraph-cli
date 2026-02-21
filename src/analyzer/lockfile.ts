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
// pnpm — pnpm-lock.yaml (v5, v6, v7, v8, v9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parser for pnpm's `pnpm-lock.yaml`.
 *
 * Supports all lockfile format versions without requiring a YAML library:
 *  - v5 (pnpm 6) single-package: top-level `dependencies:` / `devDependencies:`
 *    with direct `name: version` values
 *  - v5 (pnpm 6) monorepo: `importers["."].dependencies` with direct version values
 *  - v6+ (pnpm 7/8/9): `importers["."].dependencies.<name>.version` (nested object)
 *
 * Peer-dependency suffixes in version strings are stripped:
 *  e.g. "18.2.0(@types/react@18)(react@18)" → "18.2.0"
 */
export class PnpmLockfileParser implements LockfileParser {
  parse(lockfileContent: string): Map<string, ResolvedDependency> {
    const result = new Map<string, ResolvedDependency>();
    if (!lockfileContent.trim()) return result;

    try {
      const lines = lockfileContent.split('\n');
      const hasImporters = lines.some(l => l.trim() === 'importers:');
      if (hasImporters) {
        this._parseImporters(lines, result);
      } else {
        this._parseTopLevel(lines, result);
      }
    } catch {
      // swallow unexpected parse errors; return what we have so far
    }

    return result;
  }

  /**
   * Parse deps from the `importers['.']` block.
   * Used for monorepo v5 and all v6+ lockfiles.
   *
   * State machine phases:
   *  0 — looking for `importers:`
   *  1 — inside importers, looking for the root `.:` entry
   *  2 — inside `.`, looking for `dependencies:` / `devDependencies:` at indent 4
   *  3 — inside a deps section, collecting package entries
   */
  private _parseImporters(
    lines: string[],
    result: Map<string, ResolvedDependency>,
  ): void {
    let phase = 0;
    let inDeps = false;
    let currentPkg: string | null = null;

    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const ind = countIndent(line);

      if (phase === 0) {
        if (ind === 0 && t === 'importers:') phase = 1;
      } else if (phase === 1) {
        if (ind === 0) { phase = 0; continue; }
        if (ind === 2) {
          const key = t.endsWith(':') ? t.slice(0, -1).replace(/^['"]|['"]$/g, '') : null;
          if (key === '.') phase = 2;
        }
      } else if (phase === 2) {
        if (ind <= 2) { phase = 1; continue; }
        if (ind === 4) {
          currentPkg = null;
          inDeps = t === 'dependencies:' || t === 'devDependencies:';
          phase = 3;
        }
      } else {
        // phase === 3
        if (ind <= 2) break; // done with '.' block
        if (ind === 4) {
          currentPkg = null;
          inDeps = t === 'dependencies:' || t === 'devDependencies:';
          continue;
        }
        if (!inDeps) continue;

        if (ind === 6) {
          const colonIdx = t.indexOf(':');
          if (colonIdx === -1) continue;
          const rawName = t.slice(0, colonIdx).replace(/^['"]|['"]$/g, '');
          const valueAfterColon = t.slice(colonIdx + 1).trim();

          if (valueAfterColon) {
            // v5 monorepo style: name: version (direct value)
            const version = stripPeerSuffix(valueAfterColon);
            if (rawName && version && !result.has(rawName)) {
              result.set(rawName, makeResolved(rawName, version));
            }
            currentPkg = null;
          } else {
            // v6+ style: name: (nested object follows)
            currentPkg = rawName || null;
          }
          continue;
        }

        if (ind === 8 && currentPkg) {
          if (t.startsWith('version:')) {
            const version = stripPeerSuffix(t.slice('version:'.length).trim());
            if (version && !result.has(currentPkg)) {
              result.set(currentPkg, makeResolved(currentPkg, version));
            }
            currentPkg = null;
          } else if (!t.startsWith('specifier:')) {
            currentPkg = null; // unexpected nested field — reset
          }
          continue;
        }

        // Any other indentation while in deps — clear current package context
        if (ind !== 6 && ind !== 8) currentPkg = null;
      }
    }
  }

  /**
   * Parse deps from top-level `dependencies:` / `devDependencies:` sections.
   * Used for pnpm v5 single-package repos (no `importers:` block).
   */
  private _parseTopLevel(
    lines: string[],
    result: Map<string, ResolvedDependency>,
  ): void {
    let inDeps = false;

    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const ind = countIndent(line);

      if (ind === 0) {
        inDeps = t === 'dependencies:' || t === 'devDependencies:';
        continue;
      }

      if (!inDeps || ind !== 2) continue;

      const colonIdx = t.indexOf(':');
      if (colonIdx === -1) continue;
      const name = t.slice(0, colonIdx).replace(/^['"]|['"]$/g, '');
      const version = stripPeerSuffix(t.slice(colonIdx + 1).trim());
      if (name && version && !result.has(name)) {
        result.set(name, makeResolved(name, version));
      }
    }
  }
}

/** Strip pnpm peer-dependency suffix from a version string.
 *  e.g. "18.2.0(react@18.2.0)(@types/react@18.0.28)" → "18.2.0" */
function stripPeerSuffix(version: string): string {
  const paren = version.indexOf('(');
  return paren === -1 ? version : version.slice(0, paren);
}

/** Count leading spaces on a line */
function countIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instances
// ─────────────────────────────────────────────────────────────────────────────

export const npmLockfileParser = new NpmLockfileParser();
export const pnpmLockfileParser = new PnpmLockfileParser();
