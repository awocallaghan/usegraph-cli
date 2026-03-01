---
title: Package Adoption
---

# Package Adoption

<div id="pa-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading usage data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
import { getDB } from "./components/db.js";
```

```js
// Load usage and snapshot tables via DuckDB WASM (singleton: re-used if the
// module cache survives navigation, e.g. with a future client-side router).
const db = await getDB("package-adoption", () => DuckDBClient.of({
  component_usages:  FileAttachment("data/component_usages.parquet"),
  function_usages:   FileAttachment("data/function_usages.parquet"),
  project_snapshots: FileAttachment("data/project_snapshots.parquet"),
}));
```

```js
// Build distinct package list across both usage tables (current state only)
const packages = await db.query(
  `SELECT DISTINCT package_name FROM component_usages WHERE is_latest = true
   UNION
   SELECT DISTINCT package_name FROM function_usages WHERE is_latest = true
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
const packageFilter = view(
  packages.length > 0
    ? Inputs.select(packages, { label: "Package" })
    : Inputs.text({ label: "Package", placeholder: "No data — run usegraph scan first", disabled: true })
)
```

```js
// Major versions available for the selected package
const majorVersions = packageFilter
  ? await db.query(
      `SELECT DISTINCT package_version_major FROM component_usages
       WHERE is_latest = true AND package_name = '${packageFilter.replace(/'/g, "''")}' AND package_version_major IS NOT NULL
       UNION
       SELECT DISTINCT package_version_major FROM function_usages
       WHERE is_latest = true AND package_name = '${packageFilter.replace(/'/g, "''")}' AND package_version_major IS NOT NULL
       ORDER BY package_version_major`
    ).then(r => Array.from(r).map(d => String(d.package_version_major)))
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
const majorWhere = majorVersionFilter === "All" ? "" : `AND package_version_major = ${majorVersionFilter}`;
```

```js
// Current-state usage rows for the selected package + version filter
const [filteredComponents, filteredFunctions, allProjects] = packageFilter
  ? await Promise.all([
      db.query(
        `SELECT project_id, package_name, package_version_resolved,
                package_version_major, package_version_minor, component_name
         FROM component_usages
         WHERE is_latest = true AND package_name = '${safePkg}' ${majorWhere}
         ORDER BY component_name`
      ).then(r => Array.from(r)),

      db.query(
        `SELECT project_id, package_name, package_version_resolved,
                package_version_major, package_version_minor, export_name
         FROM function_usages
         WHERE is_latest = true AND package_name = '${safePkg}' ${majorWhere}
         ORDER BY export_name`
      ).then(r => Array.from(r)),

      db.query(
        `SELECT DISTINCT project_id FROM project_snapshots WHERE is_latest = true ORDER BY project_id`
      ).then(r => Array.from(r)),
    ])
  : [[], [], []];
```

```js
const adopterIds = new Set([
  ...filteredComponents.map(d => d.project_id),
  ...filteredFunctions.map(d => d.project_id),
]);
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
// Total usages per project
const adoptionByProject = (() => {
  const counts = new Map();
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
const versionSpread = (() => {
  const buckets = new Map();
  for (const d of [...filteredComponents, ...filteredFunctions]) {
    const label =
      d.package_version_major == null
        ? "unknown"
        : `${d.package_version_major}.${d.package_version_minor ?? "x"}`;
    if (!buckets.has(label)) buckets.set(label, new Set());
    buckets.get(label).add(d.project_id);
  }
  return Array.from(buckets.entries())
    .map(([label, projects]) => ({ label, project_count: projects.size }))
    .sort((a, b) => {
      if (a.label === "unknown") return 1;
      if (b.label === "unknown") return -1;
      const [aMaj, aMin] = a.label.split(".").map(Number);
      const [bMaj, bMin] = b.label.split(".").map(Number);
      return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
    });
})();
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
// Historical trend for the selected package — all scans (not just is_latest).
// COALESCE(code_at, scanned_at): for --history scans every commit shares the same scanned_at
// but has a distinct code_at (the commit timestamp). For regular scans code_at may be NULL.
const trendData = packageFilter
  ? await db.query(
      `SELECT DATE_TRUNC('day', scan_date::TIMESTAMP) AS scan_date,
              (SUM(component_count) + SUM(function_count))::INTEGER AS total,
              COUNT(DISTINCT project_id) AS project_count
       FROM (
         SELECT COALESCE(code_at, scanned_at) AS scan_date, project_id,
                COUNT(*)::INTEGER AS component_count, 0::INTEGER AS function_count
         FROM component_usages
         WHERE package_name = '${safePkg}'
         GROUP BY scan_date, project_id
         UNION ALL
         SELECT COALESCE(code_at, scanned_at) AS scan_date, project_id,
                0::INTEGER AS component_count, COUNT(*)::INTEGER AS function_count
         FROM function_usages
         WHERE package_name = '${safePkg}'
         GROUP BY scan_date, project_id
       ) t
       GROUP BY DATE_TRUNC('day', scan_date::TIMESTAMP)
       ORDER BY scan_date`
    ).then(r => Array.from(r).map(d => ({ ...d, scan_date: new Date(d.scan_date) })))
  : [];
```

```js
trendData.length < 2
  ? html`<p style="color:var(--theme-foreground-muted)">Usage over time requires multiple scans. Only ${trendData.length} scan date${trendData.length === 1 ? "" : "s"} found for <strong>${packageFilter}</strong>.</p>`
  : Plot.plot({
      x: { label: "scan date", type: "utc" },
      y: { label: "total usages", grid: true },
      marks: [
        Plot.lineY(trendData, { x: "scan_date", y: "total", tip: true }),
        Plot.dotY(trendData, { x: "scan_date", y: "total" }),
        Plot.ruleY([0]),
      ],
    })
```

## Non-adopters

_Projects with zero usage of **${packageFilter}**${majorVersionFilter !== "All" ? ` v${majorVersionFilter}` : ""}._

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

