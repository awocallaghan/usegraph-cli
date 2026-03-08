---
title: CI Overview
---

# CI Template Usage

```js
const ciOverview = await FileAttachment("data/ci_overview.json").json();
```

```js
// Stat cards
html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem">${
  [
    ["Template Usages", ciOverview.totalUsages],
    ["Projects with CI", ciOverview.projectCount],
    ["Providers", ciOverview.providerCounts.length],
  ].map(([label, value]) =>
    html`<div style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:8px;padding:1.25rem">
      <div style="font-size:2rem;font-weight:700;color:var(--theme-foreground-focus)">${typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--theme-foreground-muted);margin-top:0.25rem">${label}</div>
    </div>`
  )
}</div>`
```

## Provider breakdown

```js
ciOverview.providerCounts.length > 0
  ? Plot.plot({
      marginLeft: 80,
      x: { label: "usages", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(ciOverview.providerCounts, {
          x: "count",
          y: "name",
          sort: { y: "-x" },
          tip: true,
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No CI data available. Run <code>usegraph scan</code> on projects that have CI configuration files, then <code>usegraph build</code>.</p>`
```

## Top templates by adoption

```js
ciOverview.topTemplates.length > 0
  ? Plot.plot({
      marginLeft: 260,
      x: { label: "projects", grid: true },
      y: { label: null },
      marks: [
        Plot.barX(ciOverview.topTemplates, {
          x: "project_count",
          y: "source",
          sort: { y: "-x" },
          tip: true,
          render: (index, scales, values, dimensions, context, next) => {
            const g = next(index, scales, values, dimensions, context);
            Array.from(g.querySelectorAll("rect")).forEach((rect, i) => {
              const d = ciOverview.topTemplates[index[i]];
              rect.style.cursor = "pointer";
              rect.addEventListener("click", () => {
                window.location.href = `./ci-template-explorer?source=${encodeURIComponent(d.source)}&provider=${encodeURIComponent(d.provider)}`;
              });
            });
            return g;
          },
        }),
        Plot.ruleX([0]),
      ],
    })
  : html`<p style="color:var(--theme-foreground-muted)">No template data available.</p>`
```

## All templates

```js
ciOverview.topTemplates.length > 0
  ? Inputs.table(ciOverview.topTemplates, {
      columns: ["source", "provider", "template_type", "project_count"],
      header: {
        source: "Template",
        provider: "Provider",
        template_type: "Type",
        project_count: "Projects",
      },
      format: {
        source: (d) => html`<a href="./ci-template-explorer?source=${encodeURIComponent(d)}">${d}</a>`,
      },
    })
  : html`<p style="color:var(--theme-foreground-muted)">No data available.</p>`
```
