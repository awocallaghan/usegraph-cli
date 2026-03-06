# usegraph-cli

[![CI](https://github.com/awocallaghan/usegraph-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/awocallaghan/usegraph-cli/actions/workflows/ci.yml)
[![Demo Dashboard](https://github.com/awocallaghan/usegraph-cli/actions/workflows/deploy-demo.yml/badge.svg)](https://awocallaghan.github.io/usegraph-cli/)

**[→ View the live demo dashboard](https://awocallaghan.github.io/usegraph-cli/)**

A CLI tool for analysing how npm packages are used across your projects and organisation.
Track React component props, function call arguments, import patterns, and more.
Collect tech-stack metadata to understand your organisation's tooling landscape.
Expose analysis results as a web dashboard or MCP server so your team and AI assistants can query your data directly.

## Why usegraph?

Large organisations running shared component libraries or internal packages face a common problem: **you don't know how your packages are actually used**. How many projects use `<Button variant="danger">`? Which teams are still on v1? Who calls `createTheme` with a second argument?

usegraph solves this by scanning the AST of every project, recording precise usage data — props, call arguments, import patterns, resolved versions — and persisting it as Parquet tables that can be explored interactively via a built-in web dashboard or queried by AI assistants through an MCP server.

## Features

- **Deep package usage analysis** via SWC AST parsing
  - JSX components: which components are used, with what props and source context
  - Function calls: which functions are called, with what arguments
  - Import tracking: named, default, and namespace imports
- **Lockfile version resolution**: resolves the actual installed version for every
  dependency (supports npm, pnpm, yarn v1, yarn Berry v2+)
- **Multi-project scanning**: run scans across many projects; results saved globally to `~/.usegraph/`
- **Parquet materialisation**: `usegraph build` compresses all scan JSON into 6 typed Parquet tables
  queryable with DuckDB
- **Web dashboard**: `usegraph dashboard` launches an interactive Observable Framework app for
  exploring component adoption, dependency versions, and project detail
- **MCP server**: `usegraph mcp` exposes 13 tools over stdio so Claude (and other MCP clients)
  can query your organisation's usage data directly
- **Tech stack detection**: detect build tools, test frameworks, linters, package managers, and more
- **Dependency reporting**: count and categorise all npm dependencies with resolved versions
- **Checkpoint scanning**: scan historical commits with `--since` / `--interval` to build adoption trend data

## Installation

```bash
# Install globally
npm install -g usegraph-cli

# Or use via npx
npx usegraph-cli scan
```

## Quick Start

```bash
# 1. Scan one or more projects
usegraph scan ./apps/web --packages @acme/ui,@acme/utils
usegraph scan ./apps/mobile --packages @acme/ui,@acme/utils

# 2. Build Parquet tables from all scans
usegraph build

# 3. Launch the web dashboard
usegraph dashboard

# 4. Or start an MCP server for AI-assisted analysis
usegraph mcp
```

## Commands

### `usegraph scan [path]`

Scans a project directory and saves detailed package usage data to `~/.usegraph/`.

```
Options:
  -p, --packages <packages>    Comma-separated list of packages to track
  --force                      Re-scan even if this commit was already scanned
  --since <period>             Scan commits from this date (e.g. 6m, 2w, 2024-01-01)
  --until <period>             End of range (default: now); same format as --since
  --interval <period>          Sample one commit per bucket (e.g. 1m, 2w, 7d)
```

**Examples:**

```bash
# Scan current directory, tracking a design system package
usegraph scan --packages @acme/ui

# Scan a specific project
usegraph scan ./packages/web-app --packages @acme/ui,@acme/icons

# Track all imports (no filter)
usegraph scan ./my-project

# Scan commits from the last 6 months, one per month
usegraph scan --packages @acme/ui --since 6m --interval 1m

# Scan all commits in the last 2 weeks
usegraph scan --packages @acme/ui --since 2w
```

**`codeAt` vs `scannedAt`**

Each scan records two timestamps:

- `scannedAt` — when `usegraph scan` was executed (wall-clock time).
- `codeAt` — the ISO timestamp of the git commit that was scanned (from
  `git log -1 --format=%cI HEAD`). This is `null` when the project is not in a
  git repository.

When `codeAt` is available, it is used as the authoritative "code date" for
trend queries and `is_latest` computation.

**Deduplication**

When a project is inside a git repository, the scan ID is set to the commit SHA.
Running `usegraph scan` twice on the same commit will skip the second scan automatically.
Use `--force` to override this and re-scan a commit that has already been scanned.

**Checkpoint scanning (`--since`)**

`--since <period>` walks `git log` for commits in the given range and scans each
one in isolation using `git worktree`, without modifying the working tree.
Already-scanned commits are skipped automatically (idempotent). Use `--interval`
to sample one commit per time bucket (e.g. one per month).

---

### `usegraph build`

Reads all scan JSON files from `~/.usegraph/` and materialises 6 typed Parquet tables
in `~/.usegraph/built/` using DuckDB. Run this after scanning to prepare data for
`usegraph dashboard` and `usegraph mcp`.

**Parquet output layout:**

```
~/.usegraph/
  built/
    project_snapshots.parquet      — one row per project per scan
    dependencies.parquet           — one row per dependency per project per scan
    component_usages.parquet       — one row per JSX component use site per scan
    component_prop_usages.parquet  — one row per prop per component use site per scan
    function_usages.parquet        — one row per function call per scan
    function_arg_usages.parquet    — one row per argument per function call per scan
```

**Examples:**

```bash
# Build (or refresh) all Parquet tables
usegraph build
```

---

### `usegraph dashboard`

Launches the usegraph web dashboard. Requires `usegraph build` to have been run first.

```
Options:
  -p, --port <n>   Port to listen on (default: 3000)
  --open           Open the dashboard in the default browser automatically
```

---

### `usegraph mcp [--verbose]`

Starts a Model Context Protocol (MCP) server over stdio that exposes 13 tools querying
the Parquet tables built by `usegraph build`. Wire this into Claude Desktop or any other
MCP-compatible client.

```
Options:
  --verbose    Log each request and response to stderr
```

**MCP tools exposed:**

| Category     | Tool name                        | Description                                             |
|--------------|----------------------------------|---------------------------------------------------------|
| Discovery    | `get_scan_metadata`              | Overall stats: project count, total usages, date range  |
| Discovery    | `list_projects`                  | Filtered list of scanned projects with tooling info     |
| Discovery    | `list_packages`                  | All packages tracked across projects                    |
| Discovery    | `get_project_snapshot`           | Full tooling and dependency detail for one project      |
| Dependencies | `query_dependency_versions`      | Version distribution for a given package across orgs   |
| Dependencies | `query_prerelease_usage`         | Which projects use prerelease (`alpha`/`beta`/`rc`) deps |
| Dependencies | `query_tooling_distribution`     | Breakdown of a tooling category (e.g. test frameworks)  |
| Components   | `query_component_usage`          | Where a JSX component is used across projects           |
| Components   | `query_prop_usage`               | Prop values for a component across all call sites       |
| Components   | `query_component_adoption_trend` | Component adoption over time (scan history)             |
| Functions    | `query_export_usage`             | Where a function export is called across projects       |
| Functions    | `query_export_adoption_trend`    | Export adoption over time                               |
| Functions    | `get_source_context`             | Source snippet for a specific prop or arg call site     |

**Wiring into Claude Desktop:**

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "usegraph": {
      "command": "usegraph",
      "args": ["mcp"]
    }
  }
}
```

Then ask Claude: *"Which projects use the Button component with a `variant` prop?"*

---

### `usegraph init [path]`

Creates a `usegraph.config.json` in the project directory with sensible defaults.

```bash
usegraph init ./my-project
```

---

## Data Flow

```
                  ┌──────────────────────────────────────────────────┐
                  │                  Source projects                  │
                  │   ./apps/web    ./apps/mobile    ./packages/docs  │
                  └──────────────────────┬───────────────────────────┘
                                         │  usegraph scan
                                         ▼
                  ┌──────────────────────────────────────────────────┐
                  │            ~/.usegraph/  (per-project JSON)       │
                  │   <slug>/scans/<uuid>.json   (one file per scan)  │
                  │   <slug>/latest.json         (symlink to newest)  │
                  └──────────────────────┬───────────────────────────┘
                                         │  usegraph build
                                         ▼
                  ┌──────────────────────────────────────────────────┐
                  │         ~/.usegraph/built/  (Parquet tables)      │
                  │   project_snapshots.parquet                       │
                  │   dependencies.parquet                            │
                  │   component_usages.parquet                        │
                  │   component_prop_usages.parquet                   │
                  │   function_usages.parquet                         │
                  │   function_arg_usages.parquet                     │
                  └──────────────────────┬───────────────────────────┘
                                         │  usegraph dashboard / mcp
                                         ▼
                  ┌──────────────────────────────────────────────────┐
                  │   Web dashboard  /  MCP server (13 tools)         │
                  │   Claude Desktop / Cursor / any MCP client        │
                  └──────────────────────────────────────────────────┘
```

## Configuration

Create a `usegraph.config.json` (or `.usegraphrc`) in your project root:

```json
{
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.test.*",
    "**/*.spec.*"
  ]
}
```

| Field     | Default                              | Description                        |
|-----------|--------------------------------------|------------------------------------|
| `include` | `["**/*.ts", "**/*.tsx", ...]`       | Glob patterns for files to include |
| `exclude` | `["**/node_modules/**", ...]`        | Glob patterns for files to exclude |

## Data Collected

### Component Usage

For each JSX component from a tracked package:
- Component name and source package
- File path, line number, column
- All props with their values (static literals and dynamic expressions)
- Source snippet (~5 lines of context) for dynamic values

```json
{
  "componentName": "Button",
  "importedFrom": "@acme/ui",
  "file": "src/pages/Login.tsx",
  "line": 42,
  "props": [
    { "name": "variant", "value": "primary", "isDynamic": false },
    { "name": "onClick", "value": "[ArrowFunctionExpression]", "isDynamic": true,
      "sourceSnippet": "onClick={() => handleSubmit()}" },
    { "name": "disabled", "value": true, "isDynamic": false }
  ]
}
```

### Function Call Usage

For each function call from a tracked package:
- Function name and source package
- File path, line number, column
- All arguments with type and literal value (when available)
- Source snippet for dynamic arguments

```json
{
  "functionName": "createTheme",
  "importedFrom": "@acme/ui",
  "file": "src/theme.ts",
  "line": 8,
  "args": [
    { "index": 0, "type": "object", "isSpread": false },
    { "index": 1, "type": "string", "value": "dark", "isSpread": false }
  ]
}
```

### Dependency Version Resolution

For every tracked package, usegraph resolves the **actual installed version** from the
project's lockfile (not just the semver range in `package.json`):

- Supports `package-lock.json` (npm), `pnpm-lock.yaml`, `yarn.lock` v1, `yarn.lock` Berry v2+
- Resolved version is stored alongside each component usage and function call
- Enables cross-project queries like *"which teams are still on v1?"*

### Tech Stack Detection

When running `scan`, usegraph also detects and records:
- **Package.json metadata**: name, version, all dependencies with version ranges
- **Tooling**: package manager, build tool, test framework, bundler, linter, formatter,
  CSS approach, TypeScript version, Node.js version, framework and framework version
- **Git metadata**: remote URL, current branch, commit SHA

This data is available in every Parquet table via `project_snapshots` and is queryable
via the `query_tooling_distribution` MCP tool.

## Storage Layout

Scan results are stored globally at `~/.usegraph/` by default. Override the root with the
`USEGRAPH_HOME` environment variable (useful for CI, testing, or isolating multiple
usegraph instances):

```bash
USEGRAPH_HOME=/tmp/my-org-data usegraph scan ./apps/web --packages @acme/ui
USEGRAPH_HOME=/tmp/my-org-data usegraph build
USEGRAPH_HOME=/tmp/my-org-data usegraph mcp
```

Directory layout:

```
$USEGRAPH_HOME/           # default: ~/.usegraph/
  <project-slug>/
    scans/
      <uuid>.json    # Full scan result (one file per scan)
    latest.json      # Copy of the most recent scan
  built/
    *.parquet        # Materialised tables (written by usegraph build)
```

Each scan result is a self-contained JSON file with the full analysis.
Old scans are retained for historical comparison.

## Requirements

- Node.js >= 18
- The scanned project does **not** need to be installed — only source files are read
- `usegraph build` and `usegraph mcp` require DuckDB binaries (installed with the package)

## Supported File Types

`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`

## Architecture

```
src/
  index.ts                  # CLI entry point (shebang + parse)
  cli.ts                    # Commander.js program definition
  types.ts                  # TypeScript interfaces
  config.ts                 # Config file loader (usegraph.config.json)
  storage.ts                # JSON persistence layer
  git-history.ts            # Git log walking for --since / --interval checkpoint scans
  parquet-query.ts          # Shared DuckDB query helpers
  analyzer/
    walker.ts               # Generic recursive SWC AST walker
    extractor.ts            # Import/JSX/call extraction from AST (with sourceSnippet)
    file-analyzer.ts        # Per-file SWC parse + extraction
    scanner.ts              # Project-wide parallel file scanning + lockfile resolution
    meta-analyzer.ts        # Package.json + tooling detection
    lockfile.ts             # Lockfile parsers: npm, pnpm, yarn v1, yarn Berry v2+
  commands/
    scan.ts                 # scan command handler
    build.ts                # build command — reads JSON scans, writes Parquet via DuckDB
    dashboard.ts            # dashboard command — launches Observable Framework dev server
    mcp.ts                  # mcp command — MCP server (13 tools, JSON-RPC 2.0 over stdio)
  dashboard/
    observablehq.config.js  # Observable Framework configuration
    pages/
      index.md              # Dashboard home (scan overview, project list)
      dependencies.md       # Dependency version explorer
      package-adoption.md   # Component / export adoption over time
      project-detail.md     # Per-project tooling and usage detail
      component-explorer.md # JSX prop explorer
      function-explorer.md  # Function argument explorer
```

## Local Development

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Type-check only (no emit)
pnpm lint

# Run unit and e2e tests
pnpm test

# Run dashboard Playwright tests (requires a build first)
pnpm build && pnpm test:dashboard

# Start the CLI in development mode (no build step needed)
pnpm dev -- scan ./path/to/project --packages some-package

# Start the dashboard dev server (hot-reload, requires usegraph build data)
pnpm dev:dashboard
```

> **Tip:** Set `USEGRAPH_HOME` to a temporary directory when developing to avoid
> polluting your real `~/.usegraph/` data:
> ```bash
> USEGRAPH_HOME=/tmp/usegraph-dev usegraph scan ./my-project --packages my-pkg
> USEGRAPH_HOME=/tmp/usegraph-dev usegraph build
> USEGRAPH_HOME=/tmp/usegraph-dev usegraph dashboard
> ```

## Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository and create a feature branch.
2. **Install** dependencies with `pnpm install`.
3. **Make** your changes, keeping commits focused and descriptive.
4. **Test** your changes:
   - `pnpm lint` — TypeScript type-check
   - `pnpm test` — unit and e2e tests
   - `pnpm build && pnpm test:dashboard` — if you touched the dashboard
5. **Open a pull request** against `main` with a clear description of the change
   and any relevant issue numbers.

Please keep pull requests small and focused. For larger changes, open an issue first
to discuss the approach.
