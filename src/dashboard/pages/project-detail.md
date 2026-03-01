---
title: Project Detail
---

# Project Detail

<div id="pd-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading usage data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
// Load project list for the selector (lightweight JSON)
const meta = await FileAttachment("data/project_detail_meta.json").json();
```

```js
// Initialise DuckDB WASM with all four parquet tables.
// Optional tables (dependencies, component_usages, function_usages) always return
// a valid (possibly empty) parquet from their data loader, so this never throws.
const db = await DuckDBClient.of({
  project_snapshots: FileAttachment("data/project_snapshots.parquet"),
  dependencies:      FileAttachment("data/dependencies.parquet"),
  component_usages:  FileAttachment("data/component_usages.parquet"),
  function_usages:   FileAttachment("data/function_usages.parquet"),
});
```

```js
// Remove loading indicator once DuckDB is ready
{ void db; document.getElementById("pd-loading-indicator")?.remove(); }
```

```js
// Resolve selected project: URL param → dropdown fallback
const urlProject = new URLSearchParams(location.search).get("project");
const selectedProject = (urlProject && meta.projectIds.includes(urlProject))
  ? urlProject
  : view(Inputs.select(meta.projectIds, { label: "Project" }));
```

```js
// ── Core queries — re-run reactively when selectedProject changes ──────────
// All five queries are independent so they run in parallel via Promise.all.

const safeId = selectedProject.replace(/'/g, "''");

const [allSnapshots, deps, componentUsages, functionUsages, scanHistory] = await Promise.all([
  db.query(
    `SELECT project_id, scanned_at, code_at, is_latest, framework, framework_version, package_manager,
            build_tool, test_framework, linter, formatter, css_approach,
            typescript, typescript_version, node_version, branch, commit_sha
     FROM project_snapshots WHERE project_id = '${safeId}' ORDER BY scanned_at DESC`
  ).then(r => Array.from(r)),

  db.query(
    `SELECT package_name, version_resolved, version_range, dep_type,
            version_is_prerelease, is_internal
     FROM dependencies WHERE project_id = '${safeId}' AND is_latest = true
     ORDER BY dep_type, package_name`
  ).then(r => Array.from(r)),

  db.query(
    `SELECT package_name, component_name,
            package_version_resolved, package_version_major, package_version_minor,
            COUNT(*)::INTEGER AS usage_count
     FROM component_usages
     WHERE project_id = '${safeId}' AND is_latest = true
     GROUP BY package_name, component_name, package_version_resolved, package_version_major, package_version_minor
     ORDER BY package_name, usage_count DESC`
  ).then(r => Array.from(r)),

  db.query(
    `SELECT package_name, export_name,
            package_version_resolved, package_version_major, package_version_minor,
            COUNT(*)::INTEGER AS call_count
     FROM function_usages
     WHERE project_id = '${safeId}' AND is_latest = true
     GROUP BY package_name, export_name, package_version_resolved, package_version_major, package_version_minor
     ORDER BY package_name, call_count DESC`
  ).then(r => Array.from(r)),

  db.query(
    `SELECT scanned_at, SUM(cu)::INTEGER AS component_count, SUM(fu)::INTEGER AS function_count
     FROM (
       SELECT COALESCE(code_at, scanned_at) AS scanned_at, COUNT(*) AS cu, 0 AS fu FROM component_usages WHERE project_id = '${safeId}' GROUP BY COALESCE(code_at, scanned_at)
       UNION ALL
       SELECT COALESCE(code_at, scanned_at) AS scanned_at, 0 AS cu, COUNT(*) AS fu FROM function_usages  WHERE project_id = '${safeId}' GROUP BY COALESCE(code_at, scanned_at)
     )
     GROUP BY scanned_at ORDER BY scanned_at`
  ).then(r => Array.from(r)),
]);

const latestSnapshot = allSnapshots.find(r => r.is_latest) ?? allSnapshots[0] ?? null;
```

---

## Snapshot

```js
if (!latestSnapshot) {
  display(html`<p style="color:var(--theme-foreground-muted)">No snapshot data found for <strong>${selectedProject}</strong>.</p>`);
} else {
  const tooling = [
    ["Framework",        latestSnapshot.framework       ? `${latestSnapshot.framework} ${latestSnapshot.framework_version ?? ""}`.trim() : null],
    ["Package manager",  latestSnapshot.package_manager],
    ["Build tool",       latestSnapshot.build_tool],
    ["Test framework",   latestSnapshot.test_framework],
    ["Linter",           latestSnapshot.linter],
    ["Formatter",        latestSnapshot.formatter],
    ["CSS approach",     latestSnapshot.css_approach],
    ["TypeScript",       latestSnapshot.typescript ? `Yes ${latestSnapshot.typescript_version ?? ""}`.trim() : latestSnapshot.typescript === false ? "No" : null],
    ["Node version",     latestSnapshot.node_version],
  ].filter(([, v]) => v != null);

  const meta2 = [
    ["Last scanned", new Date(latestSnapshot.scanned_at).toLocaleString()],
    ...(latestSnapshot.code_at ? [["Code state", new Date(latestSnapshot.code_at).toLocaleString()]] : []),
    ["Branch",       latestSnapshot.branch ?? "—"],
    ["Commit",       latestSnapshot.commit_sha ? latestSnapshot.commit_sha.slice(0, 8) : "—"],
    ["Scans stored", allSnapshots.length],
  ];

  display(html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2rem">
    ${[...tooling, ...meta2].map(([label, value]) =>
      html`<div style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:8px;padding:1rem">
        <div style="font-size:1.1rem;font-weight:600;color:var(--theme-foreground-focus);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${value}</div>
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--theme-foreground-muted);margin-top:0.25rem">${label}</div>
      </div>`
    )}
  </div>`);
}
```

---

## Dependencies

```js
const depTypeFilter = view(Inputs.select(
  ["All", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"],
  { label: "Dep type" }
))
```

```js
const depPkgSearch = view(Inputs.text({ placeholder: "e.g. react, @acme/…", label: "Package search" }))
```

```js
const depPrereleaseOnly = view(Inputs.toggle({ label: "Prerelease only" }))
```

```js
const depInternalOnly = view(Inputs.toggle({ label: "Internal only" }))
```

```js
const filteredDeps = deps.filter(d => {
  if (depTypeFilter !== "All" && d.dep_type !== depTypeFilter) return false;
  if (depPkgSearch.trim() && !d.package_name.includes(depPkgSearch.trim())) return false;
  if (depPrereleaseOnly && !d.version_is_prerelease) return false;
  if (depInternalOnly && !d.is_internal) return false;
  return true;
});
```

```js
filteredDeps.length > 0
  ? Inputs.table(filteredDeps, {
      columns: ["package_name", "version_resolved", "version_range", "dep_type"],
      header: {
        package_name:     "Package",
        version_resolved: "Resolved",
        version_range:    "Range",
        dep_type:         "Type",
      },
    })
  : html`<p style="color:var(--theme-foreground-muted)">No dependencies match the current filters.</p>`
```

---

## Component usage

```js
const componentPackages = Array.from(new Set(componentUsages.map(d => d.package_name))).sort();
const componentPkgFilter = view(
  componentPackages.length > 0
    ? Inputs.select(["All", ...componentPackages], { label: "Package" })
    : Inputs.text({ label: "Package", placeholder: "No component usage data", disabled: true })
);
```

```js
const filteredComponents = componentPackages.length === 0
  ? []
  : componentPkgFilter === "All"
    ? componentUsages
    : componentUsages.filter(d => d.package_name === componentPkgFilter);
```

```js
filteredComponents.length > 0
  ? Plot.plot({
      marginLeft: 180,
      x: { label: "usages", grid: true },
      y: { label: null },
      color: { legend: componentPkgFilter === "All" },
      marks: [
        Plot.barX(filteredComponents, {
          x: "usage_count",
          y: "component_name",
          fill: "package_name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No component usage data for <strong>${selectedProject}</strong>.</p>`
```

```js
filteredComponents.length > 0
  ? Inputs.table(filteredComponents, {
      columns: ["package_name", "component_name", "usage_count"],
      header: { package_name: "Package", component_name: "Component", usage_count: "Usages" },
      sort: "usage_count",
      reverse: true,
      format: {
        component_name: (name, i) => {
          const pkg = filteredComponents[i]?.package_name ?? "";
          const url = `/component-explorer?package=${encodeURIComponent(pkg)}&component=${encodeURIComponent(name)}&project=${encodeURIComponent(selectedProject)}`;
          return html`<a href="${url}">${name}</a>`;
        },
      },
    })
  : null
```

---

## Function usage

```js
const functionPackages = Array.from(new Set(functionUsages.map(d => d.package_name))).sort();
const functionPkgFilter = view(
  functionPackages.length > 0
    ? Inputs.select(["All", ...functionPackages], { label: "Package" })
    : Inputs.text({ label: "Package", placeholder: "No function usage data", disabled: true })
);
```

```js
const filteredFunctions = functionPackages.length === 0
  ? []
  : functionPkgFilter === "All"
    ? functionUsages
    : functionUsages.filter(d => d.package_name === functionPkgFilter);
```

```js
filteredFunctions.length > 0
  ? Plot.plot({
      marginLeft: 180,
      x: { label: "calls", grid: true },
      y: { label: null },
      color: { legend: functionPkgFilter === "All" },
      marks: [
        Plot.barX(filteredFunctions, {
          x: "call_count",
          y: "export_name",
          fill: "package_name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No function usage data for <strong>${selectedProject}</strong>.</p>`
```

```js
filteredFunctions.length > 0
  ? Inputs.table(filteredFunctions, {
      columns: ["package_name", "export_name", "call_count"],
      header: { package_name: "Package", export_name: "Function", call_count: "Calls" },
      sort: "call_count",
      reverse: true,
      format: {
        export_name: (name, i) => {
          const pkg = filteredFunctions[i]?.package_name ?? "";
          const url = `/function-explorer?package=${encodeURIComponent(pkg)}&function=${encodeURIComponent(name)}&project=${encodeURIComponent(selectedProject)}`;
          return html`<a href="${url}">${name}</a>`;
        },
      },
    })
  : null
```

---

## Scan history

```js
// Parse dates and compute totals for the chart
const historyRows = scanHistory.map(r => ({
  scanned_at:      new Date(r.scanned_at),
  component_count: r.component_count ?? 0,
  function_count:  r.function_count  ?? 0,
  total:           (r.component_count ?? 0) + (r.function_count ?? 0),
}));

const distinctDates = new Set(historyRows.map(r => r.scanned_at.toISOString()));
```

```js
// Date range filter (only shown when there are multiple scans)
const historyStartDate = view(
  distinctDates.size >= 2
    ? Inputs.date({ label: "From", value: historyRows.at(0)?.scanned_at })
    : Inputs.text({ label: "From", disabled: true, placeholder: "—" })
);
```

```js
const historyEndDate = view(
  distinctDates.size >= 2
    ? Inputs.date({ label: "To", value: historyRows.at(-1)?.scanned_at })
    : Inputs.text({ label: "To", disabled: true, placeholder: "—" })
);
```

```js
if (distinctDates.size < 2) {
  display(html`<p style="color:var(--theme-foreground-muted)">Scan history requires multiple scans. ${distinctDates.size === 1 ? "Only 1 scan date found." : "No scan data found."}</p>`);
} else {
  const start = historyStartDate ? new Date(historyStartDate) : new Date(0);
  const end   = historyEndDate   ? new Date(historyEndDate)   : new Date();

  // Flatten to one row per (date, type) for a stacked/layered line chart
  const trendRows = historyRows
    .filter(r => r.scanned_at >= start && r.scanned_at <= end)
    .flatMap(r => [
      { scanned_at: r.scanned_at, count: r.component_count, type: "components" },
      { scanned_at: r.scanned_at, count: r.function_count,  type: "functions"  },
    ]);

  display(trendRows.length < 2
    ? html`<p style="color:var(--theme-foreground-muted)">No data in the selected date range.</p>`
    : Plot.plot({
        x: { label: "scan date", type: "utc" },
        y: { label: "usages", grid: true },
        color: { legend: true },
        marks: [
          Plot.lineY(trendRows, { x: "scanned_at", y: "count", stroke: "type", tip: true }),
          Plot.dotY(trendRows,  { x: "scanned_at", y: "count", fill: "type" }),
          Plot.ruleY([0]),
        ],
      })
  );
}
```
