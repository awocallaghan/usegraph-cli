---
title: Overview
---

# usegraph overview

```js
const overview = await FileAttachment("data/overview.json").json();
const ciOverview = await FileAttachment("data/ci_overview.json").json();
```

```js
// Stat cards
html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem">${
  [
    ["Projects", overview.projects.length],
    ["Component Usages", overview.totalComponentUsages],
    ["Function Calls", overview.totalFunctionUsages],
    ["CI Template Usages", ciOverview.totalUsages],
  ].map(([label, value]) =>
    html`<div style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:8px;padding:1.25rem">
      <div style="font-size:2rem;font-weight:700;color:var(--theme-foreground-focus)">${value.toLocaleString()}</div>
      <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--theme-foreground-muted);margin-top:0.25rem">${label}</div>
    </div>`
  )
}</div>`
```

## Framework distribution

```js
overview.frameworkCounts.length > 0
  ? Plot.plot({
      marginLeft: 100,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(overview.frameworkCounts, {
          x: "count",
          y: "name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No framework data available.</p>`
```

## Build tool distribution

```js
overview.buildToolCounts.length > 0
  ? Plot.plot({
      marginLeft: 100,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(overview.buildToolCounts, {
          x: "count",
          y: "name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No build tool data available.</p>`
```

## Package manager distribution

```js
overview.packageManagerCounts.length > 0
  ? Plot.plot({
      marginLeft: 100,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(overview.packageManagerCounts, {
          x: "count",
          y: "name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No package manager data available.</p>`
```

## CI templates

```js
ciOverview.totalUsages > 0
  ? html`<p>Detected <strong>${ciOverview.totalUsages.toLocaleString()}</strong> CI template usages across <strong>${ciOverview.projectCount}</strong> projects. <a href="./ci-overview">View CI overview →</a></p>`
  : html`<p style="color:var(--theme-foreground-muted)">No CI template data yet. Run <code>usegraph scan</code> on projects with CI files, then <code>usegraph build</code>.</p>`
```

## Projects

```js
Inputs.table(overview.projects, {
  columns: ["project_id", "framework", "build_tool", "package_manager", "code_at", "scanned_at"],
  header: {
    project_id: "Project",
    framework: "Framework",
    build_tool: "Build tool",
    package_manager: "Pkg manager",
    code_at: "Code state",
    scanned_at: "Last scanned",
  },
  format: {
    project_id: (d) => html`<a href="./project-detail?project=${encodeURIComponent(d)}">${d}</a>`,
    code_at: (d) => d ? new Date(d).toLocaleString() : "—",
    scanned_at: (d) => new Date(d).toLocaleString(),
  },
})
```
