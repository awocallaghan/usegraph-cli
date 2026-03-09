# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CI template scanning: detect GitHub Actions (`.github/workflows/*.yml`) and GitLab CI (`.gitlab-ci.yml`) template/action usage across projects

## [0.1.1] - 2026-03-06

### Fixed
- Dashboard page-to-page links broken when served under a path prefix
- `usegraph dashboard` could not find the Observable binary when invoked via `npx`

## [0.1.0] - 2026-03-01

### Added
- `usegraph scan` — SWC-based AST scanner for React component props, function call arguments, and import patterns
- `usegraph build` — materialise scan results to Parquet tables via DuckDB
- `usegraph view` — terminal report querying Parquet tables
- `usegraph dashboard` — Observable Framework web dashboard with overview, dependencies, component explorer, function explorer, package adoption, and project detail pages
- `usegraph mcp` — MCP server over stdio with 13 tools for AI-assisted codebase analysis
- Incremental file-level cache keyed on mtime + size
- Lockfile parsing for npm (`package-lock.json`), pnpm (`pnpm-lock.yaml`), Yarn v1, and Yarn Berry
- Monorepo support: detects `package.json` and lockfiles in subdirectories
- Git history scanning with `--since` and carry-forward adoption trend queries
