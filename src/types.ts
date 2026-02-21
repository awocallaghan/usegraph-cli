// --------------------------------------------------------------------------
// Core data types for usegraph-cli
// --------------------------------------------------------------------------

/** A single import specifier (named, default, or namespace) */
export interface ImportSpecifierInfo {
  /** Local binding name in the file */
  local: string;
  /** Original exported name (differs from local for `import { Foo as Bar }`) */
  imported: string;
  /** Type of import */
  type: 'named' | 'default' | 'namespace';
}

/** An import declaration found in a file */
export interface ImportInfo {
  /** Package or module path being imported from */
  source: string;
  /** Specifiers imported */
  specifiers: ImportSpecifierInfo[];
  /** True if it's a type-only import (`import type { ... }`) */
  typeOnly: boolean;
}

/** A JSX prop (attribute) value */
export interface PropInfo {
  name: string;
  /** Literal value when deterministic, '[expression]' when dynamic */
  value: string | number | boolean | null;
  /** True when the value is a JS expression (not a literal) */
  isDynamic: boolean;
  /** ~5 lines of source context around the usage site; null for static literals */
  sourceSnippet: string | null;
}

/** A single usage of a tracked JSX component */
export interface ComponentUsage {
  file: string;
  line: number;
  column: number;
  /** Component name as written in JSX (e.g. `Button`) */
  componentName: string;
  /** Package the component was imported from */
  importedFrom: string;
  props: PropInfo[];
  /** True when component is self-closing */
  selfClosing: boolean;
}

/** A single argument to a function call */
export interface ArgInfo {
  index: number;
  /** Simplified type label: 'string' | 'number' | 'boolean' | 'null' | 'undefined' |
   *  'object' | 'array' | 'function' | 'identifier' | 'expression' | 'spread' */
  type: string;
  /** Literal value (present for string/number/boolean literals) */
  value?: string | number | boolean;
  isSpread: boolean;
  /** ~5 lines of source context around the usage site; null for static literals */
  sourceSnippet: string | null;
}

/** A single call to a tracked function */
export interface FunctionCallInfo {
  file: string;
  line: number;
  column: number;
  /** Function name as written at the call site */
  functionName: string;
  /** Package the function was imported from */
  importedFrom: string;
  args: ArgInfo[];
}

/** All usage data extracted from a single source file */
export interface FileAnalysis {
  filePath: string;
  /** Path relative to the project root */
  relativePath: string;
  imports: ImportInfo[];
  componentUsages: ComponentUsage[];
  functionCalls: FunctionCallInfo[];
  /** Parse or analysis errors for this file */
  errors: string[];
}

/** Per-package summary inside a ScanResult */
export interface PackageSummary {
  totalComponentUsages: number;
  totalFunctionCalls: number;
  /** Unique files that reference this package */
  files: string[];
  /** Unique component names used */
  components: string[];
  /** Unique function names called */
  functions: string[];
}

/** High-level summary metrics for a scan */
export interface ScanSummary {
  totalFilesScanned: number;
  filesWithErrors: number;
  filesWithTargetUsage: number;
  totalComponentUsages: number;
  totalFunctionCalls: number;
  /** Per-package breakdown */
  byPackage: Record<string, PackageSummary>;
}

/** The full result of scanning a project */
export interface ScanResult {
  /** Unique ID for this scan (timestamp-based) */
  id: string;
  /** Schema version for forward-compatibility. 1 = current extended schema. */
  schemaVersion: number;
  projectPath: string;
  projectName: string;
  /** Stable cross-scan identity key (e.g. "github.com/org/repo" or "my-pkg") */
  projectSlug: string;
  scannedAt: string;
  /** Raw git remote URL (e.g. "https://github.com/org/repo.git"); null if unavailable */
  repoUrl: string | null;
  /** Current git branch name; null if unavailable */
  branch: string | null;
  /** Full git commit SHA; null if unavailable */
  commitSha: string | null;
  /** Verbatim parsed package.json; null if absent or unparseable */
  packageJson: Record<string, unknown> | null;
  /** Packages whose usage was tracked in detail */
  targetPackages: string[];
  fileCount: number;
  files: FileAnalysis[];
  summary: ScanSummary;
  /** Project metadata: package.json deps + detected tooling (optional, added by STRETCH analysis) */
  meta?: ProjectMeta;
  /** Number of files loaded from the incremental cache (0 when cache disabled or cold) */
  cacheHits?: number;
}

// --------------------------------------------------------------------------
// Dependency & tooling meta (STRETCH features)
// --------------------------------------------------------------------------

/** A single entry from package.json dependencies */
export interface DependencyEntry {
  name: string;
  /** Version range as written in package.json (e.g. "^18.0.0") */
  versionRange: string;
  /** Which section of package.json this came from */
  section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
}

/** Flat tooling detection result replacing the old ToolingInfo[] array */
export interface ToolingMeta {
  /** "npm" | "yarn" | "pnpm" | "bun" — detected by lockfile presence */
  packageManager: string | null;
  /** Package manager version (resolved from lockfile; populated in Phase 2) */
  packageManagerVersion: string | null;
  /** "vite" | "webpack" | "esbuild" | "rollup" */
  buildTool: string | null;
  /** "jest" | "vitest" | "mocha" | "jasmine" */
  testFramework: string | null;
  /** Bundler when distinct from buildTool (reserved; null for now) */
  bundler: string | null;
  /** "eslint" | "biome" | "oxlint" */
  linter: string | null;
  /** "prettier" | "biome" */
  formatter: string | null;
  /** "tailwind" | "css-modules" | "styled-components" | "emotion" */
  cssApproach: string | null;
  /** true if tsconfig.json present or typescript devDep found */
  typescript: boolean | null;
  /** TypeScript version range from package.json (resolved SHA in Phase 2) */
  typescriptVersion: string | null;
  /** Node version from .nvmrc / .node-version / package.json engines */
  nodeVersion: string | null;
  /** "next" | "nuxt" | "react" | "vue" | "angular" | "svelte" */
  framework: string | null;
  /** Framework version range from package.json */
  frameworkVersion: string | null;
}

/** Project metadata: package.json summary + detected tooling */
export interface ProjectMeta {
  /** name from package.json (empty string if not found) */
  packageName: string;
  /** version from package.json (empty string if not found) */
  packageVersion: string;
  /** All dependency entries (all sections combined) */
  dependencies: DependencyEntry[];
  /** Flat tooling detection result */
  tooling: ToolingMeta;
}

/** Configuration file schema (usegraph.config.json / .usegraphrc) */
export interface UsegraphConfig {
  /** Packages to analyse in detail */
  targetPackages: string[];
  /** Glob patterns for files to include (default: ts/tsx/js/jsx) */
  include: string[];
  /** Glob patterns for files to exclude */
  exclude: string[];
  /** Directory (relative to project root) where scan results are saved */
  outputDir: string;
}
