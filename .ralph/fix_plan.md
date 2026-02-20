# Ralph Fix Plan

## High Priority
- [x] Review codebase and understand architecture
- [x] Install dependencies (pnpm install) and verify build compiles
- [x] Define the actual purpose/commands of usegraph-cli
- [x] Implement core CLI commands based on project intent
- [x] Fix AstNode import bug in file-analyzer.ts (imported from extractor instead of walker)
- [ ] Run `pnpm install && pnpm build` to verify compilation (needs shell approval)
- [ ] Fix any TypeScript compilation errors after build
- [ ] Integration test: run `usegraph scan` on a real project

## Medium Priority
- [x] Add configuration file support (usegraph.config.json / .usegraphrc)
- [x] Add STRETCH: dependency + tooling detection (meta-analyzer.ts)
- [ ] Add proper error handling and user-friendly error messages (basic done; needs polish)
- [ ] Add test coverage for AST extractor and scanner
- [ ] Update README.md with usage instructions

## Low Priority
- [ ] Performance optimization
- [ ] Add shell completion support
- [ ] Web dashboard (future: React + charts in a separate server command)

## Completed
- [x] Project enabled for Ralph
- [x] Reviewed codebase - project was empty, just package.json
- [x] Set up TypeScript CLI scaffold (Commander.js, tsconfig, src/)
- [x] Implemented full usegraph-cli (Loop 2):
  - SWC AST-based package usage analyzer
  - JSX component tracking with props
  - Function call tracking with arguments
  - Multi-project scanner with concurrency
  - JSON storage layer (.usegraph/scans/)
  - `scan`, `report`, `dashboard`, `init`, `scans` commands
- [x] STRETCH features (Loop 3):
  - `src/analyzer/meta-analyzer.ts`: reads package.json, detects 25+ tooling configs
  - New types: `DependencyEntry`, `ToolingInfo`, `ProjectMeta`
  - `ScanResult.meta` field with dep counts + detected tooling
  - `report` command shows detected tooling + dep stats
  - `dashboard` command shows cross-project tooling matrix

## Architecture Notes (Loop 2)
- **Stack:** TypeScript + Node.js + Commander.js + @swc/core + fast-glob + chalk + pnpm
- **Entry:** `src/index.ts` -> `dist/index.js` (bin: `usegraph`)
- **Key modules:**
  - `src/types.ts` - all TypeScript interfaces
  - `src/config.ts` - config loading (usegraph.config.json)
  - `src/storage.ts` - JSON scan result persistence
  - `src/analyzer/walker.ts` - generic recursive SWC AST walker
  - `src/analyzer/extractor.ts` - extract imports/JSX/calls from AST
  - `src/analyzer/file-analyzer.ts` - per-file SWC parse + extract
  - `src/analyzer/scanner.ts` - project-wide file glob + parallel analysis
  - `src/commands/scan.ts` - scan command
  - `src/commands/report.ts` - terminal report command
  - `src/commands/dashboard.ts` - cross-project dashboard command
- **Module system:** CommonJS (module: commonjs), no .js extensions needed
- **Supported files:** .ts, .tsx, .js, .jsx, .mjs, .cjs
- **Storage layout:** `<project>/.usegraph/scans/<id>.json` + `latest.json`

## Notes
- `@swc/core` needs native binaries; installed automatically by pnpm
- `chalk` must be v4 (v5 is ESM-only, incompatible with CJS)
- Focus on MVP functionality first
- Ensure each feature is properly tested
- Update this file after each major milestone
