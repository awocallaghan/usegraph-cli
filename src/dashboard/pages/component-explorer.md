---
title: Component Explorer
---

# Component Explorer

<div id="comp-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading usage data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
// Load both parquet tables via DuckDB WASM
const db = await DuckDBClient.of({
  component_usages:      FileAttachment("data/component_usages.parquet"),
  component_prop_usages: FileAttachment("data/component_prop_usages.parquet"),
});
```

```js
// Build distinct package list for the selector
const allPackages = await db.query(
  `SELECT DISTINCT package_name FROM component_usages WHERE is_latest = true ORDER BY package_name`
).then(r => Array.from(r).map(d => d.package_name));
```

```js
// Remove loading indicator once data is ready
{
  void allPackages;
  document.getElementById("comp-loading-indicator")?.remove();
}
```

```js
// Resolve selected package: pre-select URL param if present, always show input
const urlPackage = new URLSearchParams(location.search).get("package");
const selectedPackage = view(
  allPackages.length > 0
    ? Inputs.select(allPackages, { label: "Package", value: urlPackage && allPackages.includes(urlPackage) ? urlPackage : allPackages[0] })
    : Inputs.text({ label: "Package", placeholder: "No component usage data", disabled: true })
);
```

```js
// Components available for the selected package
const allComponents = selectedPackage
  ? await db.query(
      `SELECT DISTINCT component_name
       FROM component_usages
       WHERE is_latest = true AND package_name = '${selectedPackage.replace(/'/g, "''")}'
       ORDER BY component_name`
    ).then(r => Array.from(r).map(d => d.component_name))
  : [];
```

```js
// Resolve selected component: pre-select URL param if present, always show input
const urlComponent = new URLSearchParams(location.search).get("component");
const selectedComponent = view(
  allComponents.length > 0
    ? Inputs.select(allComponents, { label: "Component", value: urlComponent && allComponents.includes(urlComponent) ? urlComponent : allComponents[0] })
    : Inputs.text({ label: "Component", placeholder: "Select a package first", disabled: true })
);
```

```js
// Projects that use the selected component (resets when component changes)
const allProjects = (selectedPackage && selectedComponent)
  ? await db.query(
      `SELECT DISTINCT project_id
       FROM component_usages
       WHERE is_latest = true
         AND package_name    = '${(selectedPackage).replace(/'/g, "''")}'
         AND component_name  = '${(selectedComponent).replace(/'/g, "''")}'
       ORDER BY project_id`
    ).then(r => Array.from(r).map(d => d.project_id))
  : [];
```

```js
// Resolve selected project: URL param → dropdown fallback
const urlProject = new URLSearchParams(location.search).get("project");
const selectedProjectFilter = view(
  allProjects.length > 0
    ? Inputs.select(
        ["All", ...allProjects],
        {
          label: "Project",
          value: (urlProject && allProjects.includes(urlProject)) ? urlProject : "All",
        }
      )
    : Inputs.text({ label: "Project", placeholder: "Select a component first", disabled: true })
);
```

```js
// Prop names recorded for the selected component (resets when component changes)
const allProps = (selectedPackage && selectedComponent)
  ? await db.query(
      `SELECT DISTINCT prop_name
       FROM component_prop_usages
       WHERE is_latest = true
         AND package_name   = '${(selectedPackage).replace(/'/g, "''")}'
         AND component_name = '${(selectedComponent).replace(/'/g, "''")}'
       ORDER BY prop_name`
    ).then(r => Array.from(r).map(d => d.prop_name))
  : [];
```

```js
// Prop name dropdown (resets when component changes)
const selectedPropFilter = view(
  allProps.length > 0
    ? Inputs.select(["All", ...allProps], { label: "Prop name" })
    : Inputs.text({ label: "Prop name", placeholder: "Select a component first", disabled: true })
);
```

```js
// value_type filter — only shown once data has loaded
void allPackages;
const valueTypeFilter = view(
  Inputs.select(["All", "static", "dynamic"], { label: "Value type" })
);
```

```js
// Build reusable WHERE clause fragments (safe-escaped)
const safePkg  = (selectedPackage  ?? "").replace(/'/g, "''");
const safeCmp  = (selectedComponent ?? "").replace(/'/g, "''");
const safeProj = (selectedProjectFilter !== "All" ? selectedProjectFilter : "").replace(/'/g, "''");
const safeProp = (selectedPropFilter    !== "All" ? selectedPropFilter    : "").replace(/'/g, "''");

const baseWhere = [
  `is_latest = true`,
  safePkg  ? `package_name = '${safePkg}'`     : null,
  safeCmp  ? `component_name = '${safeCmp}'`   : null,
  safeProj ? `project_id = '${safeProj}'`      : null,
].filter(Boolean).join(" AND ");

const propWhere = [
  baseWhere,
  safeProp                        ? `prop_name = '${safeProp}'`          : null,
  valueTypeFilter !== "All"       ? `value_type = '${valueTypeFilter}'` : null,
].filter(Boolean).join(" AND ");
```

```js
// Run all queries in parallel once the component selection is complete
const hasSelection = !!(selectedPackage && selectedComponent);

const [projectRows, propFreqRows, staticDynamicRows, topValuesRows] = hasSelection
  ? await Promise.all([
      // Projects using this component
      db.query(
        `SELECT project_id, COUNT(*)::INTEGER AS usage_count
         FROM component_usages
         WHERE ${baseWhere}
         GROUP BY project_id
         ORDER BY usage_count DESC`
      ).then(r => Array.from(r)),

      // Prop frequency
      db.query(
        `SELECT prop_name, COUNT(*)::INTEGER AS usage_count
         FROM component_prop_usages
         WHERE ${propWhere}
         GROUP BY prop_name
         ORDER BY usage_count DESC
         LIMIT 40`
      ).then(r => Array.from(r)),

      // Static vs dynamic ratio per prop
      db.query(
        `SELECT prop_name, value_type, COUNT(*)::INTEGER AS n
         FROM component_prop_usages
         WHERE ${propWhere}
         GROUP BY prop_name, value_type
         ORDER BY prop_name, value_type`
      ).then(r => Array.from(r)),

      // Top static values
      db.query(
        `SELECT prop_name, value, COUNT(*)::INTEGER AS n
         FROM component_prop_usages
         WHERE ${propWhere} AND value_type = 'static' AND value IS NOT NULL
         GROUP BY prop_name, value
         ORDER BY n DESC
         LIMIT 50`
      ).then(r => Array.from(r)),
    ])
  : [[], [], [], []];
```

```js
// Files + snippets query (only when prop filter or project filter is active)
const snippetRows = (hasSelection && (safeProp || safeProj))
  ? await db.query(
      `SELECT project_id, file_path, line, prop_name, value_type, value, source_snippet
       FROM component_prop_usages
       WHERE ${propWhere} AND source_snippet IS NOT NULL
       ORDER BY project_id, file_path, line
       LIMIT 200`
    ).then(r => Array.from(r))
  : [];

// Files drilldown (active when project filter is set)
const fileRows = (hasSelection && safeProj)
  ? await db.query(
      `SELECT file_path, line, prop_name, value_type, value
       FROM component_prop_usages
       WHERE ${propWhere}
       ORDER BY file_path, line
       LIMIT 500`
    ).then(r => Array.from(r))
  : [];
```

---

## Projects using ${selectedComponent ?? "…"}

```js
if (!hasSelection) {
  display(html`<p style="color:var(--theme-foreground-muted)">Select a package and component above to explore usage data.</p>`);
} else if (projectRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No projects found using <strong>${selectedComponent}</strong> from <strong>${selectedPackage}</strong>.</p>`);
} else {
  display(Plot.plot({
    marginLeft: 220,
    x: { label: "usages", grid: true },
    y: { label: null },
    marks: [
      Plot.barX(projectRows, {
        x: "usage_count",
        y: "project_id",
        sort: { y: "-x" },
        tip: true,
      }),
      Plot.ruleX([0]),
    ],
  }));
}
```

---

## Prop usage breakdown

```js
if (hasSelection && propFreqRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No prop usage data found${safeProp ? ` for prop "${selectedPropFilter}"` : ""}.</p>`);
} else if (hasSelection) {
  display(Plot.plot({
    marginLeft: 160,
    x: { label: "usages", grid: true },
    y: { label: null },
    marks: [
      Plot.barX(propFreqRows, {
        x: "usage_count",
        y: "prop_name",
        sort: { y: "-x" },
        tip: true,
      }),
      Plot.ruleX([0]),
    ],
  }));
}
```

---

## Static vs dynamic ratio

```js
if (hasSelection && staticDynamicRows.length > 0) {
  // Only show props that appear in both static+dynamic (or either); top 20 by total
  const totals = d3.rollup(staticDynamicRows, v => d3.sum(v, d => d.n), d => d.prop_name);
  const top20Props = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([k]) => k);
  const ratioRows = staticDynamicRows.filter(d => top20Props.includes(d.prop_name));

  display(Plot.plot({
    marginLeft: 160,
    x: { label: "usages", grid: true, percent: false },
    y: { label: null },
    color: { legend: true, domain: ["static", "dynamic"], range: ["steelblue", "orange"] },
    marks: [
      Plot.barX(ratioRows, {
        x: "n",
        y: "prop_name",
        fill: "value_type",
        sort: { y: "x", reverse: true },
        tip: true,
        offset: "normalize",
      }),
      Plot.ruleX([0, 1]),
    ],
  }));
} else if (hasSelection) {
  display(html`<p style="color:var(--theme-foreground-muted)">No prop data to compute ratio.</p>`);
}
```

---

## Top static values

```js
if (hasSelection && topValuesRows.length > 0) {
  display(Inputs.table(topValuesRows, {
    columns: ["prop_name", "value", "n"],
    header: { prop_name: "Prop", value: "Value", n: "Count" },
    sort: "n",
    reverse: true,
  }));
} else if (hasSelection) {
  display(html`<p style="color:var(--theme-foreground-muted)">No static values found.</p>`);
}
```

---

## Source snippets

<p style="color:var(--theme-foreground-muted);font-size:0.85rem">Shown when a prop name filter is active and source snippets are available (max 200).</p>

```js
if (!hasSelection) {
  // nothing — top-level message shown above
} else if (!safeProp && !safeProj) {
  display(html`<p style="color:var(--theme-foreground-muted)">Apply a <strong>prop name</strong> or <strong>project</strong> filter above to surface source snippets.</p>`);
} else if (snippetRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No source snippets available for the current filters.</p>`);
} else {
  // Group by project_id → file_path
  const byProject = d3.group(snippetRows, d => d.project_id);
  display(html`<div>${Array.from(byProject, ([projectId, projRows]) => {
    const byFile = d3.group(projRows, d => d.file_path);
    return html`<details open>
      <summary style="font-weight:600;cursor:pointer;margin:1rem 0 0.5rem">
        <a href="/project-detail?project=${encodeURIComponent(projectId)}">${projectId}</a>
      </summary>
      ${Array.from(byFile, ([filePath, fileRows]) => html`
        <div style="margin:0.5rem 0 0.5rem 1rem">
          <code style="font-size:0.8rem;color:var(--theme-foreground-muted)">${filePath}</code>
          ${fileRows.map(r => html`
            <div style="margin:0.5rem 0">
              <span style="font-size:0.75rem;color:var(--theme-foreground-muted)">line ${r.line} — <strong>${r.prop_name}</strong> (${r.value_type}${r.value != null ? ` = ${String(r.value).slice(0, 60)}` : ""})</span>
              <pre style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:6px;padding:0.75rem;font-size:0.75rem;overflow-x:auto;margin:0.25rem 0 0">${r.source_snippet}</pre>
            </div>
          `)}
        </div>
      `)}
    </details>`;
  })}</div>`);
}
```

---

## Files breakdown

<p style="color:var(--theme-foreground-muted);font-size:0.85rem">Shown when a project filter is active.</p>

```js
if (!hasSelection || !safeProj) {
  // nothing shown — hint is in the paragraph above
} else if (fileRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No files found for <strong>${selectedProjectFilter}</strong> with the current filters.</p>`);
} else {
  display(Inputs.table(fileRows, {
    columns: ["file_path", "line", "prop_name", "value_type", "value"],
    header: {
      file_path:  "File",
      line:       "Line",
      prop_name:  "Prop",
      value_type: "Type",
      value:      "Value",
    },
    format: {
      value: v => v != null ? String(v).slice(0, 60) : "—",
    },
  }));
}
```
