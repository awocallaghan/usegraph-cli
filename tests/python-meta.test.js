/**
 * Unit tests for src/analyzer/python-meta-analyzer.ts
 *
 * Tests findPythonProjectRoot() and detectAndParsePythonProject() using
 * temporary directories (same pattern as scanner tests).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findPythonProjectRoot,
  detectAndParsePythonProject,
} from '../dist/analyzer/python-meta-analyzer.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpRoot = '';

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'usegraph-python-meta-'));
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create a temp project dir with the given files */
function makeProject(files) {
  const dir = mkdtempSync(join(tmpRoot, 'proj-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return dir;
}

// ─── findPythonProjectRoot ────────────────────────────────────────────────────

test('findPythonProjectRoot: returns null for JS-only project', () => {
  const dir = makeProject({ 'package.json': '{"name":"app"}' });
  const result = findPythonProjectRoot(dir);
  assert.equal(result, null);
});

test('findPythonProjectRoot: detects pyproject.toml', () => {
  const dir = makeProject({ 'pyproject.toml': '[build-system]\nrequires = []' });
  const result = findPythonProjectRoot(dir);
  assert.equal(result, dir);
});

test('findPythonProjectRoot: detects requirements.txt', () => {
  const dir = makeProject({ 'requirements.txt': 'flask==3.1.0\n' });
  const result = findPythonProjectRoot(dir);
  assert.equal(result, dir);
});

test('findPythonProjectRoot: detects setup.cfg', () => {
  const dir = makeProject({ 'setup.cfg': '[metadata]\nname=myapp\n' });
  const result = findPythonProjectRoot(dir);
  assert.equal(result, dir);
});

test('findPythonProjectRoot: detects Pipfile', () => {
  const dir = makeProject({ 'Pipfile': '[packages]\nflask = "*"\n' });
  const result = findPythonProjectRoot(dir);
  assert.equal(result, dir);
});

test('findPythonProjectRoot: detects setup.py', () => {
  const dir = makeProject({ 'setup.py': 'from setuptools import setup\nsetup(name="app")\n' });
  const result = findPythonProjectRoot(dir);
  assert.equal(result, dir);
});

// ─── detectAndParsePythonProject — Poetry ────────────────────────────────────

test('detectAndParsePythonProject: Poetry → packageManager = poetry', () => {
  const dir = makeProject({
    'pyproject.toml': `
[tool.poetry]
name = "py-web"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.115.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0.0"
`,
    'poetry.lock': `
[[package]]
name = "fastapi"
version = "0.115.0"

[[package]]
name = "pytest"
version = "8.3.2"
`,
    '.python-version': '3.11',
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonPackageManager, 'poetry');
  assert.equal(meta.pythonVersion, '3.11');
  assert.equal(meta.pythonFramework, 'fastapi');
  assert.equal(meta.pythonTestFramework, 'pytest');
});

test('detectAndParsePythonProject: Poetry resolved versions from lockfile', () => {
  const dir = makeProject({
    'pyproject.toml': `
[tool.poetry]
name = "py-web"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.115.0"
pydantic = "^2.8.0"
`,
    'poetry.lock': `
[[package]]
name = "fastapi"
version = "0.115.0"

[[package]]
name = "pydantic"
version = "2.8.2"
`,
  });

  const meta = detectAndParsePythonProject(dir);
  const fastapi = meta.dependencies.find((d) => d.name === 'fastapi');
  assert.ok(fastapi);
  assert.equal(fastapi.versionResolved, '0.115.0');
  assert.equal(fastapi.versionMajor, 0);
  assert.equal(fastapi.versionMinor, 115);
  assert.equal(fastapi.versionPatch, 0);

  const pydantic = meta.dependencies.find((d) => d.name === 'pydantic');
  assert.ok(pydantic);
  assert.equal(pydantic.versionResolved, '2.8.2');
});

test('detectAndParsePythonProject: all deps have language = python', () => {
  const dir = makeProject({
    'pyproject.toml': `
[tool.poetry]
name = "py-web"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.115.0"
`,
    'poetry.lock': `
[[package]]
name = "fastapi"
version = "0.115.0"
`,
  });

  const meta = detectAndParsePythonProject(dir);
  for (const dep of meta.dependencies) {
    assert.equal(dep.language, 'python', `dep ${dep.name} should have language=python`);
  }
});

test('detectAndParsePythonProject: Poetry dev group → section = devDependencies', () => {
  const dir = makeProject({
    'pyproject.toml': `
[tool.poetry]
name = "py-web"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.115.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0.0"
ruff = "^0.5.0"
`,
    'poetry.lock': `
[[package]]
name = "fastapi"
version = "0.115.0"

[[package]]
name = "pytest"
version = "8.3.2"

[[package]]
name = "ruff"
version = "0.5.7"
`,
  });

  const meta = detectAndParsePythonProject(dir);
  const pytest = meta.dependencies.find((d) => d.name === 'pytest');
  assert.ok(pytest);
  assert.equal(pytest.section, 'devDependencies');
});

// ─── detectAndParsePythonProject — pip-tools ─────────────────────────────────

test('detectAndParsePythonProject: pip-tools → packageManager = pip-tools', () => {
  const dir = makeProject({
    'requirements.in': 'flask>=3.0\npandas>=2.0\n',
    'requirements.txt': 'flask==3.1.0\npandas==2.2.0\n',
    'setup.cfg': '[metadata]\nname = py-data\nversion = 0.2.0\n',
    '.python-version': '3.12',
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonPackageManager, 'pip-tools');
  assert.equal(meta.pythonVersion, '3.12');
  assert.equal(meta.packageName, 'py-data');
  assert.equal(meta.packageVersion, '0.2.0');
});

test('detectAndParsePythonProject: pip-tools flask → pythonFramework = flask', () => {
  const dir = makeProject({
    'requirements.in': 'flask>=3.0\n',
    'requirements.txt': 'flask==3.1.0\n',
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonFramework, 'flask');
});

// ─── detectAndParsePythonProject — pipenv ────────────────────────────────────

test('detectAndParsePythonProject: Pipfile → packageManager = pipenv', () => {
  const dir = makeProject({
    'Pipfile': '[packages]\nrequests = "*"\n',
    'Pipfile.lock': JSON.stringify({
      _meta: {},
      default: { requests: { version: '==2.31.0' } },
      develop: { pytest: { version: '==7.4.0' } },
    }),
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonPackageManager, 'pipenv');
  const req = meta.dependencies.find((d) => d.name === 'requests');
  assert.ok(req);
  assert.equal(req.versionResolved, '2.31.0');
});

// ─── detectAndParsePythonProject — tooling ────────────────────────────────────

test('detectAndParsePythonProject: detects ruff linter from dep', () => {
  const dir = makeProject({
    'requirements.txt': 'flask==3.1.0\nruff==0.5.7\n',
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonLinter, 'ruff');
});

test('detectAndParsePythonProject: detects mypy type checker', () => {
  const dir = makeProject({
    'requirements.txt': 'fastapi==0.115.0\nmypy==1.11.0\n',
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonTypeChecker, 'mypy');
});

test('detectAndParsePythonProject: detects black formatter', () => {
  const dir = makeProject({
    'requirements.txt': 'flask==3.1.0\nblack==24.8.0\n',
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonFormatter, 'black');
});

test('detectAndParsePythonProject: PEP 621 requires-python as pythonVersion', () => {
  const dir = makeProject({
    'pyproject.toml': `
[project]
name = "myapp"
version = "2.0.0"
requires-python = ">=3.12"
dependencies = ["flask>=3.0"]
`,
  });

  const meta = detectAndParsePythonProject(dir);
  assert.equal(meta.pythonVersion, '>=3.12');
  assert.equal(meta.packageName, 'myapp');
  assert.equal(meta.packageVersion, '2.0.0');
});

// ─── detectAndParsePythonProject — py-web fixture ─────────────────────────────

test('detectAndParsePythonProject: py-web fixture has fastapi framework', async () => {
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const fixtureDir = resolve(__dirname, 'fixtures/org/apps/py-web');

  const meta = detectAndParsePythonProject(fixtureDir);
  assert.equal(meta.pythonPackageManager, 'poetry');
  assert.equal(meta.pythonFramework, 'fastapi');
  assert.equal(meta.pythonTestFramework, 'pytest');
  assert.equal(meta.pythonVersion, '3.11');

  const fastapi = meta.dependencies.find((d) => d.name === 'fastapi');
  assert.ok(fastapi, 'fastapi dep not found');
  assert.equal(fastapi.versionResolved, '0.115.0');
  assert.equal(fastapi.language, 'python');
});
