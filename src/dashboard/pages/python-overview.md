---
title: Python Overview
---

# Python Overview

<div id="py-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading Python data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
const _dbStart = performance.now();
const db = await DuckDBClient.of({
  project_snapshots: FileAttachment("data/project_snapshots.parquet"),
  dependencies:      FileAttachment("data/dependencies.parquet"),
  function_usages:   FileAttachment("data/function_usages.parquet"),
});
console.log(`[usegraph] DuckDB init: ${Math.round(performance.now() - _dbStart)}ms`);
```

```js
// Python projects: filter snapshots to rows that have python_package_manager OR python_framework set
const pyProjects = await db.query(`
  SELECT
    project_id,
    scanned_at,
    COALESCE(python_framework, framework) AS framework,
    python_package_manager                AS package_manager,
    python_version
  FROM project_snapshots
  WHERE is_latest = true
    AND (python_package_manager IS NOT NULL OR python_framework IS NOT NULL)
  ORDER BY scanned_at DESC
`).then(r => Array.from(r));

// Remove loading indicator
{
  void pyProjects;
  document.getElementById("py-loading-indicator")?.remove();
}
```

```js
// Framework and package manager distributions
const frameworkCounts = await db.query(`
  SELECT python_framework AS name, COUNT(*) AS count
  FROM project_snapshots
  WHERE is_latest = true AND python_framework IS NOT NULL
  GROUP BY python_framework ORDER BY count DESC
`).then(r => Array.from(r));

const pmCounts = await db.query(`
  SELECT python_package_manager AS name, COUNT(*) AS count
  FROM project_snapshots
  WHERE is_latest = true AND python_package_manager IS NOT NULL
  GROUP BY python_package_manager ORDER BY count DESC
`).then(r => Array.from(r));
```

```js
// Top Python packages by project adoption count
const topPyPackages = await db.query(`
  SELECT package_name, COUNT(DISTINCT project_id)::INTEGER AS project_count
  FROM dependencies
  WHERE is_latest = true AND language = 'python'
  GROUP BY package_name
  ORDER BY project_count DESC
  LIMIT 20
`).then(r => Array.from(r));
```

```js
// Python function call counts per package (from scans that included Python files)
const pyFuncUsages = await db.query(`
  SELECT package_name, COUNT(*)::INTEGER AS call_count, COUNT(DISTINCT project_id)::INTEGER AS project_count
  FROM function_usages fu
  WHERE is_latest = true
    AND EXISTS (
      SELECT 1 FROM project_snapshots ps
      WHERE ps.project_id = fu.project_id
        AND ps.is_latest = true
        AND (ps.python_package_manager IS NOT NULL OR ps.python_framework IS NOT NULL)
    )
  GROUP BY package_name
  ORDER BY project_count DESC, call_count DESC
  LIMIT 20
`).then(r => Array.from(r));
console.log(`[usegraph] Python overview ready: ${Math.round(performance.now() - _dbStart)}ms total`);
```

## Python Projects

${pyProjects.length === 0
  ? html`<p style="color:var(--theme-foreground-muted)">No Python projects found. Run <code>usegraph scan</code> on Python projects, then <code>usegraph build</code>.</p>`
  : html`<p>Found <strong>${pyProjects.length}</strong> Python project${pyProjects.length !== 1 ? 's' : ''} in the latest scans.</p>`}

```js
if (pyProjects.length > 0) {
  display(Inputs.table(pyProjects, {
    columns: ["project_id", "framework", "package_manager", "python_version", "scanned_at"],
    header: {
      project_id: "Project",
      framework: "Framework",
      package_manager: "Package Manager",
      python_version: "Python Version",
      scanned_at: "Last Scanned",
    },
    format: {
      project_id: (d) => html`<a href="./project-detail?project=${encodeURIComponent(d)}">${d}</a>`,
      scanned_at: (d) => new Date(d).toLocaleString(),
    },
  }));
}
```

## Frameworks & Package Managers

```js
if (frameworkCounts.length > 0 || pmCounts.length > 0) {
  display(html`<div style="display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin-top:1rem">
    <div>
      <h3 style="margin:0 0 0.75rem">Frameworks</h3>
      ${Plot.plot({
        marks: [
          Plot.barX(frameworkCounts, { y: "name", x: "count", fill: "steelblue", tip: true }),
          Plot.ruleX([0]),
        ],
        x: { label: "Projects" },
        y: { label: null },
        marginLeft: 80,
        height: Math.max(120, frameworkCounts.length * 30 + 40),
      })}
    </div>
    <div>
      <h3 style="margin:0 0 0.75rem">Package Managers</h3>
      ${Plot.plot({
        marks: [
          Plot.barX(pmCounts, { y: "name", x: "count", fill: "teal", tip: true }),
          Plot.ruleX([0]),
        ],
        x: { label: "Projects" },
        y: { label: null },
        marginLeft: 80,
        height: Math.max(120, pmCounts.length * 30 + 40),
      })}
    </div>
  </div>`);
} else {
  display(html`<p style="color:var(--theme-foreground-muted)">No Python tooling data available.</p>`);
}
```

## Top Python Packages

```js
if (topPyPackages.length > 0) {
  display(Plot.plot({
    marks: [
      Plot.barX(topPyPackages, {
        y: "package_name", x: "project_count",
        fill: "steelblue", tip: true,
        sort: { y: "-x" },
      }),
      Plot.ruleX([0]),
    ],
    x: { label: "Projects using package" },
    y: { label: null },
    marginLeft: 120,
    height: Math.max(200, topPyPackages.length * 24 + 40),
  }));
} else {
  display(html`<p style="color:var(--theme-foreground-muted)">No Python dependency data available.</p>`);
}
```

## Python Function & Class Call Sites

*Calls to tracked Python package functions/classes detected in source files.*

```js
if (pyFuncUsages.length > 0) {
  display(Inputs.table(pyFuncUsages, {
    columns: ["package_name", "project_count", "call_count"],
    header: { package_name: "Package", project_count: "Projects", call_count: "Total Calls" },
  }));
  display(html`<p style="color:var(--theme-foreground-muted);font-size:0.9em">
    Tip: use the <a href="./function-explorer">Function Explorer</a> to drill into specific function signatures and argument patterns.
  </p>`);
} else {
  display(html`<p style="color:var(--theme-foreground-muted)">No Python call-site data yet. Scan Python projects with <code>--packages flask,fastapi,django</code> etc.</p>`);
}
```
