---
title: Component Explorer
---

# Component Explorer

<div id="comp-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading usage data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
// Load both parquet tables via DuckDB WASM
const _dbStart = performance.now();
const db = await DuckDBClient.of({
  component_usages:      FileAttachment("data/component_usages.parquet"),
  component_prop_usages: FileAttachment("data/component_prop_usages.parquet"),
});
console.log(`[usegraph] DuckDB init: ${Math.round(performance.now() - _dbStart)}ms`);
```

```js
// Build distinct package list for the selector
const allPackages = await db.query(
  `SELECT DISTINCT package_name FROM component_usages WHERE is_latest = true ORDER BY package_name`
).then(r => Array.from(r).map(d => d.package_name));
console.log(`[usegraph] component-explorer ready: ${Math.round(performance.now() - _dbStart)}ms total`);
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
const projectSelectEl = allProjects.length > 0
  ? Inputs.select(
      ["All", ...allProjects],
      {
        label: "Project",
        value: (urlProject && allProjects.includes(urlProject)) ? urlProject : "All",
      }
    )
  : Inputs.text({ label: "Project", placeholder: "Select a component first", disabled: true });
const selectedProjectFilter = view(projectSelectEl);
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
const propSelectEl = allProps.length > 0
  ? Inputs.select(["All", ...allProps], { label: "Prop name" })
  : Inputs.text({ label: "Prop name", placeholder: "Select a component first", disabled: true });
const selectedPropFilter = view(propSelectEl);
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

const [projectRows, propFreqRows] = hasSelection
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
    ])
  : [[], []];
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
        render: (index, scales, values, dimensions, context, next) => {
          const g = next(index, scales, values, dimensions, context);
          Array.from(g.querySelectorAll("rect")).forEach((rect, i) => {
            const d = projectRows[index[i]];
            rect.style.cursor = "pointer";
            rect.addEventListener("click", () => {
              projectSelectEl.value = d.project_id;
              projectSelectEl.dispatchEvent(new Event("input", { bubbles: true }));
            });
          });
          return g;
        },
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
        render: (index, scales, values, dimensions, context, next) => {
          const g = next(index, scales, values, dimensions, context);
          Array.from(g.querySelectorAll("rect")).forEach((rect, i) => {
            const d = propFreqRows[index[i]];
            rect.style.cursor = "pointer";
            rect.addEventListener("click", () => {
              propSelectEl.value = d.prop_name;
              propSelectEl.dispatchEvent(new Event("input", { bubbles: true }));
            });
          });
          return g;
        },
      }),
      Plot.ruleX([0]),
    ],
  }));
}
```

---

## All usages

```js
// All individual usage rows with current filters (max 500)
const allUsageRows = hasSelection
  ? await db.query(
      `SELECT project_id, file_path, line, prop_name, value_type, value
       FROM component_prop_usages
       WHERE ${propWhere}
       ORDER BY project_id, file_path, line
       LIMIT 500`
    ).then(r => Array.from(r))
  : [];
```

```js
if (!hasSelection) {
  display(html`<p style="color:var(--theme-foreground-muted)">Select a package and component above to explore usage data.</p>`);
} else if (allUsageRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No usages found for the current filters.</p>`);
} else {
  display(Inputs.table(allUsageRows, {
    columns: ["project_id", "file_path", "line", "prop_name", "value_type", "value"],
    header: {
      project_id: "Project",
      file_path:  "File",
      line:       "Line",
      prop_name:  "Prop",
      value_type: "Type",
      value:      "Value",
    },
    format: {
      project_id: v => {
        const el = document.createElement("span");
        el.textContent = v;
        el.style.cssText = "cursor:pointer;color:var(--theme-blue);text-decoration:underline dotted";
        el.title = `Filter to project: ${v}`;
        el.onclick = () => { projectSelectEl.value = v; projectSelectEl.dispatchEvent(new Event("input", { bubbles: true })); };
        return el;
      },
      prop_name: v => {
        const el = document.createElement("span");
        el.textContent = v;
        el.style.cssText = "cursor:pointer;color:var(--theme-blue);text-decoration:underline dotted";
        el.title = `Filter to prop: ${v}`;
        el.onclick = () => { propSelectEl.value = v; propSelectEl.dispatchEvent(new Event("input", { bubbles: true })); };
        return el;
      },
      value: v => v != null ? String(v).slice(0, 60) : "—",
    },
  }));
}
```

---

## Source snippets

<p style="color:var(--theme-foreground-muted);font-size:0.85rem">Shown when a prop name filter is active and source snippets are available (max 200).</p>

```js
// Build a code file URL when the project slug is a GitHub repo (github.com/owner/repo[/subpath])
function buildFileUrl(projectId, filePath, line) {
  const ghMatch = projectId.match(/^github\.com\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!ghMatch) return null;
  const ownerRepo = ghMatch[1];
  const subPath = ghMatch[2] ? ghMatch[2].slice(1) : null;
  const cleanFile = filePath.replace(/^\//, "");
  const fullPath = subPath ? `${subPath}/${cleanFile}` : cleanFile;
  return `https://github.com/${ownerRepo}/blob/HEAD/${fullPath}${line != null ? `#L${line}` : ""}`;
}
```

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
      ${Array.from(byFile, ([filePath, fileRows]) => {
        const fileUrl = buildFileUrl(projectId, filePath, fileRows[0]?.line);
        return html`
        <div style="margin:0.5rem 0 0.5rem 1rem">
          <code style="font-size:0.8rem;color:var(--theme-foreground-muted)">${fileUrl ? html`<a href="${fileUrl}" target="_blank" rel="noopener">${filePath}</a>` : filePath}</code>
          ${fileRows.map(r => {
            const lineUrl = buildFileUrl(projectId, filePath, r.line);
            return html`
            <div style="margin:0.5rem 0">
              <span style="font-size:0.75rem;color:var(--theme-foreground-muted)">${lineUrl ? html`<a href="${lineUrl}" target="_blank" rel="noopener">line ${r.line}</a>` : `line ${r.line}`} — <strong>${r.prop_name}</strong> (${r.value_type}${r.value != null ? ` = ${String(r.value).slice(0, 60)}` : ""})</span>
              <pre style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:6px;padding:0.75rem;font-size:0.75rem;overflow-x:auto;margin:0.25rem 0 0">${r.source_snippet}</pre>
            </div>
          `})}
        </div>
      `})}
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
      file_path: p => {
        const url = buildFileUrl(selectedProjectFilter, p, null);
        return url ? html`<a href="${url}" target="_blank" rel="noopener">${p}</a>` : p;
      },
      line: (l, d) => {
        const url = buildFileUrl(selectedProjectFilter, d.file_path, l);
        return url ? html`<a href="${url}" target="_blank" rel="noopener">${l}</a>` : l;
      },
      value: v => v != null ? String(v).slice(0, 60) : "—",
    },
  }));
}
```
