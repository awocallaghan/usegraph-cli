---
title: Package Adoption
---

# Package Adoption

<div id="pa-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading usage data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
// Load usage, snapshot, and dependency tables via DuckDB WASM
const db = await DuckDBClient.of({
  component_usages:  FileAttachment("data/component_usages.parquet"),
  function_usages:   FileAttachment("data/function_usages.parquet"),
  project_snapshots: FileAttachment("data/project_snapshots.parquet"),
  dependencies:      FileAttachment("data/dependencies.parquet"),
});
```

```js
// Build distinct package list from the dependencies table (all packages across all scanned projects)
const packages = await db.query(
  `SELECT DISTINCT package_name FROM dependencies WHERE is_latest = true
   ORDER BY package_name`
).then(r => Array.from(r).map(d => d.package_name));
```

```js
// Remove loading indicator once data is ready
{
  void packages;
  document.getElementById("pa-loading-indicator")?.remove();
}
```

```js
const urlPackage = new URLSearchParams(location.search).get("package");
const packageFilter = view(
  packages.length > 0
    ? Inputs.select(packages, { label: "Package", value: urlPackage && packages.includes(urlPackage) ? urlPackage : packages[0] })
    : Inputs.text({ label: "Package", placeholder: "No data — run usegraph scan first", disabled: true })
)
```

```js
// Major versions available for the selected package (from dependencies table)
const majorVersions = packageFilter
  ? await db.query(
      `SELECT DISTINCT version_major FROM dependencies
       WHERE is_latest = true AND package_name = '${packageFilter.replace(/'/g, "''")}' AND version_major IS NOT NULL
       ORDER BY version_major`
    ).then(r => Array.from(r).map(d => String(d.version_major)))
  : [];
```

```js
const majorVersionFilter = view(
  Inputs.select(["All", ...majorVersions], { label: "Major version" })
)
```

```js
// Safe-escaped package name for SQL
const safePkg = (packageFilter ?? "").replace(/'/g, "''");
const depsVersionWhere = majorVersionFilter === "All" ? "" : `AND version_major = ${majorVersionFilter}`;
const usageVersionWhere = majorVersionFilter === "All" ? "" : `AND package_version_major = ${majorVersionFilter}`;
```

```js
// Current-state rows for the selected package + version filter
const [filteredDeps, filteredComponents, filteredFunctions, allProjects] = packageFilter
  ? await Promise.all([
      // Projects that declare this package as a dependency
      db.query(
        `SELECT DISTINCT project_id FROM dependencies
         WHERE is_latest = true AND package_name = '${safePkg}' ${depsVersionWhere}
         ORDER BY project_id`
      ).then(r => Array.from(r)),

      db.query(
        `SELECT project_id, package_name, package_version_resolved,
                package_version_major, package_version_minor, component_name
         FROM component_usages
         WHERE is_latest = true AND package_name = '${safePkg}' ${usageVersionWhere}
         ORDER BY component_name`
      ).then(r => Array.from(r)),

      db.query(
        `SELECT project_id, package_name, package_version_resolved,
                package_version_major, package_version_minor, export_name
         FROM function_usages
         WHERE is_latest = true AND package_name = '${safePkg}' ${usageVersionWhere}
         ORDER BY export_name`
      ).then(r => Array.from(r)),

      db.query(
        `SELECT DISTINCT project_id FROM project_snapshots WHERE is_latest = true ORDER BY project_id`
      ).then(r => Array.from(r)),
    ])
  : [[], [], [], []];
```

```js
const adopterIds = new Set(filteredDeps.map(d => d.project_id));
```

```js
// Stat cards
html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem">${
  [
    ["Adopting projects", adopterIds.size],
    ["Component usages", filteredComponents.length],
    ["Function calls", filteredFunctions.length],
  ].map(([label, value]) =>
    html`<div style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:8px;padding:1.25rem">
      <div style="font-size:2rem;font-weight:700;color:var(--theme-foreground-focus)">${value.toLocaleString()}</div>
      <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--theme-foreground-muted);margin-top:0.25rem">${label}</div>
    </div>`
  )
}</div>`
```

## Adoption by project

```js
// Total usages per adopting project (dep declaration counts as adoption; usages are a bonus signal)
const adoptionByProject = (() => {
  const counts = new Map();
  for (const d of filteredDeps) counts.set(d.project_id, 0);
  for (const d of [...filteredComponents, ...filteredFunctions]) {
    counts.set(d.project_id, (counts.get(d.project_id) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([project_id, usage_count]) => ({ project_id, usage_count }))
    .sort((a, b) => b.usage_count - a.usage_count);
})();
```

```js
adoptionByProject.length > 0
  ? Plot.plot({
      marginLeft: 160,
      x: { label: "usages", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(adoptionByProject, {
          x: "usage_count",
          y: "project_id",
          sort: { y: "-x" },
          tip: true,
          href: d => `/project-detail?project=${encodeURIComponent(d.project_id)}`,
          target: "_self",
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No adoption data for <strong>${packageFilter}</strong>${majorVersionFilter !== "All" ? ` v${majorVersionFilter}` : ""}.</p>`
```

## Component popularity

```js
const componentPopularity = (() => {
  const counts = new Map();
  for (const d of filteredComponents) {
    counts.set(d.component_name, (counts.get(d.component_name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([component_name, usage_count]) => ({ component_name, usage_count }))
    .sort((a, b) => b.usage_count - a.usage_count);
})();
```

```js
componentPopularity.length > 0
  ? Plot.plot({
      marginLeft: 160,
      x: { label: "usages", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(componentPopularity, {
          x: "usage_count",
          y: "component_name",
          sort: { y: "-x" },
          tip: true,
          href: d => `/component-explorer?package=${encodeURIComponent(packageFilter)}&component=${encodeURIComponent(d.component_name)}`,
          target: "_self",
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No component usage data for <strong>${packageFilter}</strong>.</p>`
```

## Function popularity

```js
const functionPopularity = (() => {
  const counts = new Map();
  for (const d of filteredFunctions) {
    counts.set(d.export_name, (counts.get(d.export_name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([export_name, call_count]) => ({ export_name, call_count }))
    .sort((a, b) => b.call_count - a.call_count);
})();
```

```js
functionPopularity.length > 0
  ? Plot.plot({
      marginLeft: 160,
      x: { label: "calls", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(functionPopularity, {
          x: "call_count",
          y: "export_name",
          sort: { y: "-x" },
          tip: true,
          href: d => `/function-explorer?package=${encodeURIComponent(packageFilter)}&function=${encodeURIComponent(d.export_name)}`,
          target: "_self",
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No function usage data for <strong>${packageFilter}</strong>.</p>`
```

## Version spread per project

```js
// Version spread from the dependencies table (covers all packages, not just tracked ones)
const versionSpreadRaw = packageFilter
  ? await db.query(
      `SELECT version_major, version_minor, COUNT(DISTINCT project_id)::INTEGER AS project_count
       FROM dependencies
       WHERE is_latest = true AND package_name = '${safePkg}' ${depsVersionWhere}
       GROUP BY version_major, version_minor`
    ).then(r => Array.from(r))
  : [];
```

```js
const versionSpread = versionSpreadRaw
  .map(d => ({
    label: d.version_major == null ? "unknown" : `${d.version_major}.${d.version_minor ?? "x"}`,
    project_count: d.project_count,
  }))
  .sort((a, b) => {
    if (a.label === "unknown") return 1;
    if (b.label === "unknown") return -1;
    const [aMaj, aMin] = a.label.split(".").map(Number);
    const [bMaj, bMin] = b.label.split(".").map(Number);
    return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
  });
```

```js
versionSpread.length === 0
  ? html`<p style="color:var(--theme-foreground-muted)">No version data for <strong>${packageFilter}</strong>.</p>`
  : versionSpread.length === 1
  ? html`<p>All projects use <strong>${versionSpread[0].label}</strong> (${versionSpread[0].project_count} project${versionSpread[0].project_count === 1 ? "" : "s"}).</p>`
  : Plot.plot({
      marginLeft: 80,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(versionSpread, { x: "project_count", y: "label", tip: true }),
        Plot.ruleX([0]),
      ],
    })
```

## Usage over time

```js
// Historical adoption trend — count of distinct projects declaring this package per scan date.
// COALESCE(code_at, scanned_at): for --history scans each commit has a distinct code_at.
const trendData = packageFilter
  ? await db.query(
      `SELECT DATE_TRUNC('day', COALESCE(code_at, scanned_at)::TIMESTAMP) AS scan_date,
              COUNT(DISTINCT project_id)::INTEGER AS project_count
       FROM dependencies
       WHERE package_name = '${safePkg}'
       GROUP BY DATE_TRUNC('day', COALESCE(code_at, scanned_at)::TIMESTAMP)
       ORDER BY scan_date`
    ).then(r => Array.from(r).map(d => ({ ...d, scan_date: new Date(d.scan_date) })))
  : [];
```

```js
trendData.length < 2
  ? html`<p style="color:var(--theme-foreground-muted)">Adoption over time requires multiple scans. Only ${trendData.length} scan date${trendData.length === 1 ? "" : "s"} found for <strong>${packageFilter}</strong>.</p>`
  : Plot.plot({
      x: { label: "scan date", type: "utc" },
      y: { label: "adopting projects", grid: true },
      marks: [
        Plot.lineY(trendData, { x: "scan_date", y: "project_count", tip: true }),
        Plot.dotY(trendData, { x: "scan_date", y: "project_count" }),
        Plot.ruleY([0]),
      ],
    })
```

## Non-adopters

_Projects that do **not** declare **${packageFilter}**${majorVersionFilter !== "All" ? ` v${majorVersionFilter}` : ""} as a dependency._

```js
const nonAdopters = allProjects.filter(d => !adopterIds.has(d.project_id));
```

```js
nonAdopters.length === 0
  ? html`<p style="color:var(--theme-foreground-muted)">All projects use <strong>${packageFilter}</strong> 🎉</p>`
  : Inputs.table(nonAdopters, {
      columns: ["project_id"],
      header: { project_id: "Project" },
      format: {
        project_id: (d) => html`<a href="/project-detail?project=${encodeURIComponent(d)}">${d}</a>`,
      },
    })
```

