# Ralph Fix Plan

## Current State (as of last loop)
- Build: clean (tsc → no TS errors); use `node node_modules/typescript/bin/tsc`
  (pnpm build broken in this environment due to workspace exec)
- Tests: 134 passing

---

## MCP Refactor: migrate to `tmcp` framework

**BLOCKED — ESM/CJS incompatibility.**
`tmcp`, `@tmcp/adapter-zod`, and `@tmcp/transport-stdio` are all ESM-only packages
(`"type": "module"`). Our project compiles to CommonJS. TypeScript converts `import()`
to `Promise.resolve().then(() => require(...))`, which throws ERR_REQUIRE_ESM at runtime.
The `Function('m','return import(m)')` workaround loses all type safety and adds complexity.
The current manual readline/JSON-RPC implementation is correct and already tested.
Dependencies were installed (`tmcp`, `@tmcp/adapter-zod`, `zod`, `@tmcp/transport-stdio`)
but the migration is deferred until the project migrates to ESM.

- [x] **6.1** ~~Install tmcp dependencies~~ — installed, migration blocked (see above)
- [ ] **6.2** ~~Rewrite mcp.ts~~ — SKIP (ESM/CJS blocker; current implementation is correct)
- [ ] **6.3** ~~Verify integration~~ — SKIP (depends on 6.2)

---

## Phase 7 — End-to-end test suite

Dependencies:
  7.0 must land before 7.2.
  7.1a–7.1f are fully independent of each other and of 7.0 — create them in parallel.
  7.2 requires 7.0 + all of 7.1a–7.1f.
  7.3 is populated and executed after 7.2 passes.

### 7.0 — Make data dirs configurable for testing

- [x] **7.0** Thread a `USEGRAPH_HOME` env-var override through the codebase:
      — In `src/commands/build.ts`: replace `join(homedir(), '.usegraph')` with
        `process.env.USEGRAPH_HOME ?? join(homedir(), '.usegraph')`
      — In `src/commands/mcp.ts`: same override for `BUILT_DIR`
      — In `src/storage.ts` / `FilesystemBackend`: same override for storage root
      — This allows E2E tests to point at a temp directory without polluting `~/.usegraph`
      — Add a note in the Architecture section of the README

### 7.1 — Create fixture organisation

All fixtures live under `tests/fixtures/org/`. Each is a self-contained project directory
with real-looking TypeScript/JavaScript source files importing from two fake internal packages:
  `@acme/ui`   — React component library: Button, Input, Modal, Badge, Tooltip
  `@acme/utils`— Utility functions: formatDate, formatCurrency, debounce, useLocalStorage

Each fixture needs:
  1. A `package.json` (name, version, dependencies listing `@acme/ui` and/or `@acme/utils`)
  2. At least 2–3 source files (.ts/.tsx/.js/.jsx) with realistic JSX/function-call usage
  3. A stub lockfile in the correct format for the project's package manager
     (must follow the parser format — see `src/analyzer/lockfile.ts` for field expectations)
  4. At least one tooling config file (e.g. `vitest.config.ts`, `jest.config.js`, `.eslintrc`)

- [x] **7.1a** `tests/fixtures/org/apps/web-app/`
      Stack: React 18 · Vite · Vitest · ESLint · TypeScript · pnpm
      Source: ≥3 TSX files; Button used with ≥3 distinct prop combinations; formatDate called
      Lockfile: `pnpm-lock.yaml` stub resolving `@acme/ui@1.2.0`, `react@18.2.0`,
        `@acme/utils@0.5.0`

- [ ] **7.1b** `tests/fixtures/org/apps/dashboard/`
      Stack: React 18 · Webpack 5 · Jest · ESLint · TypeScript · npm
      Source: ≥3 TSX files; uses Button, Modal, Badge; calls formatCurrency, debounce
      Lockfile: `package-lock.json` stub (lockfileVersion 3)

- [ ] **7.1c** `tests/fixtures/org/apps/docs/`
      Stack: Next.js 14 · TypeScript · ESLint · Prettier · yarn Berry (v2)
      Source: ≥2 TSX files (pages/components); uses Input, Tooltip from `@acme/ui`
      Lockfile: `yarn.lock` Berry YAML stub (starts with `__metadata:`)

- [ ] **7.1d** `tests/fixtures/org/apps/mobile/`
      Stack: React Native · Babel (no TypeScript) · Jest · npm · yarn v1
      Source: ≥2 JSX files; calls formatDate, formatCurrency, useLocalStorage from `@acme/utils`
      Lockfile: `yarn.lock` v1 stub (classic text format)

- [ ] **7.1e** `tests/fixtures/org/packages/ui/`
      The source package for `@acme/ui` itself
      `package.json` name: `@acme/ui`, version `1.2.0`; deps include `@acme/utils`
      Tooling: Storybook config (`storybook/main.ts`), Vitest, TypeScript
      Source: `src/index.ts` barrel + one file per component (Button.tsx, Input.tsx, Modal.tsx,
        Badge.tsx, Tooltip.tsx) — each is a minimal React component definition
      Lockfile: `pnpm-lock.yaml` stub

- [ ] **7.1f** `tests/fixtures/org/packages/utils/`
      The source package for `@acme/utils`
      `package.json` name: `@acme/utils`, version `0.5.0`
      Tooling: Vitest, TypeScript
      Source: `src/index.ts` exporting formatDate, formatCurrency, debounce, useLocalStorage
      Lockfile: `pnpm-lock.yaml` stub

### 7.2 — E2E test harness

- [ ] **7.2** Write `tests/e2e.test.js` (Node built-in test runner, no extra deps):

      Setup (runs once, `before` hook):
        1. Create a temp dir `USEGRAPH_HOME` (use `os.mkdtempSync`)
        2. For each of the 6 fixture projects, programmatically invoke the scanner
           (`import { scan } from '../dist/commands/scan.js'` or spawn `node dist/index.js scan`)
           with `packages: ['@acme/ui', '@acme/utils']` and `USEGRAPH_HOME` set
        3. Run the build step (`node dist/index.js build` or invoke `runBuild()` directly)
           to materialise Parquet tables into `$USEGRAPH_HOME/built/`

      Assertions (one `test()` per tool):
        — `list_projects`: returns exactly 6 slugs matching fixture package names
        — `list_packages`: result includes `@acme/ui` and `@acme/utils`
        — `query_component_usage({ package: '@acme/ui', component: 'Button' })`:
             rows from web-app, dashboard, docs (≥1 row per project)
        — `query_prop_usage({ package: '@acme/ui', component: 'Button' })`:
             prop names include at least `variant`, `onClick`, or `disabled`
        — `query_export_usage({ package: '@acme/utils', export: 'formatDate' })`:
             rows from mobile + dashboard
        — `query_tooling_distribution({ category: 'test_framework' })`:
             result contains both `jest` and `vitest` entries
        — `query_dependency_versions({ package: 'react' })`:
             returns at least one row with version `18.2.0`
        — `get_scan_metadata`: `project_count` equals 6, `total_component_usages` > 0

      Teardown: remove temp dir

      To invoke MCP tool handlers without the stdio loop, export a `callTool(name, args)`
      helper from `src/commands/mcp.ts` (or a thin test shim) that skips transport.

### 7.3 — Bug-fix and regression tasks (populated after 7.2 runs)

- [ ] **7.3** Run `node --test tests/e2e.test.js`; for each failing assertion:
      — Identify the layer: scanner (extractor/walker), build (SQL/Parquet write), or MCP (SQL/schema)
      — Add a focused unit test in the relevant `tests/*.test.js` file that reproduces the bug
        in isolation (no Parquet needed for scanner/extractor bugs)
      — Fix the bug in the appropriate source file
      — Re-run both the unit test and the full E2E suite; confirm green
      — Append a one-line entry here: `[7.3.N] <bug summary> — fixed in <file>:<line>`
      This task is complete when `node --test tests/*.test.js tests/e2e.test.js` exits 0.

---

## Architecture Notes

- See `.ralph/SPEC.md` for full schema, Parquet table definitions, and MCP tool API
