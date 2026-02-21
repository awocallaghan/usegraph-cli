/**
 * `usegraph serve` command
 *
 * Starts a local HTTP server that serves a browser-based dashboard for
 * visualising scan results from one or more projects.  No extra dependencies –
 * only Node's built-in `http` module is used.  All data is embedded directly
 * in the served HTML so the page works without a back-end API.
 *
 * Usage:
 *   usegraph serve [paths...]
 *     --port <n>    Port to listen on (default: 3000)
 *     --output <d>  Scan output dir within each project (default: .usegraph)
 */
import * as http from 'http';
import { resolve } from 'path';
import chalk from 'chalk';
import { loadConfig } from '../config';
import { computeProjectSlug } from '../analyzer/project-identity';
import { createStorageBackend } from '../storage/index';
import type { ScanResult } from '../types';

export interface ServeCommandOptions {
  port?: string;
  output?: string;
  open?: boolean;
}

export async function runServe(
  projectPaths: string[],
  opts: ServeCommandOptions,
): Promise<void> {
  const paths = projectPaths.length > 0 ? projectPaths : [process.cwd()];
  const port = parseInt(opts.port ?? '3000', 10) || 3000;

  const results: ScanResult[] = [];
  for (const p of paths) {
    const projectPath = resolve(p);
    const config = loadConfig(projectPath);
    const projectSlug = computeProjectSlug(projectPath);
    const backend = createStorageBackend(projectPath, projectSlug, opts, config);
    const result = backend.loadLatest();
    if (result) {
      results.push(result);
    } else {
      console.warn(
        chalk.yellow(`  No scan results found for ${projectPath}. Run usegraph scan first.`),
      );
    }
  }

  if (results.length === 0) {
    console.error(chalk.red('No scan data available. Run usegraph scan on at least one project.'));
    process.exit(1);
  }

  const html = buildDashboardHtml(results);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  const url = `http://localhost:${port}`;

  await new Promise<void>((serverReady) => {
    server.listen(port, () => {
      console.log('');
      console.log(chalk.bold.cyan('  usegraph · web dashboard'));
      console.log(`  ${results.length} project${results.length !== 1 ? 's' : ''} loaded`);
      console.log('');
      console.log(`  Open: ${chalk.bold.underline(url)}`);
      console.log('');
      console.log(chalk.dim('  Press Ctrl+C to stop the server.'));
      serverReady();
    });
  });

  if (opts.open) {
    openBrowser(url);
  }

  // Keep the server alive until interrupted
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  await new Promise<void>(() => { /* intentionally never resolves */ });
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser launcher
// ─────────────────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const { execSync } = require('child_process') as typeof import('child_process');
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execSync(`cmd.exe /c start "" "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch {
    // Silently ignore – user can open the URL manually
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML Dashboard Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildDashboardHtml(results: ScanResult[]): string {
  // Safely embed JSON – prevent </script> from breaking out of the script tag
  const jsonData = JSON.stringify(results)
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<!--/g, '<\\!--');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>usegraph dashboard</title>
<style>
${DASHBOARD_CSS}
</style>
</head>
<body>
<script>var DATA = ${jsonData};</script>
<div id="app"></div>
<script>
${DASHBOARD_JS}
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedded CSS (dark theme, no external resources)
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f172a;
  --surface: #1e293b;
  --surface2: #243047;
  --border: #334155;
  --text: #e2e8f0;
  --text-dim: #94a3b8;
  --accent: #38bdf8;
  --green: #4ade80;
  --purple: #a78bfa;
  --red: #f87171;
  --yellow: #fbbf24;
}
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
#app { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }

/* Header */
.header {
  display: flex; align-items: center; gap: 16px;
  margin-bottom: 28px; padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.logo { font-size: 22px; font-weight: 700; color: var(--accent); letter-spacing: -0.5px; }
.header-meta { color: var(--text-dim); font-size: 13px; }

/* Stat cards */
.stats-row {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 16px; margin-bottom: 32px;
}
.stat-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 20px;
}
.stat-value { font-size: 30px; font-weight: 700; color: var(--accent); line-height: 1; margin-bottom: 6px; }
.stat-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }

/* Project cards */
.project-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; margin-bottom: 16px; overflow: hidden;
}
.project-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; cursor: pointer; user-select: none; transition: background 0.1s;
}
.project-head:hover { background: var(--surface2); }
.project-name { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
.project-path { color: var(--text-dim); font-size: 11px; font-family: 'Courier New', monospace; }
.project-stats { display: flex; gap: 20px; color: var(--text-dim); font-size: 13px; }
.project-stats strong { color: var(--text); font-weight: 600; }
.chevron { color: var(--text-dim); font-size: 11px; transition: transform 0.15s; margin-left: 8px; }
.collapsed .chevron { transform: rotate(-90deg); }
.project-body { padding: 0 20px 20px; border-top: 1px solid var(--border); }
.collapsed .project-body { display: none; }

/* No-data note */
.no-data { color: var(--text-dim); font-style: italic; padding: 12px 0; font-size: 13px; }

/* Package block */
.pkg-block { margin-top: 16px; }
.pkg-label {
  font-size: 11px; font-weight: 700; color: var(--purple);
  text-transform: uppercase; letter-spacing: 0.1em;
  margin-bottom: 10px; padding: 4px 0;
  border-bottom: 1px solid var(--border);
}
.tables-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }

/* Tables */
.section-title {
  font-size: 11px; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
}
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; color: var(--text-dim); font-weight: 500;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 6px 8px; border-bottom: 1px solid var(--border);
}
td { padding: 5px 8px; border-bottom: 1px solid rgba(51,65,85,0.4); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
.name-cell { font-family: 'Courier New', monospace; }
.bar-cell { width: 130px; }
.bar-wrap { background: rgba(255,255,255,0.06); border-radius: 3px; height: 6px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; background: var(--accent); }
.bar-fill.fn { background: var(--purple); }
.more-row td { color: var(--text-dim); font-size: 12px; }

/* Prop tag pills */
.prop-tag {
  display: inline-block;
  background: rgba(167,139,250,0.15);
  color: var(--purple);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
  font-family: 'Courier New', monospace;
  margin-right: 4px;
  margin-bottom: 2px;
}

/* Tooling / dep section */
.tooling-section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 20px; margin-top: 24px;
}
h2 { font-size: 15px; font-weight: 600; margin-bottom: 14px; }
.check { color: var(--green); }
.dash  { color: var(--text-dim); }
.section-gap { margin-top: 20px; }

/* Responsive */
@media (max-width: 680px) {
  .stats-row { grid-template-columns: 1fr; }
  .tables-grid { grid-template-columns: 1fr; }
  .project-stats { flex-wrap: wrap; gap: 10px; }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Embedded client-side JavaScript
// Note: deliberately uses ES5-style loops and string concatenation so that
// this constant can live inside a TypeScript template literal without any
// ${ ... } template-literal collisions.
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD_JS = `
(function () {
  'use strict';
  var data = DATA;
  var app = document.getElementById('app');
  if (!app) return;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Totals ── */
  var totalFiles = 0, totalComponents = 0, totalCalls = 0;
  for (var i = 0; i < data.length; i++) {
    totalFiles      += data[i].summary.totalFilesScanned;
    totalComponents += data[i].summary.totalComponentUsages;
    totalCalls      += data[i].summary.totalFunctionCalls;
  }

  var html = '';

  /* ── Header ── */
  html += '<div class="header">';
  html += '<div class="logo">usegraph</div>';
  html += '<div class="header-meta">' + data.length + ' project' + (data.length !== 1 ? 's' : '') + '</div>';
  html += '</div>';

  /* ── Summary cards ── */
  html += '<div class="stats-row">';
  html += statCard(totalFiles,      'Files Scanned');
  html += statCard(totalComponents, 'Component Usages');
  html += statCard(totalCalls,      'Function Calls');
  html += '</div>';

  /* ── Per-project sections ── */
  for (var j = 0; j < data.length; j++) {
    html += renderProject(data[j]);
  }

  /* ── Tooling matrix (only when meta data is present) ── */
  var metaProjects = [];
  for (var m = 0; m < data.length; m++) {
    if (data[m].meta) metaProjects.push(data[m]);
  }
  if (metaProjects.length > 0) {
    html += renderTooling(metaProjects);
  }

  app.innerHTML = html;

  /* ── Toggle project bodies on header click ── */
  var heads = document.querySelectorAll('.project-head');
  for (var h = 0; h < heads.length; h++) {
    heads[h].addEventListener('click', function () {
      var card = this.closest('.project-card');
      if (card) card.classList.toggle('collapsed');
    });
  }

  /* ──────────────────────────────────────────────────────
     Helper: stat summary card
  ────────────────────────────────────────────────────── */
  function statCard(value, label) {
    return '<div class="stat-card">' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '</div>';
  }

  /* ──────────────────────────────────────────────────────
     Helper: full project section
  ────────────────────────────────────────────────────── */
  function renderProject(result) {
    var s    = result.summary;
    var pkgs = Object.keys(s.byPackage);
    var date = new Date(result.scannedAt).toLocaleDateString();

    var out = '<div class="project-card">';

    /* head */
    out += '<div class="project-head">';
    out += '<div>';
    out += '<div class="project-name">' + esc(result.projectName) + '</div>';
    out += '<div class="project-path">' + esc(result.projectPath) + '</div>';
    out += '</div>';
    out += '<div class="project-stats">';
    out += '<div><strong>' + s.totalFilesScanned    + '</strong> files</div>';
    out += '<div><strong>' + s.totalComponentUsages + '</strong> components</div>';
    out += '<div><strong>' + s.totalFunctionCalls   + '</strong> calls</div>';
    out += '<div>' + esc(date) + '</div>';
    out += '</div>';
    out += '<span class="chevron">&#9660;</span>';
    out += '</div>';

    /* body */
    out += '<div class="project-body">';
    if (pkgs.length === 0) {
      out += '<p class="no-data">No tracked package usage found.</p>';
    } else {
      for (var k = 0; k < pkgs.length; k++) {
        out += renderPkg(result, pkgs[k], s.byPackage[pkgs[k]]);
      }
    }
    out += '</div>';

    out += '</div>';
    return out;
  }

  /* ──────────────────────────────────────────────────────
     Helper: per-package usage block
  ────────────────────────────────────────────────────── */
  function renderPkg(result, pkg, pkgSum) {
    /* Build usage counts from raw file data */
    var compCounts = {};
    var fnCounts   = {};

    for (var fi = 0; fi < result.files.length; fi++) {
      var f = result.files[fi];
      for (var ci = 0; ci < f.componentUsages.length; ci++) {
        var u = f.componentUsages[ci];
        if (u.importedFrom === pkg) {
          compCounts[u.componentName] = (compCounts[u.componentName] || 0) + 1;
        }
      }
      for (var fci = 0; fci < f.functionCalls.length; fci++) {
        var c = f.functionCalls[fci];
        if (c.importedFrom === pkg) {
          fnCounts[c.functionName] = (fnCounts[c.functionName] || 0) + 1;
        }
      }
    }

    var out = '<div class="pkg-block">';
    out += '<div class="pkg-label">' + esc(pkg) + '</div>';
    out += '<div class="tables-grid">';

    /* Collect prop frequencies per component */
    var propCounts = {};
    for (var fi2 = 0; fi2 < result.files.length; fi2++) {
      var f2 = result.files[fi2];
      for (var ci3 = 0; ci3 < f2.componentUsages.length; ci3++) {
        var u2 = f2.componentUsages[ci3];
        if (u2.importedFrom !== pkg) continue;
        if (!propCounts[u2.componentName]) propCounts[u2.componentName] = {};
        for (var pi = 0; pi < u2.props.length; pi++) {
          var pname = u2.props[pi].name;
          propCounts[u2.componentName][pname] = (propCounts[u2.componentName][pname] || 0) + 1;
        }
      }
    }

    /* Components table */
    var compKeys = Object.keys(compCounts).sort(function (a, b) {
      return compCounts[b] - compCounts[a];
    });
    if (compKeys.length > 0) {
      var maxC = compCounts[compKeys[0]];
      out += '<div>';
      out += '<div class="section-title">Components</div>';
      out += '<table><thead><tr><th>Name</th><th>Uses</th><th class="bar-cell"></th><th>Top props</th></tr></thead><tbody>';
      var climit = Math.min(compKeys.length, 15);
      for (var ci2 = 0; ci2 < climit; ci2++) {
        var cn   = compKeys[ci2];
        var cv   = compCounts[cn];
        var cpct = maxC > 0 ? Math.round((cv / maxC) * 100) : 0;
        /* top 5 props for this component */
        var topProps = '';
        if (propCounts[cn]) {
          var pkeys = Object.keys(propCounts[cn]).sort(function (a, b) {
            return propCounts[cn][b] - propCounts[cn][a];
          }).slice(0, 5);
          for (var pki = 0; pki < pkeys.length; pki++) {
            topProps += '<span class="prop-tag">' + esc(pkeys[pki]) + '</span>';
          }
        }
        out += '<tr>';
        out += '<td class="name-cell">' + esc(cn) + '</td>';
        out += '<td>' + cv + '</td>';
        out += '<td class="bar-cell"><div class="bar-wrap"><div class="bar-fill" style="width:' + cpct + '%"></div></div></td>';
        out += '<td>' + (topProps || '<span style="color:var(--text-dim);font-size:11px">none</span>') + '</td>';
        out += '</tr>';
      }
      if (compKeys.length > 15) {
        out += '<tr class="more-row"><td colspan="4">+' + (compKeys.length - 15) + ' more</td></tr>';
      }
      out += '</tbody></table></div>';
    } else {
      out += '<div></div>';
    }

    /* Functions table */
    var fnKeys = Object.keys(fnCounts).sort(function (a, b) {
      return fnCounts[b] - fnCounts[a];
    });
    if (fnKeys.length > 0) {
      var maxF = fnCounts[fnKeys[0]];
      out += '<div>';
      out += '<div class="section-title">Functions</div>';
      out += '<table><thead><tr><th>Name</th><th>Calls</th><th class="bar-cell"></th></tr></thead><tbody>';
      var flimit = Math.min(fnKeys.length, 15);
      for (var fk = 0; fk < flimit; fk++) {
        var fn2  = fnKeys[fk];
        var fv   = fnCounts[fn2];
        var fpct = maxF > 0 ? Math.round((fv / maxF) * 100) : 0;
        out += '<tr>';
        out += '<td class="name-cell">' + esc(fn2) + '</td>';
        out += '<td>' + fv + '</td>';
        out += '<td class="bar-cell"><div class="bar-wrap"><div class="bar-fill fn" style="width:' + fpct + '%"></div></div></td>';
        out += '</tr>';
      }
      if (fnKeys.length > 15) {
        out += '<tr class="more-row"><td colspan="3">+' + (fnKeys.length - 15) + ' more</td></tr>';
      }
      out += '</tbody></table></div>';
    } else {
      out += '<div></div>';
    }

    out += '</div>'; /* tables-grid */
    out += '</div>'; /* pkg-block */
    return out;
  }

  /* ──────────────────────────────────────────────────────
     Helper: tooling matrix + dependency counts
  ────────────────────────────────────────────────────── */
  function renderTooling(results) {
    /* Build tool -> { projectName: true } map */
    var toolMap      = {};
    var projectNames = [];

    for (var i = 0; i < results.length; i++) {
      projectNames.push(results[i].projectName);
      if (!results[i].meta) continue;
      var tooling = results[i].meta.tooling;
      for (var t = 0; t < tooling.length; t++) {
        var tname = tooling[t].name;
        if (!toolMap[tname]) toolMap[tname] = {};
        toolMap[tname][results[i].projectName] = true;
      }
    }

    var tools = Object.keys(toolMap).sort(function (a, b) {
      return Object.keys(toolMap[b]).length - Object.keys(toolMap[a]).length;
    });

    if (tools.length === 0 && results.length === 0) return '';

    var out = '<div class="tooling-section">';
    out += '<h2>Tech Stack</h2>';

    if (tools.length > 0) {
      out += '<table><thead><tr><th>Tool</th>';
      for (var pn = 0; pn < projectNames.length; pn++) {
        var pname = projectNames[pn];
        out += '<th>' + esc(pname.length > 18 ? pname.slice(0, 16) + '..' : pname) + '</th>';
      }
      out += '</tr></thead><tbody>';
      for (var ti = 0; ti < tools.length; ti++) {
        var toolName = tools[ti];
        out += '<tr><td>' + esc(toolName) + '</td>';
        for (var pi = 0; pi < projectNames.length; pi++) {
          if (toolMap[toolName][projectNames[pi]]) {
            out += '<td class="check">&#10003;</td>';
          } else {
            out += '<td class="dash">&#8211;</td>';
          }
        }
        out += '</tr>';
      }
      out += '</tbody></table>';
    }

    /* Dependency counts */
    out += '<div class="section-gap">';
    out += '<h2>Dependencies</h2>';
    out += '<table><thead><tr><th>Project</th><th>Production</th><th>Dev</th><th>Total</th></tr></thead><tbody>';
    for (var ri = 0; ri < results.length; ri++) {
      var r = results[ri];
      if (!r.meta) continue;
      var prod = 0, dev = 0;
      for (var di = 0; di < r.meta.dependencies.length; di++) {
        var sec = r.meta.dependencies[di].section;
        if (sec === 'dependencies')    prod++;
        else if (sec === 'devDependencies') dev++;
      }
      out += '<tr>';
      out += '<td>' + esc(r.projectName) + '</td>';
      out += '<td>' + prod + '</td>';
      out += '<td>' + dev  + '</td>';
      out += '<td>' + r.meta.dependencies.length + '</td>';
      out += '</tr>';
    }
    out += '</tbody></table>';
    out += '</div>';

    out += '</div>';
    return out;
  }

}());
`;
