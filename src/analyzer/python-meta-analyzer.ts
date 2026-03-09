/**
 * Python project detection and metadata extraction.
 *
 * Two public functions:
 *   findPythonProjectRoot()      — locate a Python project root from a given path
 *   detectAndParsePythonProject()— detect package manager, parse deps, detect tooling
 *
 * One mutation helper:
 *   mergePythonMeta()            — append Python deps + tooling into an existing ProjectMeta
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { parse as parseToml } from 'smol-toml';
import {
  poetryLockfileParser,
  pdmLockfileParser,
  uvLockfileParser,
  pipenvLockfileParser,
  requirementsTxtParser,
  pyprojectTomlParser,
} from './python-lockfile.js';
import type { DependencyEntry, ProjectMeta } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel files that indicate the root of a Python project */
const PYTHON_ROOT_SENTINELS = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  'uv.lock',
];

/** Virtual-env / build dirs to exclude during Python source scanning (used externally) */
export const PYTHON_VENV_DIRS = new Set([
  '.venv',
  'venv',
  'env',
  '__pypackages__',
  'site-packages',
  'dist',
  'build',
  '__pycache__',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Internal result type
// ─────────────────────────────────────────────────────────────────────────────

export interface PythonProjectMeta {
  projectRoot: string;
  packageName: string;
  packageVersion: string;
  dependencies: DependencyEntry[];
  pythonPackageManager: string | null;
  pythonVersion: string | null;
  pythonFramework: string | null;
  pythonTestFramework: string | null;
  pythonLinter: string | null;
  pythonFormatter: string | null;
  pythonTypeChecker: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// findPythonProjectRoot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk up to 4 parent directories from `projectPath` to find a Python project
 * root (a directory containing at least one of the Python sentinel files).
 *
 * Returns `null` when no Python project is found (e.g. JS-only repos).
 */
export function findPythonProjectRoot(projectPath: string): string | null {
  let dir = projectPath;

  for (let i = 0; i < 5; i++) {
    for (const sentinel of PYTHON_ROOT_SENTINELS) {
      if (existsSync(join(dir, sentinel))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// detectAndParsePythonProject
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the Python package manager, parse dependencies, and detect tooling
 * for the Python project rooted at `projectRoot`.
 */
export function detectAndParsePythonProject(projectRoot: string): PythonProjectMeta {
  // Parse pyproject.toml once (used for PM detection + tooling)
  const pyprojectPath = join(projectRoot, 'pyproject.toml');
  let pyprojectDoc: Record<string, unknown> | null = null;
  let pyprojectRaw: string | null = null;
  if (existsSync(pyprojectPath)) {
    try {
      pyprojectRaw = readFileSync(pyprojectPath, 'utf-8');
      pyprojectDoc = parseToml(pyprojectRaw) as Record<string, unknown>;
    } catch {
      // malformed TOML — treat as absent
    }
  }

  // ── Package name + version ─────────────────────────────────────────────────
  let packageName = '';
  let packageVersion = '';

  if (pyprojectDoc) {
    const project = pyprojectDoc['project'];
    if (project && typeof project === 'object') {
      const p = project as Record<string, unknown>;
      if (typeof p['name'] === 'string') packageName = p['name'];
      if (typeof p['version'] === 'string') packageVersion = p['version'];
    }
    const tool = pyprojectDoc['tool'];
    if (tool && typeof tool === 'object') {
      const poetry = (tool as Record<string, unknown>)['poetry'];
      if (poetry && typeof poetry === 'object') {
        const po = poetry as Record<string, unknown>;
        if (!packageName && typeof po['name'] === 'string') packageName = po['name'];
        if (!packageVersion && typeof po['version'] === 'string') packageVersion = po['version'];
      }
    }
  }

  // Fallback: setup.cfg [metadata]
  if (!packageName || !packageVersion) {
    const setupCfg = _parseSetupCfg(join(projectRoot, 'setup.cfg'));
    if (!packageName && setupCfg.name) packageName = setupCfg.name;
    if (!packageVersion && setupCfg.version) packageVersion = setupCfg.version;
  }

  // ── Package manager detection ──────────────────────────────────────────────
  const pythonPackageManager = _detectPackageManager(projectRoot, pyprojectDoc);

  // ── Parse dependencies ─────────────────────────────────────────────────────
  const dependencies = _parseDependencies(
    projectRoot,
    pythonPackageManager,
    pyprojectDoc,
    pyprojectRaw,
  );

  // ── Tooling detection ─────────────────────────────────────────────────────
  const depNames = new Set(dependencies.map((d) => d.name.toLowerCase()));

  // Python version
  const pythonVersion = _detectPythonVersion(projectRoot, pyprojectDoc);

  // Framework
  let pythonFramework: string | null = null;
  for (const fw of ['django', 'flask', 'fastapi', 'starlette']) {
    if (depNames.has(fw)) { pythonFramework = fw; break; }
  }

  // Test framework
  let pythonTestFramework: string | null = null;
  for (const tf of ['pytest', 'nose2']) {
    if (depNames.has(tf)) { pythonTestFramework = tf; break; }
  }

  // Linter
  let pythonLinter: string | null = null;
  const hasRuffTool = pyprojectDoc ? _hasTool(pyprojectDoc, 'ruff') : false;
  if (depNames.has('ruff') || hasRuffTool) pythonLinter = 'ruff';
  else if (depNames.has('flake8')) pythonLinter = 'flake8';
  else if (depNames.has('pylint')) pythonLinter = 'pylint';

  // Formatter
  let pythonFormatter: string | null = null;
  const hasRuffFormat = pyprojectDoc ? _hasTool(pyprojectDoc, 'ruff', 'format') : false;
  if (hasRuffFormat) pythonFormatter = 'ruff';
  else if (depNames.has('black')) pythonFormatter = 'black';
  else if (depNames.has('autopep8')) pythonFormatter = 'autopep8';
  else if (depNames.has('isort')) pythonFormatter = 'isort';

  // Type checker
  let pythonTypeChecker: string | null = null;
  for (const tc of ['mypy', 'pyright', 'pytype']) {
    if (depNames.has(tc)) { pythonTypeChecker = tc; break; }
  }

  return {
    projectRoot,
    packageName,
    packageVersion,
    dependencies,
    pythonPackageManager,
    pythonVersion,
    pythonFramework,
    pythonTestFramework,
    pythonLinter,
    pythonFormatter,
    pythonTypeChecker,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// mergePythonMeta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutate `meta` in-place: append Python deps and copy Python tooling fields.
 * Same mutation pattern as `enrichWithResolvedVersions` in scanner.ts.
 */
export function mergePythonMeta(meta: ProjectMeta, python: PythonProjectMeta): void {
  meta.dependencies.push(...python.dependencies);
  meta.tooling.pythonPackageManager = python.pythonPackageManager;
  meta.tooling.pythonVersion = python.pythonVersion;
  meta.tooling.pythonFramework = python.pythonFramework;
  meta.tooling.pythonTestFramework = python.pythonTestFramework;
  meta.tooling.pythonLinter = python.pythonLinter;
  meta.tooling.pythonFormatter = python.pythonFormatter;
  meta.tooling.pythonTypeChecker = python.pythonTypeChecker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _detectPackageManager(
  projectRoot: string,
  pyprojectDoc: Record<string, unknown> | null,
): string | null {
  const has = (f: string): boolean => existsSync(join(projectRoot, f));

  // 1. pyproject.toml has [tool.poetry] AND poetry.lock exists → poetry
  if (pyprojectDoc && _hasTool(pyprojectDoc, 'poetry') && has('poetry.lock')) {
    return 'poetry';
  }

  // 2. uv.lock exists OR pyproject.toml has [tool.uv] → uv
  if (has('uv.lock') || (pyprojectDoc && _hasTool(pyprojectDoc, 'uv'))) {
    return 'uv';
  }

  // 3. pyproject.toml has [tool.pdm] OR pdm.lock exists → pdm
  if ((pyprojectDoc && _hasTool(pyprojectDoc, 'pdm')) || has('pdm.lock')) {
    return 'pdm';
  }

  // 3. Pipfile exists → pipenv
  if (has('Pipfile')) return 'pipenv';

  // 4. requirements.in → pip-tools
  if (has('requirements.in')) return 'pip-tools';

  // 5. requirements.txt → pip
  if (has('requirements.txt')) return 'pip';

  // 6. pyproject.toml has [tool.hatch] → hatch
  if (pyprojectDoc && _hasTool(pyprojectDoc, 'hatch')) return 'hatch';

  return null;
}

function _parseDependencies(
  projectRoot: string,
  packageManager: string | null,
  pyprojectDoc: Record<string, unknown> | null,
  pyprojectRaw: string | null,
): DependencyEntry[] {
  const has = (f: string): boolean => existsSync(join(projectRoot, f));
  const read = (f: string): string => readFileSync(join(projectRoot, f), 'utf-8');

  try {
    switch (packageManager) {
      case 'poetry': {
        // Parse pyproject.toml for version ranges
        const entries = pyprojectRaw ? pyprojectTomlParser.parse(pyprojectRaw) : [];
        // Enrich with resolved versions from poetry.lock
        if (has('poetry.lock')) {
          const resolved = poetryLockfileParser.parse(read('poetry.lock'));
          for (const entry of entries) {
            const ver = resolved.get(entry.name);
            if (ver) {
              _applyResolvedVersion(entry, ver);
            }
          }
        }
        return entries;
      }

      case 'pdm': {
        const entries = pyprojectRaw ? pyprojectTomlParser.parse(pyprojectRaw) : [];
        if (has('pdm.lock')) {
          const resolved = pdmLockfileParser.parse(read('pdm.lock'));
          for (const entry of entries) {
            const ver = resolved.get(entry.name);
            if (ver) {
              _applyResolvedVersion(entry, ver);
            }
          }
        }
        return entries;
      }

      case 'pipenv':
        if (has('Pipfile.lock')) {
          return pipenvLockfileParser.parse(read('Pipfile.lock'));
        }
        return [];

      case 'pip-tools':
        // requirements.txt has the pinned versions
        if (has('requirements.txt')) {
          return requirementsTxtParser.parse(read('requirements.txt'));
        }
        return [];

      case 'pip':
        if (has('requirements.txt')) {
          return requirementsTxtParser.parse(read('requirements.txt'));
        }
        return [];

      case 'uv': {
        const entries = pyprojectRaw ? pyprojectTomlParser.parse(pyprojectRaw) : [];
        if (has('uv.lock')) {
          const resolved = uvLockfileParser.parse(read('uv.lock'));
          for (const entry of entries) {
            const ver = resolved.get(entry.name);
            if (ver) _applyResolvedVersion(entry, ver);
          }
        }
        return entries;
      }

      case 'hatch':
      default:
        // Parse pyproject.toml only (no standard lockfile for hatch yet)
        if (pyprojectRaw) {
          return pyprojectTomlParser.parse(pyprojectRaw);
        }
        return [];
    }
  } catch {
    return [];
  }
}

function _detectPythonVersion(
  projectRoot: string,
  pyprojectDoc: Record<string, unknown> | null,
): string | null {
  // 1. .python-version file
  const pvPath = join(projectRoot, '.python-version');
  if (existsSync(pvPath)) {
    try {
      const v = readFileSync(pvPath, 'utf-8').trim();
      if (v) return v;
    } catch { /* ignore */ }
  }

  if (!pyprojectDoc) return null;

  // 2. [project].requires-python
  const project = pyprojectDoc['project'];
  if (project && typeof project === 'object') {
    const rp = (project as Record<string, unknown>)['requires-python'];
    if (typeof rp === 'string') return rp;
  }

  // 3. [tool.poetry.dependencies].python
  const tool = pyprojectDoc['tool'];
  if (tool && typeof tool === 'object') {
    const poetry = (tool as Record<string, unknown>)['poetry'];
    if (poetry && typeof poetry === 'object') {
      const deps = (poetry as Record<string, unknown>)['dependencies'];
      if (deps && typeof deps === 'object') {
        const py = (deps as Record<string, unknown>)['python'];
        if (typeof py === 'string') return py;
      }
    }
  }

  return null;
}

/**
 * Check if `[tool.<name>]` (or `[tool.<name>.<subKey>]`) exists in the parsed TOML.
 */
function _hasTool(doc: Record<string, unknown>, name: string, subKey?: string): boolean {
  const tool = doc['tool'];
  if (!tool || typeof tool !== 'object') return false;
  const toolSection = (tool as Record<string, unknown>)[name];
  if (!toolSection || typeof toolSection !== 'object') return false;
  if (subKey) {
    return subKey in (toolSection as Record<string, unknown>);
  }
  return true;
}

/**
 * Parse a setup.cfg file for [metadata] name and version.
 * Very minimal — only handles the two fields we need.
 */
function _parseSetupCfg(setupCfgPath: string): { name: string; version: string } {
  const result = { name: '', version: '' };
  if (!existsSync(setupCfgPath)) return result;

  try {
    const lines = readFileSync(setupCfgPath, 'utf-8').split('\n');
    let inMetadata = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '[metadata]') { inMetadata = true; continue; }
      if (trimmed.startsWith('[')) { inMetadata = false; continue; }
      if (!inMetadata) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'name') result.name = val;
      else if (key === 'version') result.version = val;
    }
  } catch { /* ignore */ }

  return result;
}

/**
 * Apply a resolved version string to a DependencyEntry, parsing semver components.
 */
function _applyResolvedVersion(entry: DependencyEntry, version: string): void {
  entry.versionResolved = version;
  const withoutBuild = version.split('+')[0];
  const match = withoutBuild.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (match) {
    const prerelease = match[4] ?? null;
    entry.versionMajor = parseInt(match[1], 10);
    entry.versionMinor = parseInt(match[2], 10);
    entry.versionPatch = parseInt(match[3], 10);
    entry.versionPrerelease = prerelease;
    entry.versionIsPrerelease = prerelease !== null;
  }
}
