# Ralph Fix Plan

## Current State (as of last loop)
- Build: clean (`pnpm build` → no TS errors)
- Tests: 75 passing (extractor × 27, walker × 9, project-identity × 14,
  storage-backend × 10, scanner × 15)
- Global `~/.usegraph/<slug>/` store implemented
- `StorageBackend` abstraction in place

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
- [ ] **2.3** Implement `yarn.lock` v1 parser (custom text format)
- [ ] **2.4** Implement `yarn.lock` Berry (v2+) parser (YAML format)
- [ ] **2.5** Integrate lockfile resolver into scanner:
      — add `versionResolved`, `versionMajor`, `versionMinor`, `versionPatch`,
        `versionPrerelease`, `versionIsPrerelease` to `DependencyEntry`
      — denormalise resolved version onto each `ComponentUsage` and `FunctionCallInfo`

---

## Phase 3 — `usegraph build` command + Parquet materialisation

Reads from `~/.usegraph/*/scans/*.json`, writes to `~/.usegraph/built/*.parquet`.
Requires DuckDB. See SPEC.md §Parquet Tables for all column definitions.

- [ ] **3.1** Add `duckdb` npm dependency; create `src/commands/build.ts` skeleton;
      design file layout (`~/.usegraph/built/`)
- [ ] **3.2** Materialise `project_snapshots` + `dependencies` tables
- [ ] **3.3** Materialise `component_usages` + `component_prop_usages` tables
- [ ] **3.4** Materialise `function_usages` + `function_arg_usages` tables
- [ ] **3.5** Register `usegraph build [--rebuild]` in `src/cli.ts`; add basic E2E test

---

## Phase 4 — `usegraph mcp` MCP server

Exposes 13 tools over the Parquet tables. Requires `@modelcontextprotocol/sdk`.
See SPEC.md §MCP Tools for each tool's input schema and SQL.

- [ ] **4.1** Add `@modelcontextprotocol/sdk`; create `src/commands/mcp.ts` scaffold
      with tool registration pattern
- [ ] **4.2** Implement discovery tools:
      `get_scan_metadata`, `list_projects`, `list_packages`, `get_project_snapshot`
- [ ] **4.3** Implement dependency tools:
      `query_dependency_versions`, `query_prerelease_usage`, `query_tooling_distribution`
- [ ] **4.4** Implement component tools:
      `query_component_usage`, `query_prop_usage`, `query_component_adoption_trend`
- [ ] **4.5** Implement function + source tools:
      `query_export_usage`, `query_export_adoption_trend`, `get_source_context`
- [ ] **4.6** Register `usegraph mcp [--port <n>]` in `src/cli.ts`; integration test

---

## Backlog (lower priority)

- [ ] Integration test: run `usegraph scan` on a real project
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
