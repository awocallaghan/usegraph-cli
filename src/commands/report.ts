/**
 * `usegraph report` command
 *
 * Usage:
 *   usegraph report [path]
 *     --scan <id>        specific scan ID to load
 *     --package <pkg>    filter output to one package
 *     --output <dir>     output dir (default: .usegraph)
 *     --json             print raw JSON to stdout
 *     --files            show file-level breakdown
 */
import chalk from 'chalk';
import { resolve } from 'path';
import { loadConfig } from '../config';
import { computeProjectSlug } from '../analyzer/project-identity';
import { createStorageBackend } from '../storage/index';
import type { ScanResult, ComponentUsage, FunctionCallInfo } from '../types';

export interface ReportCommandOptions {
  scan?: string;
  package?: string;
  output?: string;
  json?: boolean;
  files?: boolean;
}

export async function runReport(projectPathArg: string | undefined, opts: ReportCommandOptions): Promise<void> {
  const projectPath = resolve(projectPathArg ?? process.cwd());
  const config = loadConfig(projectPath);
  const projectSlug = computeProjectSlug(projectPath);
  const backend = createStorageBackend(projectPath, projectSlug, opts, config);

  let result: ScanResult | null;
  if (opts.scan) {
    result = backend.load(opts.scan);
    if (!result) {
      console.error(chalk.red(`Scan "${opts.scan}" not found in ${backend.getCacheDir()}`));
      process.exit(1);
    }
  } else {
    result = backend.loadLatest();
    if (!result) {
      console.error(chalk.red(`No scan results found in ${backend.getCacheDir()}`));
      console.error(chalk.dim(`Run ${chalk.bold('usegraph scan')} first.`));
      process.exit(1);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printReport(result, opts);
}

function printReport(result: ScanResult, opts: ReportCommandOptions): void {
  const { summary } = result;
  const pkgFilter = opts.package;

  // ── Header ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold.blue('╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.blue('║       usegraph usage report              ║'));
  console.log(chalk.bold.blue('╚══════════════════════════════════════════╝'));
  console.log('');
  console.log(`  Project:      ${chalk.bold(result.projectName)}`);
  console.log(`  Path:         ${result.projectPath}`);
  console.log(`  Scanned:      ${new Date(result.scannedAt).toLocaleString()}`);
  console.log(`  Scan ID:      ${chalk.dim(result.id)}`);
  if (result.targetPackages.length > 0) {
    console.log(`  Tracking:     ${result.targetPackages.join(', ')}`);
  }
  console.log('');

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(chalk.bold('Summary'));
  console.log(`  ${chalk.white(String(summary.totalFilesScanned).padStart(6))}  files scanned`);
  console.log(`  ${chalk.white(String(summary.filesWithTargetUsage).padStart(6))}  files with tracked usage`);
  console.log(`  ${chalk.white(String(summary.totalComponentUsages).padStart(6))}  component usages`);
  console.log(`  ${chalk.white(String(summary.totalFunctionCalls).padStart(6))}  function calls`);
  if (summary.filesWithErrors > 0) {
    console.log(`  ${chalk.yellow(String(summary.filesWithErrors).padStart(6))}  files with parse errors`);
  }
  console.log('');

  // ── Per-package breakdown ────────────────────────────────────────────────
  const packages = Object.entries(summary.byPackage).filter(
    ([pkg]) => !pkgFilter || pkg === pkgFilter,
  );

  if (packages.length === 0) {
    console.log(chalk.dim('  No tracked package usage found.'));
    return;
  }

  for (const [pkg, pkgSummary] of packages) {
    console.log(chalk.bold.cyan(`Package: ${pkg}`));
    console.log(
      `  Components: ${pkgSummary.totalComponentUsages}  ·  Functions: ${pkgSummary.totalFunctionCalls}  ·  Files: ${pkgSummary.files.length}`,
    );
    console.log('');

    // -- Component usages --
    if (pkgSummary.components.length > 0) {
      console.log(chalk.bold('  Components used:'));
      const byComponent = groupComponentsByName(result, pkg);
      for (const [name, usages] of byComponent) {
        console.log(`    ${chalk.green(name)}  (${usages.length} usage${usages.length !== 1 ? 's' : ''})`);
        if (opts.files) {
          // Show files and props
          for (const u of usages.slice(0, 10)) {
            console.log(`      ${chalk.dim(`${u.file}:${u.line}`)}`);
            if (u.props.length > 0) {
              const propStr = u.props
                .map((p) => `${p.name}=${p.isDynamic ? chalk.italic(String(p.value)) : chalk.yellow(JSON.stringify(p.value))}`)
                .join(' ');
              console.log(`        ${chalk.dim('props:')} ${propStr}`);
            }
          }
          if (usages.length > 10) {
            console.log(`      ${chalk.dim(`... and ${usages.length - 10} more`)}`);
          }
        }
      }
      console.log('');
    }

    // -- Function calls --
    if (pkgSummary.functions.length > 0) {
      console.log(chalk.bold('  Functions called:'));
      const byFunction = groupFunctionsByName(result, pkg);
      for (const [name, calls] of byFunction) {
        console.log(`    ${chalk.green(name)}  (${calls.length} call${calls.length !== 1 ? 's' : ''})`);
        if (opts.files) {
          for (const c of calls.slice(0, 10)) {
            console.log(`      ${chalk.dim(`${c.file}:${c.line}`)}`);
            if (c.args.length > 0) {
              const argStr = c.args
                .map((a) => (a.value !== undefined ? JSON.stringify(a.value) : `[${a.type}]`))
                .join(', ');
              console.log(`        ${chalk.dim('args:')} ${argStr}`);
            }
          }
          if (calls.length > 10) {
            console.log(`      ${chalk.dim(`... and ${calls.length - 10} more`)}`);
          }
        }
      }
      console.log('');
    }

    // -- File list --
    if (opts.files && pkgSummary.files.length > 0) {
      console.log(chalk.bold('  Files:'));
      pkgSummary.files.slice(0, 20).forEach((f) => console.log(`    ${chalk.dim(f)}`));
      if (pkgSummary.files.length > 20) {
        console.log(`    ${chalk.dim(`... and ${pkgSummary.files.length - 20} more`)}`);
      }
      console.log('');
    }
  }

  // ── Prop frequency analysis ──────────────────────────────────────────────
  const allComponents = result.files.flatMap((f) =>
    f.componentUsages.filter((u) => !pkgFilter || u.importedFrom === pkgFilter),
  );
  if (allComponents.length > 0) {
    const propFreq = buildPropFrequency(allComponents);
    if (propFreq.length > 0) {
      console.log(chalk.bold('Most common props (across all components):'));
      propFreq.slice(0, 15).forEach(({ prop, count }) => {
        const bar = '█'.repeat(Math.min(20, Math.round((count / propFreq[0].count) * 20)));
        console.log(`  ${prop.padEnd(30)} ${chalk.blue(bar)} ${count}`);
      });
      console.log('');
    }
  }

  // ── Project meta (dependencies + tooling) ───────────────────────────────
  if (result.meta && !pkgFilter) {
    const { meta } = result;

    if (meta.tooling.length > 0) {
      console.log(chalk.bold('Detected tooling:'));
      for (const tool of meta.tooling) {
        console.log(`  ${chalk.green('✓')} ${tool.name.padEnd(20)} ${chalk.dim(tool.configFile)}`);
      }
      console.log('');
    }

    if (meta.dependencies.length > 0) {
      const deps = meta.dependencies.filter((d) => d.section === 'dependencies');
      const devDeps = meta.dependencies.filter((d) => d.section === 'devDependencies');
      console.log(chalk.bold('Dependencies:'));
      console.log(`  ${deps.length} production  ·  ${devDeps.length} dev  ·  ${meta.dependencies.length} total`);
      console.log('');
    }
  }

  // ── Available scans hint ─────────────────────────────────────────────────
  console.log(chalk.dim('Tip: use --files for file-level breakdown, --package <name> to filter by package.'));
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function groupComponentsByName(
  result: ScanResult,
  pkg: string,
): Map<string, ComponentUsage[]> {
  const map = new Map<string, ComponentUsage[]>();
  for (const file of result.files) {
    for (const usage of file.componentUsages) {
      if (usage.importedFrom !== pkg) continue;
      if (!map.has(usage.componentName)) map.set(usage.componentName, []);
      map.get(usage.componentName)!.push(usage);
    }
  }
  return new Map([...map.entries()].sort((a, b) => b[1].length - a[1].length));
}

function groupFunctionsByName(
  result: ScanResult,
  pkg: string,
): Map<string, FunctionCallInfo[]> {
  const map = new Map<string, FunctionCallInfo[]>();
  for (const file of result.files) {
    for (const call of file.functionCalls) {
      if (call.importedFrom !== pkg) continue;
      if (!map.has(call.functionName)) map.set(call.functionName, []);
      map.get(call.functionName)!.push(call);
    }
  }
  return new Map([...map.entries()].sort((a, b) => b[1].length - a[1].length));
}

function buildPropFrequency(usages: ComponentUsage[]): Array<{ prop: string; count: number }> {
  const freq = new Map<string, number>();
  for (const u of usages) {
    for (const p of u.props) {
      const key = `${u.componentName}#${p.name}`;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([prop, count]) => ({ prop, count }));
}
