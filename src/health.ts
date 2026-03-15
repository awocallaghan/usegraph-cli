/**
 * Types for the get_package_health MCP tool.
 *
 * Represents structured, pre-aggregated data comparing a package's usage
 * across two consecutive time periods (A = older half, B = newer half).
 * Designed to be interpreted by an LLM via the monthly_package_digest prompt.
 */

// ─── Call-site detail types ────────────────────────────────────────────────────

/** Detail about a single function argument at a call site */
export interface ArgDetail {
  index: number;
  /** 'static' for literal values; 'dynamic' for expressions/identifiers */
  type: string;
  /** Literal value if static and non-sensitive; omitted for dynamic args */
  value?: string;
}

/** A single component or function usage site */
export interface UsageSite {
  /** project_id (project slug) */
  project: string;
  /** Relative file path within the project */
  file: string;
  line: number;
  /** Component sites only: prop names present (not values) */
  props?: string[];
  /** Function sites only: argument details */
  args?: ArgDetail[];
}

// ─── Delta types ────────────────────────────────────────────────────────────────

/** Per-component or per-function diff between period A and period B */
export interface ComponentDelta {
  /** component_name or export_name */
  name: string;
  kind: 'component' | 'function';
  /** Sites in period B not in period A */
  added: UsageSite[];
  /** Sites in period A not in period B */
  removed: UsageSite[];
  /** Count of sites present in both periods (not the full list) */
  stable: number;
}

// ─── Version types ─────────────────────────────────────────────────────────────

/** Version bucket for distribution reporting */
export interface VersionBucket {
  version: string;
  count: number;
  /** project_ids using this version */
  projects: string[];
}

// ─── Top-level result type ─────────────────────────────────────────────────────

/** Full health report for a package across two time periods */
export interface PackageHealthResult {
  package: string;
  language: 'js' | 'python' | 'mixed';
  generatedAt: string;

  /** The full time window split into A (older) and B (newer) */
  period: {
    from: string;
    to: string;
  };

  /**
   * Corpus classification.
   * - stable: projects scanned in both periods (used for all delta calculations)
   * - addedProjects: new to corpus in period B — excluded from deltas
   * - removedProjects: not scanned in period B — excluded from deltas
   */
  corpus: {
    stable: number;
    addedProjects: string[];
    removedProjects: string[];
  };

  /** Adoption counts within the stable corpus only */
  adoption: {
    /** Projects using the package in period A */
    start: number;
    /** Projects using the package in period B */
    end: number;
    /** end - start */
    delta: number;
    /** Stable corpus projects that gained the package between periods */
    newAdopters: string[];
    /** Stable corpus projects that dropped the package between periods */
    churned: string[];
  };

  versions: {
    /** Resolved version distribution (latest scan per project) */
    distribution: VersionBucket[];
    /** Projects more than 1 major version behind the highest seen major */
    lagging: string[];
    /** Projects on alpha/beta/rc builds */
    prerelease: string[];
  };

  componentChanges: {
    summary: {
      componentsWithAdditions: number;
      componentsWithRemovals: number;
      functionsWithAdditions: number;
      functionsWithRemovals: number;
      totalAddedSites: number;
      totalRemovedSites: number;
    };
    /** Components and functions with at least one addition or removal */
    deltas: ComponentDelta[];
    /** Names of components/functions with zero churn between periods */
    unchanged: string[];
  };

  /** Scan coverage relative to all projects ever seen for this package */
  coverage: {
    projectsCovered: number;
    projectsExpected: number;
    /** Projects with no scan data in the period */
    gaps: string[];
    /** Populated when projectsCovered / projectsExpected < 0.8 */
    warning?: string;
  };
}
