---
title: Dependencies
---

# Dependencies

```js
const deps = await FileAttachment("data/dependencies.json").json();
```

```js
// Stat cards
html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem">${
  [
    ["Unique packages", new Set(deps.allDeps.map(d => d.package_name)).size],
    ["Total dep entries", deps.allDeps.length],
    ["Prerelease deps", deps.prereleaseExposure.length],
    ["Internal packages", deps.internalPackages.length],
  ].map(([label, value]) =>
    html`<div style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:8px;padding:1.25rem">
      <div style="font-size:2rem;font-weight:700;color:var(--theme-foreground-focus)">${value.toLocaleString()}</div>
      <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--theme-foreground-muted);margin-top:0.25rem">${label}</div>
    </div>`
  )
}</div>`
```

```js
const depTypeFilter = view(Inputs.select(
  ["All", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"],
  { label: "Dep type" }
))
```

```js
const pkgSearch = view(Inputs.text({ placeholder: "e.g. react, @acme/…", label: "Package search" }))
```

```js
const prereleaseOnly = view(Inputs.toggle({ label: "Prerelease only" }))
```

```js
const internalOnly = view(Inputs.toggle({ label: "Internal only" }))
```

```js
const filteredDeps = deps.allDeps.filter(d => {
  if (depTypeFilter !== "All" && d.dep_type !== depTypeFilter) return false;
  if (pkgSearch.trim() !== "" && !d.package_name.includes(pkgSearch.trim())) return false;
  if (prereleaseOnly && !d.version_is_prerelease) return false;
  if (internalOnly && !d.is_internal) return false;
  return true;
});
```

```js
// Re-aggregate filtered deps client-side: top 30 packages by project count
const filteredTopPackages = (() => {
  const counts = new Map();
  for (const d of filteredDeps) {
    counts.set(d.package_name, (counts.get(d.package_name) ?? new Set()));
    counts.get(d.package_name).add(d.project_id);
  }
  return Array.from(counts.entries())
    .map(([package_name, projects]) => ({ package_name, project_count: projects.size }))
    .sort((a, b) => b.project_count - a.project_count)
    .slice(0, 30);
})();
```

## Most common dependencies

```js
filteredTopPackages.length > 0
  ? Plot.plot({
      marginLeft: 200,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(filteredTopPackages, {
          x: "project_count",
          y: "package_name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No packages match the current filters.</p>`
```

## Package deep-dive

```js
const selectedPkg = view(Inputs.select(
  filteredTopPackages.map(d => d.package_name),
  { label: "Package" }
))
```

```js
// Group all rows for selectedPkg into major.minor buckets, sorted ascending (oldest first)
const versionSpreadData = (() => {
  const rows = deps.allDeps.filter(d => d.package_name === selectedPkg);
  const buckets = new Map();
  for (const d of rows) {
    const label = d.version_major == null ? "unknown" : `${d.version_major}.${d.version_minor}`;
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

### Version spread

```js
versionSpreadData.length === 0
  ? html`<p style="color:var(--theme-foreground-muted)">No data for ${selectedPkg}.</p>`
  : versionSpreadData.length === 1
  ? html`<p>All projects use <strong>${versionSpreadData[0].label}</strong> (${versionSpreadData[0].project_count} project${versionSpreadData[0].project_count === 1 ? "" : "s"}).</p>`
  : Plot.plot({
      marginLeft: 80,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(versionSpreadData, { x: "project_count", y: "label", tip: true }),
        Plot.ruleX([0]),
      ],
    })
```

```js
// Count dep_type occurrences for selectedPkg
const depTypeBreakdownData = (() => {
  const rows = deps.allDeps.filter(d => d.package_name === selectedPkg);
  const counts = new Map();
  for (const d of rows) {
    counts.set(d.dep_type, (counts.get(d.dep_type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([dep_type, count]) => ({ dep_type, count }))
    .sort((a, b) => b.count - a.count);
})();
```

### Dependency type breakdown

```js
depTypeBreakdownData.length > 0
  ? Plot.plot({
      marginLeft: 160,
      x: { label: "entries", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(depTypeBreakdownData, {
          x: "count",
          y: "dep_type",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No dep type data for ${selectedPkg}.</p>`
```

## Prerelease exposure

```js
deps.prereleaseExposure.length > 0
  ? Inputs.table(deps.prereleaseExposure, {
      columns: ["project_id", "package_name", "version_resolved", "version_prerelease", "dep_type"],
      header: {
        project_id: "Project",
        package_name: "Package",
        version_resolved: "Resolved",
        version_prerelease: "Prerelease tag",
        dep_type: "Dep type",
      },
    })
  : html`<p style="color:var(--theme-foreground-muted)">No prerelease dependencies found.</p>`
```

## Internal packages

```js
deps.internalPackages.length > 0
  ? Plot.plot({
      marginLeft: 200,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(deps.internalPackages, {
          x: "project_count",
          y: "package_name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No internal packages found. Internal packages are detected automatically from workspace monorepo configurations.</p>`
```

## All dependencies

```js
Inputs.table(filteredDeps, {
  columns: ["project_id", "package_name", "version_resolved", "version_range", "dep_type"],
  header: {
    project_id: "Project",
    package_name: "Package",
    version_resolved: "Resolved",
    version_range: "Range",
    dep_type: "Dep type",
  },
})
```
