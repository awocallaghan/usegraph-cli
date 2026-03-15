/**
 * Python lockfile / manifest parsers.
 *
 * Five parsers that convert Python dependency manifests to DependencyEntry[]:
 *   - PoetryLockfileParser   — poetry.lock (line-by-line state machine)
 *   - PdmLockfileParser      — pdm.lock (same structure as Poetry)
 *   - PipenvLockfileParser   — Pipfile.lock (JSON)
 *   - RequirementsTxtParser  — requirements.txt (line-by-line)
 *   - PyprojectTomlParser    — pyproject.toml (smol-toml, PEP 621 + Poetry)
 */
import { parse as parseToml } from 'smol-toml';
import { parseSemver } from './lockfile.js';
import type { DependencyEntry } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the extras suffix from a Python package name.
 * e.g. "celery[redis]" → "celery", "fastapi[all]" → "fastapi"
 */
function stripExtras(name: string): string {
  const bracket = name.indexOf('[');
  return bracket === -1 ? name : name.slice(0, bracket);
}

/**
 * Strip environment markers from a PEP 508 requirement string.
 * e.g. 'requests>=2.0 ; python_version >= "3.8"' → 'requests>=2.0'
 */
function stripEnvMarkers(spec: string): string {
  const semi = spec.indexOf(';');
  return semi === -1 ? spec : spec.slice(0, semi);
}

/**
 * Build a DependencyEntry for a Python package.
 * `versionRange` is the specifier string (e.g. "^0.115", ">=3.0", "==3.1.0").
 * `versionResolved` is the exact installed version (or null for ranges/VCS).
 */
function makeEntry(
  name: string,
  versionRange: string,
  section: DependencyEntry['section'],
  versionResolved: string | null,
): DependencyEntry {
  const semver = versionResolved ? parseSemver(versionResolved) : {
    versionMajor: null,
    versionMinor: null,
    versionPatch: null,
    versionPrerelease: null,
    versionIsPrerelease: null,
  };
  return {
    name: stripExtras(name.trim()),
    versionRange,
    section,
    versionResolved,
    versionMajor: semver.versionMajor,
    versionMinor: semver.versionMinor,
    versionPatch: semver.versionPatch,
    versionPrerelease: semver.versionPrerelease,
    versionIsPrerelease: semver.versionIsPrerelease,
    language: 'python',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PoetryLockfileParser — poetry.lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses `poetry.lock` into a map of package name → resolved version.
 *
 * The Poetry lock format uses `[[package]]` blocks separated by blank lines:
 *   [[package]]
 *   name = "fastapi"
 *   version = "0.115.0"
 *   ...
 *
 * We use a simple line-by-line state machine (no TOML library needed since the
 * format is very regular). Returns a Map<name, version>.
 */
export class PoetryLockfileParser {
  parse(content: string): Map<string, string> {
    const result = new Map<string, string>();
    const lines = content.split('\n');

    let inPackage = false;
    let currentName: string | null = null;
    let currentVersion: string | null = null;

    const flush = (): void => {
      if (currentName && currentVersion) {
        if (!result.has(currentName)) {
          result.set(currentName, currentVersion);
        }
      }
      currentName = null;
      currentVersion = null;
    };

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === '[[package]]') {
        flush();
        inPackage = true;
        continue;
      }

      // A top-level section header (not [[package]]) ends the current block
      if (trimmed.startsWith('[') && !trimmed.startsWith('[[package]]')) {
        if (inPackage) flush();
        inPackage = false;
        continue;
      }

      if (!inPackage) continue;

      if (trimmed.startsWith('name = ')) {
        currentName = trimmed.slice('name = '.length).replace(/^["']|["']$/g, '');
      } else if (trimmed.startsWith('version = ')) {
        currentVersion = trimmed.slice('version = '.length).replace(/^["']|["']$/g, '');
      }
    }

    flush();
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PdmLockfileParser — pdm.lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses `pdm.lock`. PDM uses the same `[[package]]` structure as Poetry.
 */
export class PdmLockfileParser {
  parse(content: string): Map<string, string> {
    // Reuse the exact same state machine — same format
    return new PoetryLockfileParser().parse(content);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UvLockfileParser — uv.lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses `uv.lock`. uv uses the same `[[package]]` TOML structure as
 * Poetry/PDM, so we reuse the same state machine. The top-level `version = 4`
 * header and `source = { ... }` lines are ignored naturally. Sub-tables like
 * `[package.metadata]` terminate the current package block (start with `[`
 * but not `[[package]]`), so both packages on either side are parsed correctly.
 */
export class UvLockfileParser {
  parse(content: string): Map<string, string> {
    return new PoetryLockfileParser().parse(content);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PipenvLockfileParser — Pipfile.lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses `Pipfile.lock` (JSON format).
 *
 * Structure:
 *   {
 *     "_meta": { ... },
 *     "default": { "requests": { "version": "==2.28.0", ... }, ... },
 *     "develop": { "pytest": { "version": "==7.2.0", ... }, ... }
 *   }
 *
 * Returns DependencyEntry[]. Git/VCS deps have versionResolved = null.
 * Local/path deps (no version field) are skipped.
 */
export class PipenvLockfileParser {
  parse(content: string): DependencyEntry[] {
    const result: DependencyEntry[] = [];

    let lock: Record<string, unknown>;
    try {
      lock = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return result;
    }

    const sections: Array<{ key: string; section: DependencyEntry['section'] }> = [
      { key: 'default', section: 'dependencies' },
      { key: 'develop', section: 'devDependencies' },
    ];

    for (const { key, section } of sections) {
      const block = lock[key];
      if (!block || typeof block !== 'object') continue;

      for (const [pkgName, pkgInfo] of Object.entries(block as Record<string, unknown>)) {
        if (!pkgInfo || typeof pkgInfo !== 'object') continue;
        const info = pkgInfo as Record<string, unknown>;

        // Skip local/path deps (no version field)
        if (!('version' in info)) continue;

        const rawVersion = typeof info['version'] === 'string' ? info['version'] : null;
        if (!rawVersion) continue;

        // Check for git/VCS deps — they appear as version: "==" but with a
        // "git" or "ref" field, or sometimes version is absent entirely.
        const isGit = typeof info['git'] === 'string' || typeof info['ref'] === 'string';

        if (isGit) {
          result.push(makeEntry(pkgName, 'git', section, null));
          continue;
        }

        // Normal pinned version: strip '==' prefix
        const versionResolved = rawVersion.startsWith('==')
          ? rawVersion.slice(2)
          : rawVersion;

        result.push(makeEntry(pkgName, rawVersion, section, versionResolved));
      }
    }

    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RequirementsTxtParser — requirements.txt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses `requirements.txt` line by line.
 *
 * Skips:
 *   - Comment lines (`#`)
 *   - Constraint/include files (`-c`, `-r`)
 *   - Editable installs (`-e`)
 *   - VCS installs (`git+`, `svn+`, `hg+`, `bzr+`)
 *
 * For pinned `==` versions, sets versionResolved. For ranges (`>=`, `~=`, etc.),
 * versionResolved is null.
 */
export class RequirementsTxtParser {
  parse(content: string): DependencyEntry[] {
    const result: DependencyEntry[] = [];

    for (const rawLine of content.split('\n')) {
      // Strip inline comments and trim
      let line = rawLine.split('#')[0].trim();
      if (!line) continue;

      // Skip flags
      if (
        line.startsWith('-r ') ||
        line.startsWith('-r\t') ||
        line.startsWith('-c ') ||
        line.startsWith('-c\t') ||
        line.startsWith('-e ') ||
        line.startsWith('-e\t') ||
        line === '-r' || line === '-c' || line === '-e'
      ) continue;

      // Skip VCS installs
      if (
        line.startsWith('git+') ||
        line.startsWith('svn+') ||
        line.startsWith('hg+') ||
        line.startsWith('bzr+')
      ) continue;

      // Strip environment markers
      line = stripEnvMarkers(line).trim();
      if (!line) continue;

      // Parse package name and version specifier
      // Specifier separators: ==, >=, <=, !=, ~=, ===, >
      const match = line.match(/^([A-Za-z0-9_\-.\[\]]+)\s*([=><!~][=!]?.*)$/);
      if (!match) {
        // Line is just a package name (no specifier)
        const name = stripExtras(line.trim());
        if (name) result.push(makeEntry(name, '*', 'dependencies', null));
        continue;
      }

      const rawName = match[1];
      const specifier = match[2].trim();

      const name = stripExtras(rawName);
      if (!name) continue;

      let versionResolved: string | null = null;
      if (specifier.startsWith('==') && !specifier.includes(',')) {
        // Exact pin — use as resolved version
        versionResolved = specifier.slice(2).trim();
      }

      result.push(makeEntry(name, specifier, 'dependencies', versionResolved));
    }

    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PyprojectTomlParser — pyproject.toml
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses `pyproject.toml` for dependency declarations.
 *
 * Supports two formats:
 *   1. PEP 621: `[project].dependencies` (string array)
 *              `[project.optional-dependencies].<group>` (string arrays)
 *   2. Poetry:  `[tool.poetry.dependencies]` (table)
 *              `[tool.poetry.dev-dependencies]` (table)
 *              `[tool.poetry.group.<group>.dependencies]` (table)
 *
 * Returns DependencyEntry[]. The `python` key in Poetry tables is skipped.
 */
export class PyprojectTomlParser {
  parse(content: string): DependencyEntry[] {
    const result: DependencyEntry[] = [];

    let doc: Record<string, unknown>;
    try {
      doc = parseToml(content) as Record<string, unknown>;
    } catch {
      return result;
    }

    // ── PEP 621 ──────────────────────────────────────────────────────────────
    const project = doc['project'];
    if (project && typeof project === 'object') {
      const proj = project as Record<string, unknown>;

      // [project.dependencies] — array of PEP 508 strings
      if (Array.isArray(proj['dependencies'])) {
        for (const dep of proj['dependencies'] as string[]) {
          const entry = this._parsePep508String(dep, 'dependencies');
          if (entry) result.push(entry);
        }
      }

      // [project.optional-dependencies] — map of group → string[]
      const optDeps = proj['optional-dependencies'];
      if (optDeps && typeof optDeps === 'object') {
        for (const group of Object.values(optDeps as Record<string, string[]>)) {
          if (!Array.isArray(group)) continue;
          for (const dep of group) {
            const entry = this._parsePep508String(dep, 'optionalDependencies');
            if (entry) result.push(entry);
          }
        }
      }
    }

    // ── Poetry ───────────────────────────────────────────────────────────────
    const tool = doc['tool'];
    if (tool && typeof tool === 'object') {
      const toolObj = tool as Record<string, unknown>;
      const poetry = toolObj['poetry'];

      if (poetry && typeof poetry === 'object') {
        const poetryObj = poetry as Record<string, unknown>;

        // [tool.poetry.dependencies] — main deps (skip 'python')
        const mainDeps = poetryObj['dependencies'];
        if (mainDeps && typeof mainDeps === 'object') {
          for (const [name, spec] of Object.entries(mainDeps as Record<string, unknown>)) {
            if (name === 'python') continue;
            const entry = this._parsePoetrySpec(name, spec, 'dependencies');
            if (entry) result.push(entry);
          }
        }

        // [tool.poetry.dev-dependencies] (legacy Poetry 1.x)
        const devDeps = poetryObj['dev-dependencies'];
        if (devDeps && typeof devDeps === 'object') {
          for (const [name, spec] of Object.entries(devDeps as Record<string, unknown>)) {
            if (name === 'python') continue;
            const entry = this._parsePoetrySpec(name, spec, 'devDependencies');
            if (entry) result.push(entry);
          }
        }

        // [tool.poetry.group.<name>.dependencies] (Poetry 1.2+)
        const groups = poetryObj['group'];
        if (groups && typeof groups === 'object') {
          for (const [groupName, groupObj] of Object.entries(groups as Record<string, unknown>)) {
            if (!groupObj || typeof groupObj !== 'object') continue;
            const groupDeps = (groupObj as Record<string, unknown>)['dependencies'];
            if (!groupDeps || typeof groupDeps !== 'object') continue;

            // dev/test groups → devDependencies; others → optionalDependencies
            const section: DependencyEntry['section'] =
              groupName === 'dev' || groupName === 'test' || groupName === 'lint'
                ? 'devDependencies'
                : 'optionalDependencies';

            for (const [name, spec] of Object.entries(groupDeps as Record<string, unknown>)) {
              if (name === 'python') continue;
              const entry = this._parsePoetrySpec(name, spec, section);
              if (entry) result.push(entry);
            }
          }
        }
      }
    }

    // ── PEP 735 [dependency-groups] — used by uv ─────────────────────────────
    const depGroups = doc['dependency-groups'];
    if (depGroups && typeof depGroups === 'object') {
      for (const [groupName, groupItems] of Object.entries(depGroups as Record<string, unknown>)) {
        if (!Array.isArray(groupItems)) continue;
        const section: DependencyEntry['section'] =
          groupName === 'dev' || groupName === 'test' || groupName === 'lint'
            ? 'devDependencies'
            : 'optionalDependencies';
        for (const item of groupItems) {
          if (item === null || typeof item !== 'string') continue; // skip {include-group = ...}
          const entry = this._parsePep508String(item, section);
          if (entry) result.push(entry);
        }
      }
    }

    return result;
  }

  /**
   * Parse a PEP 508 dependency string.
   * e.g. "fastapi[all]>=0.115" → { name: "fastapi", versionRange: ">=0.115" }
   * e.g. "requests" → { name: "requests", versionRange: "*" }
   */
  private _parsePep508String(dep: string, section: DependencyEntry['section']): DependencyEntry | null {
    if (typeof dep !== 'string') return null;

    // Strip env markers
    let clean = stripEnvMarkers(dep).trim();
    if (!clean) return null;

    const match = clean.match(/^([A-Za-z0-9_\-.\[\]]+)\s*([=><!~][=!]?.+)?$/);
    if (!match) return null;

    const rawName = match[1];
    const specifier = (match[2] ?? '*').trim();
    const name = stripExtras(rawName);
    if (!name) return null;

    return makeEntry(name, specifier, section, null);
  }

  /**
   * Parse a Poetry dependency spec. Can be:
   *   - A version string: "^0.115"
   *   - An inline table: { version = "^0.115", optional = true }
   *   - "*" (any version)
   */
  private _parsePoetrySpec(
    name: string,
    spec: unknown,
    section: DependencyEntry['section'],
  ): DependencyEntry | null {
    let versionRange = '*';

    if (typeof spec === 'string') {
      versionRange = spec;
    } else if (spec && typeof spec === 'object') {
      const specObj = spec as Record<string, unknown>;
      if (typeof specObj['version'] === 'string') {
        versionRange = specObj['version'];
      }
      // Skip git/path deps (no version field in inline table)
      if (!specObj['version'] && (specObj['git'] || specObj['path'])) {
        return makeEntry(name, 'git', section, null);
      }
    }

    return makeEntry(name, versionRange, section, null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instances
// ─────────────────────────────────────────────────────────────────────────────

export const poetryLockfileParser = new PoetryLockfileParser();
export const pdmLockfileParser = new PdmLockfileParser();
export const uvLockfileParser = new UvLockfileParser();
export const pipenvLockfileParser = new PipenvLockfileParser();
export const requirementsTxtParser = new RequirementsTxtParser();
export const pyprojectTomlParser = new PyprojectTomlParser();
