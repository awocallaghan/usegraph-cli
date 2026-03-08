/**
 * CI configuration file parser.
 *
 * Supports:
 *   - GitHub Actions workflows (.github/workflows/*.yml / *.yaml)
 *   - GitLab CI (.gitlab-ci.yml)
 *
 * Returns a flat list of CiTemplateUsage records for every template/action
 * reference found in those files.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import jsYaml from 'js-yaml';
import type { CiTemplateUsage, CiTemplateInput } from '../types.js';

export interface CiParseResult {
  usages: CiTemplateUsage[];
  errors: string[];
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Scan a project directory for CI configuration files and return all
 * template usage records found.  Errors during YAML parsing are collected
 * rather than thrown so that a single bad file does not abort the scan.
 */
export function parseCiFiles(projectPath: string): CiParseResult {
  const usages: CiTemplateUsage[] = [];
  const errors: string[] = [];

  parseGitHubActions(projectPath, usages, errors);
  parseGitLabCi(projectPath, usages, errors);

  return { usages, errors };
}

// ─── GitHub Actions ────────────────────────────────────────────────────────────

function parseGitHubActions(
  projectPath: string,
  usages: CiTemplateUsage[],
  errors: string[],
): void {
  const workflowsDir = join(projectPath, '.github', 'workflows');
  if (!existsSync(workflowsDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(workflowsDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
    const fullPath = join(workflowsDir, entry);
    const relPath = relative(projectPath, fullPath);

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      errors.push(`${relPath}: could not read file`);
      continue;
    }

    let doc: unknown;
    try {
      doc = jsYaml.load(content);
    } catch (err) {
      errors.push(`${relPath}: YAML parse error — ${(err as Error).message}`);
      continue;
    }

    if (!doc || typeof doc !== 'object') continue;

    const lines = content.split('\n');
    parseWorkflowDoc(doc as Record<string, unknown>, relPath, lines, usages);
  }
}

function parseWorkflowDoc(
  doc: Record<string, unknown>,
  filePath: string,
  lines: string[],
  usages: CiTemplateUsage[],
): void {
  const jobs = doc['jobs'];
  if (!jobs || typeof jobs !== 'object') return;

  for (const [, job] of Object.entries(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== 'object') continue;
    const jobObj = job as Record<string, unknown>;

    // Reusable workflow call: `uses:` at the job level
    if (typeof jobObj['uses'] === 'string') {
      const usesValue = jobObj['uses'] as string;
      const { source, version } = parseGitHubUsesRef(usesValue);
      const line = findLineContaining(lines, usesValue);
      const inputs = extractGitHubInputs(jobObj);
      usages.push({
        file: filePath,
        line,
        provider: 'github',
        templateType: 'reusable_workflow',
        source,
        version,
        inputs,
      });
    }

    // Action steps: `steps[].uses:`
    const steps = jobObj['steps'];
    if (!Array.isArray(steps)) continue;

    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      const stepObj = step as Record<string, unknown>;
      if (typeof stepObj['uses'] !== 'string') continue;

      const usesValue = stepObj['uses'] as string;
      const { source, version } = parseGitHubUsesRef(usesValue);
      const templateType = classifyGitHubUses(usesValue);
      const line = findLineContaining(lines, usesValue);
      const inputs = extractGitHubInputs(stepObj);

      usages.push({
        file: filePath,
        line,
        provider: 'github',
        templateType,
        source,
        version,
        inputs,
      });
    }
  }
}

/**
 * Split an `owner/repo@ref` or `owner/repo/.github/workflows/X.yml@ref` ref
 * into source + version parts.
 */
function parseGitHubUsesRef(ref: string): { source: string; version: string | null } {
  const atIdx = ref.lastIndexOf('@');
  if (atIdx === -1) return { source: ref, version: null };
  return {
    source: ref.slice(0, atIdx),
    version: ref.slice(atIdx + 1) || null,
  };
}

/** Classify a GitHub `uses:` value as action or reusable_workflow. */
function classifyGitHubUses(ref: string): CiTemplateUsage['templateType'] {
  const source = ref.includes('@') ? ref.slice(0, ref.lastIndexOf('@')) : ref;
  // Reusable workflows contain a path component ending in .yml / .yaml
  if (source.includes('/') && (source.includes('.yml') || source.includes('.yaml'))) {
    return 'reusable_workflow';
  }
  return 'action';
}

/** Extract `with:` block as CiTemplateInput[]. */
function extractGitHubInputs(block: Record<string, unknown>): CiTemplateInput[] {
  const withBlock = block['with'];
  if (!withBlock || typeof withBlock !== 'object') return [];
  return Object.entries(withBlock as Record<string, unknown>).map(([name, val]) => {
    const raw = val !== null && val !== undefined ? String(val) : null;
    const isDynamic = raw !== null && /\$\{\{/.test(raw);
    return {
      name,
      value: isDynamic ? null : raw,
      isDynamic,
    };
  });
}

// ─── GitLab CI ────────────────────────────────────────────────────────────────

function parseGitLabCi(
  projectPath: string,
  usages: CiTemplateUsage[],
  errors: string[],
): void {
  const ciFile = join(projectPath, '.gitlab-ci.yml');
  if (!existsSync(ciFile)) return;

  const relPath = relative(projectPath, ciFile);

  let content: string;
  try {
    content = readFileSync(ciFile, 'utf-8');
  } catch {
    errors.push(`${relPath}: could not read file`);
    return;
  }

  let doc: unknown;
  try {
    doc = jsYaml.load(content);
  } catch (err) {
    errors.push(`${relPath}: YAML parse error — ${(err as Error).message}`);
    return;
  }

  if (!doc || typeof doc !== 'object') return;

  const lines = content.split('\n');
  const docObj = doc as Record<string, unknown>;

  const includes = docObj['include'];
  if (!includes) return;

  // `include:` can be a single object or an array
  const includeList: unknown[] = Array.isArray(includes) ? includes : [includes];

  for (const inc of includeList) {
    if (!inc || typeof inc !== 'object') continue;
    const incObj = inc as Record<string, unknown>;
    parseGitLabInclude(incObj, relPath, lines, usages);
  }
}

function parseGitLabInclude(
  inc: Record<string, unknown>,
  filePath: string,
  lines: string[],
  usages: CiTemplateUsage[],
): void {
  // Shared inputs / variables block for all variants
  const inputs = extractGitLabInputs(inc);

  // Component: { component: "group/project/component-name@version" }
  if (typeof inc['component'] === 'string') {
    const compRef = inc['component'] as string;
    const atIdx = compRef.lastIndexOf('@');
    const source = atIdx !== -1 ? compRef.slice(0, atIdx) : compRef;
    const version = atIdx !== -1 ? compRef.slice(atIdx + 1) || null : null;
    const line = findLineContaining(lines, compRef);
    usages.push({
      file: filePath,
      line,
      provider: 'gitlab',
      templateType: 'gitlab_component',
      source,
      version,
      inputs,
    });
    return;
  }

  // Template: { template: "Auto-DevOps.gitlab-ci.yml" }
  if (typeof inc['template'] === 'string') {
    const tmpl = inc['template'] as string;
    const line = findLineContaining(lines, tmpl);
    usages.push({
      file: filePath,
      line,
      provider: 'gitlab',
      templateType: 'gitlab_template',
      source: tmpl,
      version: null,
      inputs,
    });
    return;
  }

  // Local include: { local: "/path/to/file.yml" }
  if (typeof inc['local'] === 'string') {
    const localPath = inc['local'] as string;
    const line = findLineContaining(lines, localPath);
    usages.push({
      file: filePath,
      line,
      provider: 'gitlab',
      templateType: 'gitlab_local_include',
      source: localPath,
      version: null,
      inputs,
    });
    return;
  }

  // Project include: { project: "...", ref: "...", file: "..." | ["..."] }
  if (typeof inc['project'] === 'string') {
    const project = inc['project'] as string;
    const ref = typeof inc['ref'] === 'string' ? (inc['ref'] as string) : null;
    const fileField = inc['file'];

    // `file` may be a string or an array of strings
    const files: string[] = Array.isArray(fileField)
      ? (fileField as unknown[]).filter((f) => typeof f === 'string') as string[]
      : typeof fileField === 'string'
        ? [fileField as string]
        : [''];

    for (const f of files) {
      const source = f ? `${project}/${f}` : project;
      const line = f ? findLineContaining(lines, f) : findLineContaining(lines, project);
      usages.push({
        file: filePath,
        line,
        provider: 'gitlab',
        templateType: 'gitlab_project_include',
        source,
        version: ref,
        inputs,
      });
    }
  }
}

/** Extract GitLab `inputs:` and `variables:` blocks as CiTemplateInput[]. */
function extractGitLabInputs(inc: Record<string, unknown>): CiTemplateInput[] {
  const result: CiTemplateInput[] = [];

  const inputsBlock = inc['inputs'];
  if (inputsBlock && typeof inputsBlock === 'object' && !Array.isArray(inputsBlock)) {
    for (const [name, val] of Object.entries(inputsBlock as Record<string, unknown>)) {
      const raw = val !== null && val !== undefined ? String(val) : null;
      const isDynamic = raw !== null && /\$\{?\{|^\$[A-Z_]/.test(raw);
      result.push({ name, value: isDynamic ? null : raw, isDynamic });
    }
  }

  const varsBlock = inc['variables'];
  if (varsBlock && typeof varsBlock === 'object' && !Array.isArray(varsBlock)) {
    for (const [name, val] of Object.entries(varsBlock as Record<string, unknown>)) {
      const raw = val !== null && val !== undefined ? String(val) : null;
      const isDynamic = raw !== null && /^\$\{?[A-Z_]/.test(raw);
      result.push({ name, value: isDynamic ? null : raw, isDynamic });
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the 1-indexed line number of the first line containing `needle`.
 * Returns 0 when not found.
 */
function findLineContaining(lines: string[], needle: string): number {
  const trimmed = needle.trim();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(trimmed)) return i + 1;
  }
  return 0;
}
