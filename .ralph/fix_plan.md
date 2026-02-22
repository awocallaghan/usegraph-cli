# Ralph Fix Plan

## Current State (as of last loop)
- Build: clean (tsc → no TS errors); use `node node_modules/typescript/bin/tsc`
  (pnpm build broken in this environment due to workspace exec)
- Tests: 134 passing
- Phase 1 (schema evolution) complete
- Phase 2 (lockfile parsing) complete — 4 parsers + scanner integration
- Phase 3 (build command) complete — src/commands/build.ts + `usegraph build` in cli.ts
  — Writes 6 Parquet tables to ~/.usegraph/built/ via DuckDB read_json_auto + COPY
  — duckdb@1.4.4 installed; binary downloaded to lib/binding/duckdb.node
  — CAUTION: duckdb build scripts blocked by pnpm; binary must be downloaded manually
    (run: node node_modules/.pnpm/@mapbox+node-pre-gyp@2.0.3_encoding@0.1.13/node_modules/@mapbox/node-pre-gyp/bin/node-pre-gyp install --directory <duckdb-pkg-dir>)

See SPEC.md for the full data architecture being implemented.

---

## Phase 1 — Schema Evolution (enrich raw scan output)

Each task here modifies `src/types.ts`, `src/analyzer/`, and related tests.
Tasks must be done IN ORDER — later tasks depend on earlier ones.

- [x] **1.1** Add `schemaVersion`, `repoUrl`, `branch`, `commitSha` to `ScanResult`
      — see SPEC.md §Schema: Top-level fields
- [x] **1.2** Add verbatim `packageJson` block to `ScanResult`
      — store the full parsed `package.json` object (or `null`)
- [x] **1.3** Replace `ProjectMeta.tooling: ToolingInfo[]` with flat `ToolingMeta` struct
      — update `meta-analyzer.ts` to return flat fields; see SPEC.md §Schema: tooling block
- [x] **1.4** Add `sourceSnippet: string | null` to `PropInfo` and `ArgInfo`
      — update `extractor.ts` to capture ~5 lines of source context for dynamic values;
        see SPEC.md §Schema: sourceSnippet
      — ALSO fixed: SWC BytePos is cumulative across parse() calls; subtract module
        span.start from all offsets to get source-relative positions

---

## Phase 2 — Lockfile Parsing (resolve actual installed versions)

Creates `src/analyzer/lockfile.ts`. Each task is independent once the interface is
defined (2.1). Tasks 2.2–2.4 can be done in any order. Task 2.5 requires 2.1–2.4.

- [x] **2.1** Design lockfile interface + implement `package-lock.json` (npm) parser
      — see SPEC.md §Lockfile Parsing
- [x] **2.2** Implement `pnpm-lock.yaml` parser
- [x] **2.3** Implement `yarn.lock` v1 parser (custom text format)
- [x] **2.4** Implement `yarn.lock` Berry (v2+) parser (YAML format)
- [x] **2.5** Integrate lockfile resolver into scanner:
      — add `versionResolved`, `versionMajor`, `versionMinor`, `versionPatch`,
        `versionPrerelease`, `versionIsPrerelease` to `DependencyEntry`
      — denormalise resolved version onto each `ComponentUsage` and `FunctionCallInfo`

---

## Phase 3 — `usegraph build` command + Parquet materialisation

Reads from `~/.usegraph/*/scans/*.json`, writes to `~/.usegraph/built/*.parquet`.
Requires DuckDB. See SPEC.md §Parquet Tables for all column definitions.

- [x] **3.1** Add `duckdb` npm dependency; create `src/commands/build.ts` skeleton;
      design file layout (`~/.usegraph/built/`)
- [x] **3.2** Materialise `project_snapshots` + `dependencies` tables
- [x] **3.3** Materialise `component_usages` + `component_prop_usages` tables
- [x] **3.4** Materialise `function_usages` + `function_arg_usages` tables
- [x] **3.5** Register `usegraph build [--rebuild]` in `src/cli.ts`; add basic E2E test

---

## Phase 4 — `usegraph mcp` MCP server

Exposes 13 tools over the Parquet tables. Requires `@modelcontextprotocol/sdk`.
See SPEC.md §MCP Tools for each tool's input schema and SQL.

- [x] **4.1** Add `@modelcontextprotocol/sdk`; create `src/commands/mcp.ts` scaffold
      with tool registration pattern
      — Implemented protocol DIRECTLY (no SDK needed): newline-delimited JSON-RPC 2.0 over stdio
      — Avoids `pnpm install` requirement; simpler and self-contained
- [x] **4.2** Implement discovery tools:
      `get_scan_metadata`, `list_projects`, `list_packages`, `get_project_snapshot`
- [x] **4.3** Implement dependency tools:
      `query_dependency_versions`, `query_prerelease_usage`, `query_tooling_distribution`
- [x] **4.4** Implement component tools:
      `query_component_usage`, `query_prop_usage`, `query_component_adoption_trend`
- [x] **4.5** Implement function + source tools:
      `query_export_usage`, `query_export_adoption_trend`, `get_source_context`
- [x] **4.6** Register `usegraph mcp [--verbose]` in `src/cli.ts`; integration test
      — WARNING: column-injection guard for `query_tooling_distribution` validated against TOOLING_CATEGORY_ALLOWLIST

---

## Phase 5 — README Update

- [x] **5.1** Rewrite `README.md` to reflect the current state of the tool:
      — Add `usegraph build [--rebuild]` command (options, examples, Parquet output layout)
      — Add `usegraph mcp [--verbose]` command (setup instructions, full list of 13 tools with
        one-line descriptions, how to wire into an MCP client / Claude Desktop)
      — Update the Architecture section: add `commands/build.ts`, `commands/mcp.ts`,
        `analyzer/lockfile.ts`, `analyzer/meta-analyzer.ts` to the tree
      — Update Data Collected section to mention lockfile version resolution and tooling metadata
      — Remove stale "(STRETCH)" labels
      — Add a "Data Flow" section: scan → .usegraph/ JSON → `usegraph build` → Parquet → MCP tools

---

## Phase 6 — MCP Refactor: migrate to `tmcp` framework

Tasks must be done IN ORDER.

- [ ] **6.1** Install tmcp dependencies and design the migration:
      `pnpm add tmcp @tmcp/adapter-zod zod @tmcp/transport-stdio`
      — Read the tmcp README + source to understand `createServer()`, `server.tool()`, and
        how `@tmcp/transport-stdio` replaces the readline loop
      — Write a brief migration map in a comment block at the top of the new `mcp.ts`
        (old pattern → new pattern for each of the 13 tools)

- [ ] **6.2** Rewrite `src/commands/mcp.ts` using tmcp:
      — Replace the raw readline + JSON-RPC dispatch loop with `createServer()` from `tmcp`
      — Define each tool's input schema with Zod; keep the existing SQL queries unchanged
      — Use `@tmcp/transport-stdio` for the stdio transport; keep `--verbose` flag wiring
      — Preserve the `TOOLING_CATEGORY_ALLOWLIST` column-injection guard
      — Remove now-unused readline / manual JSON-RPC helpers

- [ ] **6.3** Verify integration after refactor:
      — Build (`node node_modules/typescript/bin/tsc`); confirm zero TS errors
      — Run existing tests (`node --test tests/*.test.js`); confirm all pass
      — Manually exercise `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js mcp`
        and confirm the tool list is returned

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

- [ ] **7.1a** `tests/fixtures/org/apps/web-app/`
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

## Backlog (lower priority)

- [ ] Shell completion scripts (bash/zsh)
- [ ] Incremental Parquet builds (track processed files; start with full --rebuild only)
- [ ] Data retention policy in build step (daily for 30d, monthly beyond)

---

## Architecture Notes

- See `.ralph/SPEC.md` for full schema, Parquet table definitions, and MCP tool API
- `storage.ts` low-level helpers are **unchanged** — still used by `FilesystemBackend`
- `schemaVersion: 1` = current extended schema (all Phase 1 fields present)
- Old scan files on disk (no `schemaVersion`) are treated as schema v0 by the build step
- `projectSlug` (from `computeProjectSlug()`) is used as `project_id` in Parquet tables
