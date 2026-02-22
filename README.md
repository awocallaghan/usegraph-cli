# usegraph-cli

A CLI tool for analysing how npm packages are used across your projects and organisation.
Track React component props, function call arguments, import patterns, and more.
Collect tech-stack metadata to understand your organisation's tooling landscape.
Expose analysis results as an MCP server so AI assistants can query your data directly.

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
- **MCP server**: `usegraph mcp` exposes 13 tools over stdio so Claude (and other MCP clients)
  can query your organisation's usage data directly
- **Tech stack detection**: detect build tools, test frameworks, linters, package managers, and more
- **Dependency reporting**: count and categorise all npm dependencies with resolved versions

## Installation

```bash
# Install globally
npm install -g usegraph-cli

# Or use via npx
npx usegraph-cli scan
```

## Quick Start

```bash
# 1. (Optional) Create a config file specifying which packages to track
usegraph init ./my-project

# 2. Scan one or more projects
usegraph scan ./apps/web --packages @acme/ui,@acme/utils
usegraph scan ./apps/mobile --packages @acme/ui,@acme/utils

# 3. Build Parquet tables from all scans
usegraph build

# 4. Query via the terminal report
usegraph report ./apps/web --files

# 5. Or launch an MCP server for AI-assisted analysis
usegraph mcp
```

## Commands

### `usegraph scan [path]`

Scans a project directory and saves detailed package usage data to `~/.usegraph/`.

```
Options:
  -p, --packages <packages>    Comma-separated list of packages to track
  -c, --config <path>          Path to usegraph config file
  -o, --output <dir>           Output directory for results (default: .usegraph)
  --concurrency <n>            Number of files to analyse in parallel (default: 8)
  --json                       Print raw JSON result to stdout instead of saving
```

**Examples:**

```bash
# Scan current directory, tracking a design system package
usegraph scan --packages @acme/ui

# Scan a specific project
usegraph scan ./packages/web-app --packages @acme/ui,@acme/icons

# Track all imports (no filter)
usegraph scan ./my-project

# Stream JSON output for further processing
usegraph scan ./my-project --packages react --json | jq '.summary'
```

---

### `usegraph build [--rebuild]`

Reads all scan JSON files from `~/.usegraph/` and materialises 6 typed Parquet tables
in `~/.usegraph/built/` using DuckDB. Run this after scanning to prepare data for
`usegraph mcp`.

```
Options:
  --rebuild    Drop and recreate all tables (default: incremental — skips existing rows)
```

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

# Rebuild everything from scratch
usegraph build --rebuild
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

### `usegraph report [path]`

Displays a formatted terminal report for the latest (or a specific) scan.

```
Options:
  -s, --scan <id>              Load a specific scan by ID instead of the latest
  --package <package>          Filter output to a single package
  -o, --output <dir>           Output directory where results are stored (default: .usegraph)
  --files                      Show file-level usage breakdown with props/args
  --json                       Print raw JSON to stdout
```

**Examples:**

```bash
# Show summary report for the latest scan
usegraph report ./my-project

# Show detailed file-level breakdown
usegraph report ./my-project --files

# Filter to a specific package
usegraph report ./my-project --package @acme/ui --files

# View a previous scan by ID
usegraph report ./my-project --scan <scan-id>

# Export as JSON
usegraph report ./my-project --json > report.json
```

---

### `usegraph dashboard [paths...]`

Displays an aggregated dashboard across one or more projects. Compares component
usage, function calls, and tech stack configuration across your organisation.

```
Options:
  --package <package>          Filter to a specific package
  -o, --output <dir>           Scan output dir within each project (default: .usegraph)
  --json                       Print raw JSON to stdout
```

**Examples:**

```bash
# Dashboard for multiple projects
usegraph dashboard ./apps/web ./apps/mobile ./packages/docs

# Filter to a single package across projects
usegraph dashboard ./apps/web ./apps/mobile --package @acme/ui

# Export aggregated JSON
usegraph dashboard ./apps/web ./apps/mobile --json > dashboard.json
```

---

### `usegraph init [path]`

Creates a `usegraph.config.json` in the project directory with sensible defaults.

```bash
usegraph init ./my-project
```

---

### `usegraph scans [path]`

Lists all saved scan IDs for a project.

```bash
usegraph scans ./my-project
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
                                         │  usegraph mcp
                                         ▼
                  ┌──────────────────────────────────────────────────┐
                  │        MCP server (13 tools over stdio)           │
                  │   Claude Desktop / Cursor / any MCP client        │
                  └──────────────────────────────────────────────────┘
```

## Configuration

Create a `usegraph.config.json` (or `.usegraphrc`) in your project root:

```json
{
  "targetPackages": ["@acme/ui", "@acme/icons"],
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.test.*",
    "**/*.spec.*"
  ],
  "outputDir": ".usegraph"
}
```

| Field            | Default                              | Description                                       |
|------------------|--------------------------------------|---------------------------------------------------|
| `targetPackages` | `[]` (all packages)                  | Packages to analyse in detail                     |
| `include`        | `["**/*.ts", "**/*.tsx", ...]`       | Glob patterns for files to include                |
| `exclude`        | `["**/node_modules/**", ...]`        | Glob patterns for files to exclude                |
| `outputDir`      | `.usegraph`                          | Directory to save scan results (relative to root) |

When `targetPackages` is empty, **all** imported packages are tracked.

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
  analyzer/
    walker.ts               # Generic recursive SWC AST walker
    extractor.ts            # Import/JSX/call extraction from AST (with sourceSnippet)
    file-analyzer.ts        # Per-file SWC parse + extraction
    scanner.ts              # Project-wide parallel file scanning + lockfile resolution
    meta-analyzer.ts        # Package.json + tooling detection
    lockfile.ts             # Lockfile parsers: npm, pnpm, yarn v1, yarn Berry v2+
  commands/
    scan.ts                 # scan command handler
    report.ts               # report command handler
    dashboard.ts            # dashboard command handler
    build.ts                # build command — reads JSON scans, writes Parquet via DuckDB
    mcp.ts                  # mcp command — MCP server (13 tools, JSON-RPC 2.0 over stdio)
```

## Development

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Type-check only (no emit)
node node_modules/typescript/bin/tsc --noEmit

# Run tests
pnpm test
# or: node --test tests/*.test.js

# Run after building
node dist/index.js --help
```
