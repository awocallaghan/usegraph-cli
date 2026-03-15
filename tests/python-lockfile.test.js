/**
 * Unit tests for src/analyzer/python-lockfile.ts
 *
 * All parsers are tested with inline fixture strings (no file I/O).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  poetryLockfileParser,
  pdmLockfileParser,
  uvLockfileParser,
  pipenvLockfileParser,
  requirementsTxtParser,
  pyprojectTomlParser,
} from '../dist/analyzer/python-lockfile.js';

// ─── PoetryLockfileParser ────────────────────────────────────────────────────

test('PoetryLockfileParser: basic single block', () => {
  const content = `
[[package]]
name = "fastapi"
version = "0.115.0"
description = "FastAPI framework"
optional = false
python-versions = ">=3.8"
`;
  const result = poetryLockfileParser.parse(content);
  assert.equal(result.get('fastapi'), '0.115.0');
});

test('PoetryLockfileParser: multiple packages', () => {
  const content = `
[[package]]
name = "fastapi"
version = "0.115.0"

[[package]]
name = "pydantic"
version = "2.8.2"

[[package]]
name = "uvicorn"
version = "0.30.6"
`;
  const result = poetryLockfileParser.parse(content);
  assert.equal(result.get('fastapi'), '0.115.0');
  assert.equal(result.get('pydantic'), '2.8.2');
  assert.equal(result.get('uvicorn'), '0.30.6');
  assert.equal(result.size, 3);
});

test('PoetryLockfileParser: package with extras in name uses raw name', () => {
  const content = `
[[package]]
name = "uvicorn"
version = "0.30.6"
`;
  const result = poetryLockfileParser.parse(content);
  assert.equal(result.get('uvicorn'), '0.30.6');
});

test('PoetryLockfileParser: metadata section does not break parse', () => {
  const content = `
[[package]]
name = "requests"
version = "2.31.0"

[metadata]
lock-version = "2.0"
python-versions = "^3.11"
`;
  const result = poetryLockfileParser.parse(content);
  assert.equal(result.get('requests'), '2.31.0');
});

test('PoetryLockfileParser: empty content returns empty map', () => {
  const result = poetryLockfileParser.parse('');
  assert.equal(result.size, 0);
});

// ─── PdmLockfileParser ───────────────────────────────────────────────────────

test('PdmLockfileParser: same structure as Poetry', () => {
  const content = `
[[package]]
name = "django"
version = "5.0.0"

[[package]]
name = "gunicorn"
version = "21.2.0"
`;
  const result = pdmLockfileParser.parse(content);
  assert.equal(result.get('django'), '5.0.0');
  assert.equal(result.get('gunicorn'), '21.2.0');
});

test('PdmLockfileParser: empty content', () => {
  const result = pdmLockfileParser.parse('');
  assert.equal(result.size, 0);
});

// ─── PipenvLockfileParser ────────────────────────────────────────────────────

test('PipenvLockfileParser: default and develop sections', () => {
  const content = JSON.stringify({
    _meta: { hash: { sha256: 'abc' } },
    default: {
      requests: { version: '==2.28.0', hashes: [] },
      flask: { version: '==3.0.3', hashes: [] },
    },
    develop: {
      pytest: { version: '==7.4.0', hashes: [] },
      black: { version: '==24.0.0', hashes: [] },
    },
  });

  const result = pipenvLockfileParser.parse(content);

  const requests = result.find((d) => d.name === 'requests');
  assert.ok(requests, 'requests not found');
  assert.equal(requests.section, 'dependencies');
  assert.equal(requests.versionResolved, '2.28.0');
  assert.equal(requests.versionMajor, 2);
  assert.equal(requests.language, 'python');

  const pytest = result.find((d) => d.name === 'pytest');
  assert.ok(pytest, 'pytest not found');
  assert.equal(pytest.section, 'devDependencies');
  assert.equal(pytest.versionResolved, '7.4.0');
});

test('PipenvLockfileParser: git dep has null resolved version', () => {
  const content = JSON.stringify({
    _meta: {},
    default: {
      mypkg: { git: 'https://github.com/example/mypkg.git', ref: 'main', version: '==0.0.0' },
    },
    develop: {},
  });

  const result = pipenvLockfileParser.parse(content);
  const mypkg = result.find((d) => d.name === 'mypkg');
  assert.ok(mypkg);
  assert.equal(mypkg.versionResolved, null);
  assert.equal(mypkg.versionRange, 'git');
});

test('PipenvLockfileParser: path dep (no version field) is skipped', () => {
  const content = JSON.stringify({
    _meta: {},
    default: {
      localpkg: { path: './local', editable: true },
    },
    develop: {},
  });

  const result = pipenvLockfileParser.parse(content);
  assert.equal(result.length, 0);
});

test('PipenvLockfileParser: invalid JSON returns empty array', () => {
  const result = pipenvLockfileParser.parse('not json');
  assert.deepEqual(result, []);
});

// ─── RequirementsTxtParser ───────────────────────────────────────────────────

test('RequirementsTxtParser: pinned == version', () => {
  const content = 'flask==3.1.0\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'flask');
  assert.equal(result[0].versionResolved, '3.1.0');
  assert.equal(result[0].versionMajor, 3);
  assert.equal(result[0].language, 'python');
});

test('RequirementsTxtParser: range >= has null resolved', () => {
  const content = 'requests>=2.31.0\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'requests');
  assert.equal(result[0].versionResolved, null);
  assert.equal(result[0].versionRange, '>=2.31.0');
});

test('RequirementsTxtParser: extras are stripped from name', () => {
  const content = 'celery[redis]==5.3.6\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'celery');
  assert.equal(result[0].versionResolved, '5.3.6');
});

test('RequirementsTxtParser: comment lines skipped', () => {
  const content = '# This is a comment\nflask==3.1.0\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'flask');
});

test('RequirementsTxtParser: inline comments stripped', () => {
  const content = 'django==5.0.0  # main web framework\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'django');
  assert.equal(result[0].versionResolved, '5.0.0');
});

test('RequirementsTxtParser: -r include directive skipped', () => {
  const content = '-r dev-requirements.txt\nflask==3.1.0\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'flask');
});

test('RequirementsTxtParser: -e editable install skipped', () => {
  const content = '-e ./local-pkg\nflask==3.1.0\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'flask');
});

test('RequirementsTxtParser: git dep skipped', () => {
  const content = 'git+https://github.com/example/pkg.git\nflask==3.1.0\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'flask');
});

test('RequirementsTxtParser: env marker stripped before parsing', () => {
  const content = 'boto3==1.34.0 ; python_version >= "3.8"\n';
  const result = requirementsTxtParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'boto3');
  assert.equal(result[0].versionResolved, '1.34.0');
});

test('RequirementsTxtParser: empty content returns empty array', () => {
  const result = requirementsTxtParser.parse('');
  assert.deepEqual(result, []);
});

// ─── PyprojectTomlParser ─────────────────────────────────────────────────────

test('PyprojectTomlParser: PEP 621 format', () => {
  const content = `
[project]
name = "myapp"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115",
  "pydantic>=2.8",
]

[project.optional-dependencies]
dev = [
  "pytest>=7.0",
]
`;
  const result = pyprojectTomlParser.parse(content);
  const fastapi = result.find((d) => d.name === 'fastapi');
  assert.ok(fastapi, 'fastapi not found');
  assert.equal(fastapi.section, 'dependencies');
  assert.equal(fastapi.versionRange, '>=0.115');
  assert.equal(fastapi.language, 'python');

  const pytest = result.find((d) => d.name === 'pytest');
  assert.ok(pytest, 'pytest not found');
  assert.equal(pytest.section, 'optionalDependencies');
});

test('PyprojectTomlParser: Poetry legacy format', () => {
  const content = `
[tool.poetry]
name = "py-web"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.115.0"
pydantic = "^2.8.0"

[tool.poetry.dev-dependencies]
pytest = "^8.0.0"
black = "^24.0.0"
`;
  const result = pyprojectTomlParser.parse(content);

  // python should be skipped
  const python = result.find((d) => d.name === 'python');
  assert.equal(python, undefined, 'python should not appear in deps');

  const fastapi = result.find((d) => d.name === 'fastapi');
  assert.ok(fastapi);
  assert.equal(fastapi.section, 'dependencies');
  assert.equal(fastapi.versionRange, '^0.115.0');

  const pytest = result.find((d) => d.name === 'pytest');
  assert.ok(pytest);
  assert.equal(pytest.section, 'devDependencies');
});

test('PyprojectTomlParser: Poetry groups', () => {
  const content = `
[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.115.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0.0"
ruff = "^0.5.0"

[tool.poetry.group.docs.dependencies]
mkdocs = "^1.5.0"
`;
  const result = pyprojectTomlParser.parse(content);

  const pytest = result.find((d) => d.name === 'pytest');
  assert.ok(pytest);
  assert.equal(pytest.section, 'devDependencies');

  const mkdocs = result.find((d) => d.name === 'mkdocs');
  assert.ok(mkdocs);
  assert.equal(mkdocs.section, 'optionalDependencies');
});

test('PyprojectTomlParser: Poetry inline table spec', () => {
  const content = `
[tool.poetry.dependencies]
python = "^3.11"
uvicorn = {version = "^0.30.0", extras = ["standard"]}
`;
  const result = pyprojectTomlParser.parse(content);
  const uvicorn = result.find((d) => d.name === 'uvicorn');
  assert.ok(uvicorn);
  assert.equal(uvicorn.versionRange, '^0.30.0');
  assert.equal(uvicorn.section, 'dependencies');
});

test('PyprojectTomlParser: invalid TOML returns empty array', () => {
  const result = pyprojectTomlParser.parse('not valid toml ][');
  assert.deepEqual(result, []);
});

test('PyprojectTomlParser: empty pyproject returns empty array', () => {
  const result = pyprojectTomlParser.parse('[build-system]\nrequires = []');
  assert.deepEqual(result, []);
});

// ─── UvLockfileParser ────────────────────────────────────────────────────────

test('UvLockfileParser: basic single block with version header and source', () => {
  const content = `
version = 4
requires-python = ">=3.12"

[[package]]
name = "fastapi"
version = "0.115.5"
source = { registry = "https://pypi.org/simple" }
`;
  const result = uvLockfileParser.parse(content);
  assert.equal(result.get('fastapi'), '0.115.5');
});

test('UvLockfileParser: multiple packages', () => {
  const content = `
version = 4

[[package]]
name = "fastapi"
version = "0.115.5"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pydantic"
version = "2.9.2"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "httpx"
version = "0.27.2"
source = { registry = "https://pypi.org/simple" }
`;
  const result = uvLockfileParser.parse(content);
  assert.equal(result.get('fastapi'), '0.115.5');
  assert.equal(result.get('pydantic'), '2.9.2');
  assert.equal(result.get('httpx'), '0.27.2');
  assert.equal(result.size, 3);
});

test('UvLockfileParser: [package.metadata] sub-table does not corrupt adjacent packages', () => {
  const content = `
version = 4

[[package]]
name = "fastapi"
version = "0.115.5"
source = { registry = "https://pypi.org/simple" }

[package.metadata]
requires-dist = ["pydantic>=2.0"]

[[package]]
name = "pydantic"
version = "2.9.2"
source = { registry = "https://pypi.org/simple" }
`;
  const result = uvLockfileParser.parse(content);
  assert.equal(result.get('fastapi'), '0.115.5');
  assert.equal(result.get('pydantic'), '2.9.2');
  assert.equal(result.size, 2);
});

test('UvLockfileParser: empty content returns empty map', () => {
  const result = uvLockfileParser.parse('');
  assert.equal(result.size, 0);
});

// ─── PyprojectTomlParser — [dependency-groups] (PEP 735) ─────────────────────

test('PyprojectTomlParser: [dependency-groups].dev → devDependencies', () => {
  const content = `
[project]
name = "myapp"
version = "1.0.0"
dependencies = ["fastapi>=0.115"]

[dependency-groups]
dev = [
    "pytest>=8.0",
    "ruff>=0.5",
]
`;
  const result = pyprojectTomlParser.parse(content);
  const pytest = result.find((d) => d.name === 'pytest');
  assert.ok(pytest, 'pytest not found');
  assert.equal(pytest.section, 'devDependencies');
  const ruff = result.find((d) => d.name === 'ruff');
  assert.ok(ruff, 'ruff not found');
  assert.equal(ruff.section, 'devDependencies');
});

test('PyprojectTomlParser: {include-group} entries are skipped, strings parsed', () => {
  const content = `
[dependency-groups]
test = [
    {include-group = "dev"},
    "coverage>=7.0",
]
`;
  const result = pyprojectTomlParser.parse(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'coverage');
  assert.equal(result[0].section, 'devDependencies');
});

test('PyprojectTomlParser: non-dev/test/lint group → optionalDependencies', () => {
  const content = `
[dependency-groups]
docs = [
    "mkdocs>=1.5",
]
`;
  const result = pyprojectTomlParser.parse(content);
  const mkdocs = result.find((d) => d.name === 'mkdocs');
  assert.ok(mkdocs, 'mkdocs not found');
  assert.equal(mkdocs.section, 'optionalDependencies');
});

test('PyprojectTomlParser: lint group → devDependencies', () => {
  const content = `
[dependency-groups]
lint = [
    "ruff>=0.5",
]
`;
  const result = pyprojectTomlParser.parse(content);
  const ruff = result.find((d) => d.name === 'ruff');
  assert.ok(ruff, 'ruff not found');
  assert.equal(ruff.section, 'devDependencies');
});

test('PyprojectTomlParser: all [dependency-groups] entries have language = python', () => {
  const content = `
[dependency-groups]
dev = [
    "pytest>=8.0",
    "ruff>=0.5",
]
`;
  const result = pyprojectTomlParser.parse(content);
  for (const dep of result) {
    assert.equal(dep.language, 'python', `dep ${dep.name} should have language=python`);
  }
});
