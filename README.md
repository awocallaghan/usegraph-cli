# usegraph-cli

A CLI tool for analysing how npm packages are used across your projects.
Track React component props, function call arguments, import patterns, and more.
Collect tech-stack metadata to understand your organisation's tooling landscape.

## Features

- **Deep package usage analysis** via SWC AST parsing
  - JSX components: which components are used, with what props
  - Function calls: which functions are called, with what arguments
  - Import tracking: named, default, and namespace imports
- **Multi-project scanning**: run scans across many projects, save results to disk
- **Cross-project dashboard**: aggregate and compare usage data across all projects
- **Tech stack detection**: detect build tools, test frameworks, linters, and more
- **Dependency reporting**: count and categorise all npm dependencies

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

# 2. Scan a project
usegraph scan ./my-project --packages @my-org/design-system,react

# 3. View the report
usegraph report ./my-project --files
```

## Commands

### `usegraph scan [path]`

Scans a project directory and saves detailed package usage data.

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

### `usegraph init [path]`

Creates a `usegraph.config.json` in the project directory with sensible defaults.

```bash
usegraph init ./my-project
```

### `usegraph scans [path]`

Lists all saved scan IDs for a project.

```bash
usegraph scans ./my-project
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

```json
{
  "componentName": "Button",
  "importedFrom": "@acme/ui",
  "file": "src/pages/Login.tsx",
  "line": 42,
  "props": [
    { "name": "variant", "value": "primary", "isDynamic": false },
    { "name": "onClick", "value": "[ArrowFunctionExpression]", "isDynamic": true },
    { "name": "disabled", "value": true, "isDynamic": false }
  ]
}
```

### Function Call Usage

For each function call from a tracked package:
- Function name and source package
- File path, line number, column
- All arguments with type and literal value (when available)

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

### Tech Stack Detection (STRETCH)

When running `scan`, usegraph also detects and records:
- **Package.json metadata**: name, version, all dependencies with version ranges
- **Tooling config files**: TypeScript, ESLint, Prettier, Babel, Jest, Vitest, Vite,
  Webpack, Rollup, Next.js, Nuxt, Astro, SvelteKit, Playwright, Cypress, Storybook,
  Docker, Turborepo, Nx, Lerna, pnpm workspaces, and more

This data is shown in `usegraph report` and `usegraph dashboard`.

## Output Format

Scan results are stored in `<project>/.usegraph/`:

```
.usegraph/
  scans/
    <uuid>.json    # Full scan result (one file per scan)
  latest.json      # Copy of the most recent scan
```

Each scan result is a self-contained JSON file with the full analysis.
Old scans are retained for historical comparison.

## Requirements

- Node.js >= 18
- The scanned project does **not** need to be installed — only source files are read

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
    extractor.ts            # Import/JSX/call extraction from AST
    file-analyzer.ts        # Per-file SWC parse + extraction
    scanner.ts              # Project-wide parallel file scanning
    meta-analyzer.ts        # Package.json + tooling detection (STRETCH)
  commands/
    scan.ts                 # scan command handler
    report.ts               # report command handler
    dashboard.ts            # dashboard command handler
```

## Development

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Watch mode
pnpm build:watch

# Type-check only (no emit)
pnpm lint

# Run tests
pnpm test

# Run after building
node dist/index.js --help
```
