/**
 * Unit tests for src/analyzer/ci-parser.ts
 *
 * Tests: source/version parsing, templateType classification, input isDynamic
 * classification, multi-file GitLab includes, invalid YAML resilience, and
 * the parseCiFiles() integration over fixture directories.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { parseCiFiles } from '../dist/analyzer/ci-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'org', 'apps');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary project directory with the given CI files, run
 * parseCiFiles(), then clean up.  Returns { usages, errors }.
 */
function withCiProject(files, fn) {
  const dir = join(tmpdir(), `usegraph-ci-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(dir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf-8');
    }
    return fn(parseCiFiles(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── GitHub Actions — action parsing ─────────────────────────────────────────

test('parses a basic GitHub action step (uses: owner/repo@ref)', () => {
  withCiProject(
    {
      '.github/workflows/ci.yml': `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      const u = usages[0];
      assert.equal(u.provider, 'github');
      assert.equal(u.templateType, 'action');
      assert.equal(u.source, 'actions/checkout');
      assert.equal(u.version, 'v4');
      assert.equal(u.inputs.length, 0);
      assert.ok(u.line > 0, 'line should be set');
    },
  );
});

test('parses a GitHub action with with: inputs', () => {
  withCiProject(
    {
      '.github/workflows/ci.yml': `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: pnpm
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      const u = usages[0];
      assert.equal(u.source, 'actions/setup-node');
      assert.equal(u.version, 'v4');
      assert.equal(u.inputs.length, 2);

      const nodeInput = u.inputs.find((i) => i.name === 'node-version');
      assert.ok(nodeInput);
      assert.equal(nodeInput.value, '20');
      assert.equal(nodeInput.isDynamic, false);

      const cacheInput = u.inputs.find((i) => i.name === 'cache');
      assert.ok(cacheInput);
      assert.equal(cacheInput.value, 'pnpm');
      assert.equal(cacheInput.isDynamic, false);
    },
  );
});

test('marks ${{ expressions }} inputs as dynamic', () => {
  withCiProject(
    {
      '.github/workflows/ci.yml': `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: \${{ github.run_id }}
          path: dist/
`,
    },
    ({ usages }) => {
      const u = usages[0];
      const nameInput = u.inputs.find((i) => i.name === 'name');
      assert.ok(nameInput);
      assert.equal(nameInput.isDynamic, true);
      assert.equal(nameInput.value, null);

      const pathInput = u.inputs.find((i) => i.name === 'path');
      assert.ok(pathInput);
      assert.equal(pathInput.isDynamic, false);
      assert.equal(pathInput.value, 'dist/');
    },
  );
});

// ─── GitHub Actions — reusable workflow ──────────────────────────────────────

test('classifies a reusable workflow call correctly', () => {
  withCiProject(
    {
      '.github/workflows/deploy.yml': `
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    uses: org/platform/.github/workflows/deploy-app.yml@main
    with:
      environment: production
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      const u = usages[0];
      assert.equal(u.provider, 'github');
      assert.equal(u.templateType, 'reusable_workflow');
      assert.equal(u.source, 'org/platform/.github/workflows/deploy-app.yml');
      assert.equal(u.version, 'main');
      const envInput = u.inputs.find((i) => i.name === 'environment');
      assert.ok(envInput);
      assert.equal(envInput.value, 'production');
    },
  );
});

test('parses multiple steps across multiple jobs', () => {
  withCiProject(
    {
      '.github/workflows/ci.yml': `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
`,
    },
    ({ usages }) => {
      assert.equal(usages.length, 3);
      const sources = usages.map((u) => u.source);
      assert.ok(sources.includes('actions/checkout'));
      assert.ok(sources.includes('actions/setup-node'));
    },
  );
});

// ─── GitHub Actions — no ref ─────────────────────────────────────────────────

test('handles uses: without a @ref (version is null)', () => {
  withCiProject(
    {
      '.github/workflows/ci.yml': `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ./local-action
`,
    },
    ({ usages }) => {
      assert.equal(usages.length, 1);
      assert.equal(usages[0].version, null);
      assert.equal(usages[0].source, './local-action');
    },
  );
});

// ─── GitLab CI — project include ─────────────────────────────────────────────

test('parses a GitLab project include with a single file', () => {
  withCiProject(
    {
      '.gitlab-ci.yml': `
include:
  - project: 'org/platform'
    ref: 'main'
    file: '/ci/test.yml'
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      const u = usages[0];
      assert.equal(u.provider, 'gitlab');
      assert.equal(u.templateType, 'gitlab_project_include');
      assert.equal(u.source, "org/platform//ci/test.yml");
      assert.equal(u.version, 'main');
    },
  );
});

test('expands a GitLab project include with multiple files into one usage per file', () => {
  withCiProject(
    {
      '.gitlab-ci.yml': `
include:
  - project: 'org/platform'
    ref: 'v1.2.0'
    file:
      - '/ci/test.yml'
      - '/ci/deploy.yml'
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 2);
      const sources = usages.map((u) => u.source);
      assert.ok(sources.includes('org/platform//ci/test.yml'));
      assert.ok(sources.includes('org/platform//ci/deploy.yml'));
      assert.equal(usages[0].version, 'v1.2.0');
    },
  );
});

// ─── GitLab CI — component ───────────────────────────────────────────────────

test('parses a GitLab component include', () => {
  withCiProject(
    {
      '.gitlab-ci.yml': `
include:
  - component: 'gitlab.example.com/org/ci-components/lint@1.0.0'
    inputs:
      node-version: '20'
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      const u = usages[0];
      assert.equal(u.provider, 'gitlab');
      assert.equal(u.templateType, 'gitlab_component');
      assert.equal(u.source, 'gitlab.example.com/org/ci-components/lint');
      assert.equal(u.version, '1.0.0');
      assert.equal(u.inputs.length, 1);
      assert.equal(u.inputs[0].name, 'node-version');
      assert.equal(u.inputs[0].value, '20');
      assert.equal(u.inputs[0].isDynamic, false);
    },
  );
});

// ─── GitLab CI — template ────────────────────────────────────────────────────

test('parses a GitLab template include', () => {
  withCiProject(
    {
      '.gitlab-ci.yml': `
include:
  - template: 'Auto-DevOps.gitlab-ci.yml'
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      const u = usages[0];
      assert.equal(u.templateType, 'gitlab_template');
      assert.equal(u.source, 'Auto-DevOps.gitlab-ci.yml');
      assert.equal(u.version, null);
    },
  );
});

// ─── GitLab CI — local include ───────────────────────────────────────────────

test('parses a GitLab local include', () => {
  withCiProject(
    {
      '.gitlab-ci.yml': `
include:
  - local: '/.gitlab/security-scan.yml'
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      const u = usages[0];
      assert.equal(u.templateType, 'gitlab_local_include');
      assert.equal(u.source, '/.gitlab/security-scan.yml');
    },
  );
});

// ─── GitLab CI — include: as single object (not array) ───────────────────────

test('handles GitLab include: as a single object (not an array)', () => {
  withCiProject(
    {
      '.gitlab-ci.yml': `
include:
  template: 'SAST.gitlab-ci.yml'
`,
    },
    ({ usages, errors }) => {
      assert.equal(errors.length, 0);
      assert.equal(usages.length, 1);
      assert.equal(usages[0].templateType, 'gitlab_template');
    },
  );
});

// ─── GitLab CI — dynamic variables ───────────────────────────────────────────

test('marks $VAR references in GitLab variables as dynamic', () => {
  withCiProject(
    {
      '.gitlab-ci.yml': `
include:
  - project: 'org/platform'
    ref: 'main'
    file: '/ci/deploy.yml'
    variables:
      STATIC_VAR: hello
      DYNAMIC_VAR: $CI_COMMIT_REF_NAME
`,
    },
    ({ usages }) => {
      const u = usages[0];
      const staticVar = u.inputs.find((i) => i.name === 'STATIC_VAR');
      assert.ok(staticVar);
      assert.equal(staticVar.isDynamic, false);
      assert.equal(staticVar.value, 'hello');

      const dynamicVar = u.inputs.find((i) => i.name === 'DYNAMIC_VAR');
      assert.ok(dynamicVar);
      assert.equal(dynamicVar.isDynamic, true);
      assert.equal(dynamicVar.value, null);
    },
  );
});

// ─── Error resilience ─────────────────────────────────────────────────────────

test('returns an error (not a throw) for invalid YAML', () => {
  withCiProject(
    {
      '.github/workflows/broken.yml': `
name: Broken
on: push
jobs:
  build: [this is: invalid: yaml: structure
`,
    },
    ({ usages, errors }) => {
      assert.equal(usages.length, 0);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes('YAML parse error'));
    },
  );
});

test('returns empty results for a project with no CI files', () => {
  withCiProject(
    {
      'src/index.ts': 'export const x = 1;',
    },
    ({ usages, errors }) => {
      assert.equal(usages.length, 0);
      assert.equal(errors.length, 0);
    },
  );
});

// ─── Fixture integration ──────────────────────────────────────────────────────

test('parses web-app fixture: detects GitHub Actions (actions/checkout, actions/setup-node, org/run-tests-action)', () => {
  const { usages, errors } = parseCiFiles(join(FIXTURES, 'web-app'));
  assert.equal(errors.length, 0);
  const sources = usages.map((u) => u.source);
  assert.ok(sources.includes('actions/checkout'), 'should find actions/checkout');
  assert.ok(sources.includes('actions/setup-node'), 'should find actions/setup-node');
  assert.ok(sources.includes('org/run-tests-action'), 'should find org/run-tests-action');
  assert.ok(usages.every((u) => u.provider === 'github'));
});

test('parses dashboard fixture: detects reusable workflow call', () => {
  const { usages, errors } = parseCiFiles(join(FIXTURES, 'dashboard'));
  assert.equal(errors.length, 0);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].templateType, 'reusable_workflow');
  assert.equal(usages[0].source, 'org/platform/.github/workflows/deploy-app.yml');
  assert.equal(usages[0].version, 'main');
});

test('parses docs fixture: detects all 4 GitLab include types', () => {
  const { usages, errors } = parseCiFiles(join(FIXTURES, 'docs'));
  assert.equal(errors.length, 0);
  // 2 project includes (multi-file) + 1 component + 1 template + 1 local = 5
  assert.equal(usages.length, 5);
  const types = new Set(usages.map((u) => u.templateType));
  assert.ok(types.has('gitlab_project_include'));
  assert.ok(types.has('gitlab_component'));
  assert.ok(types.has('gitlab_template'));
  assert.ok(types.has('gitlab_local_include'));
});

test('fixture docs: GitLab component has correct version', () => {
  const { usages } = parseCiFiles(join(FIXTURES, 'docs'));
  const comp = usages.find((u) => u.templateType === 'gitlab_component');
  assert.ok(comp);
  assert.equal(comp.version, '1.0.0');
});

test('fixture docs: GitLab component inputs are parsed', () => {
  const { usages } = parseCiFiles(join(FIXTURES, 'docs'));
  const comp = usages.find((u) => u.templateType === 'gitlab_component');
  assert.ok(comp);
  assert.ok(comp.inputs.length > 0, 'component should have inputs');
  const nodeInput = comp.inputs.find((i) => i.name === 'node-version');
  assert.ok(nodeInput);
  assert.equal(nodeInput.isDynamic, false);
});
