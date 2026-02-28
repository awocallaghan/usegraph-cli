---
title: Package Adoption
---

# Package Adoption

```js
const data = await FileAttachment("data/package_adoption.json").json();
```

```js
// Derive sorted list of all packages across both usage tables
const packages = Array.from(
  new Set([
    ...data.allComponentUsages.map(d => d.package_name),
    ...data.allFunctionUsages.map(d => d.package_name),
  ])
).sort();
```

```js
const packageFilter = view(
  packages.length > 0
    ? Inputs.select(packages, { label: "Package" })
    : Inputs.text({ label: "Package", placeholder: "No data — run usegraph scan first", disabled: true })
)
```

```js
// Derive major versions available for the selected package
const majorVersions = Array.from(
  new Set([
    ...data.allComponentUsages
      .filter(d => d.package_name === packageFilter && d.package_version_major != null)
      .map(d => d.package_version_major),
    ...data.allFunctionUsages
      .filter(d => d.package_name === packageFilter && d.package_version_major != null)
      .map(d => d.package_version_major),
  ])
).sort((a, b) => a - b).map(String);
```

```js
const majorVersionFilter = view(
  Inputs.select(["All", ...majorVersions], { label: "Major version" })
)
```

```js
// Apply filters client-side
function matchesMajor(d) {
  return majorVersionFilter === "All" || String(d.package_version_major) === majorVersionFilter;
}

const filteredComponents = data.allComponentUsages.filter(
  d => d.package_name === packageFilter && matchesMajor(d)
);

const filteredFunctions = data.allFunctionUsages.filter(
  d => d.package_name === packageFilter && matchesMajor(d)
);

const allUsages = [...filteredComponents, ...filteredFunctions];

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
  for (const d of allUsages) {
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
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No function usage data for <strong>${packageFilter}</strong>.</p>`
```

## Version spread per project

```js
// Group by major.minor, count distinct projects
const versionSpread = (() => {
  const buckets = new Map();
  for (const d of allUsages) {
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
// Historical trend for the selected package (sum component + function counts per scanned_at)
const trendData = (() => {
  // Historical data has no version breakdown, so we show all versions regardless of the
  // majorVersionFilter selection (filtering would incorrectly return zero rows).
  const filtered = data.historicalUsages.filter(d => d.package_name === packageFilter);
  // Aggregate per scanned_at across all projects
  const byDate = new Map();
  for (const d of filtered) {
    const key = d.scanned_at;
    const prev = byDate.get(key) ?? { scanned_at: key, total: 0, project_count: new Set() };
    prev.total += (d.component_count ?? 0) + (d.function_count ?? 0);
    prev.project_count.add(d.project_id);
    byDate.set(key, prev);
  }
  return Array.from(byDate.values())
    .map(({ scanned_at, total, project_count }) => ({
      scanned_at: new Date(scanned_at),
      total,
      project_count: project_count.size,
    }))
    .sort((a, b) => a.scanned_at - b.scanned_at);
})();
```

```js
trendData.length < 2
  ? html`<p style="color:var(--theme-foreground-muted)">Usage over time requires multiple scans. Only ${trendData.length} scan date${trendData.length === 1 ? "" : "s"} found for <strong>${packageFilter}</strong>.</p>`
  : Plot.plot({
      x: { label: "scan date", type: "utc" },
      y: { label: "total usages", grid: true },
      marks: [
        Plot.lineY(trendData, { x: "scanned_at", y: "total", tip: true }),
        Plot.dotY(trendData, { x: "scanned_at", y: "total" }),
        Plot.ruleY([0]),
      ],
    })
```

## Non-adopters

_Projects with zero usage of **${packageFilter}**${majorVersionFilter !== "All" ? ` v${majorVersionFilter}` : ""}._

```js
const nonAdopters = data.allProjects.filter(d => !adopterIds.has(d.project_id));
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
