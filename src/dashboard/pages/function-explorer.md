---
title: Function Explorer
---

# Function Explorer

<div id="fn-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading usage data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
import { getDB } from "./components/db.js";
```

```js
// Load both parquet tables via DuckDB WASM (singleton: re-used if the module
// cache survives navigation, e.g. with a future client-side router).
const db = await getDB("function-explorer", () => DuckDBClient.of({
  function_usages:     FileAttachment("data/function_usages.parquet"),
  function_arg_usages: FileAttachment("data/function_arg_usages.parquet"),
}));
```

```js
// Build distinct package list for the selector
const allPackages = await db.query(
  `SELECT DISTINCT package_name FROM function_usages WHERE is_latest = true ORDER BY package_name`
).then(r => Array.from(r).map(d => d.package_name));
```

```js
// Remove loading indicator once data is ready
{
  void allPackages;
  document.getElementById("fn-loading-indicator")?.remove();
}
```

```js
// Resolve selected package: pre-select URL param if present, always show input
const urlPackage = new URLSearchParams(location.search).get("package");
const selectedPackage = view(
  allPackages.length > 0
    ? Inputs.select(allPackages, { label: "Package", value: urlPackage && allPackages.includes(urlPackage) ? urlPackage : allPackages[0] })
    : Inputs.text({ label: "Package", placeholder: "No function usage data", disabled: true })
);
```

```js
// Functions available for the selected package
const allFunctions = selectedPackage
  ? await db.query(
      `SELECT DISTINCT export_name
       FROM function_usages
       WHERE is_latest = true AND package_name = '${selectedPackage.replace(/'/g, "''")}'
       ORDER BY export_name`
    ).then(r => Array.from(r).map(d => d.export_name))
  : [];
```

```js
// Resolve selected function: pre-select URL param if present, always show input
const urlFunction = new URLSearchParams(location.search).get("function");
const selectedFunction = view(
  allFunctions.length > 0
    ? Inputs.select(allFunctions, { label: "Function", value: urlFunction && allFunctions.includes(urlFunction) ? urlFunction : allFunctions[0] })
    : Inputs.text({ label: "Function", placeholder: "Select a package first", disabled: true })
);
```

```js
// Projects that use the selected function (resets when function changes)
const allProjects = (selectedPackage && selectedFunction)
  ? await db.query(
      `SELECT DISTINCT project_id
       FROM function_usages
       WHERE is_latest = true
         AND package_name = '${(selectedPackage).replace(/'/g, "''")}'
         AND export_name  = '${(selectedFunction).replace(/'/g, "''")}'
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
  : Inputs.text({ label: "Project", placeholder: "Select a function first", disabled: true });
const selectedProjectFilter = view(projectSelectEl);
```

```js
// Arg indices recorded for the selected function (resets when function changes)
const allArgIndices = (selectedPackage && selectedFunction)
  ? await db.query(
      `SELECT DISTINCT arg_index
       FROM function_arg_usages
       WHERE is_latest = true
         AND package_name = '${(selectedPackage).replace(/'/g, "''")}'
         AND export_name  = '${(selectedFunction).replace(/'/g, "''")}'
       ORDER BY arg_index`
    ).then(r => Array.from(r).map(d => d.arg_index))
  : [];

const argIndexOptions = ["All", ...allArgIndices.map(i => `Arg ${i}`)];
```

```js
// Arg index dropdown (resets when function changes)
const argSelectEl = allArgIndices.length > 0
  ? Inputs.select(argIndexOptions, { label: "Arg index" })
  : Inputs.text({ label: "Arg index", placeholder: "Select a function first", disabled: true });
const selectedArgLabel = view(argSelectEl);
```

```js
// Resolve the raw integer from the label — must be a separate cell so
// selectedArgLabel is the reactive VALUE (string), not the input element.
const selectedArgIndex = (typeof selectedArgLabel === "string" && selectedArgLabel !== "All")
  ? parseInt(selectedArgLabel.replace("Arg ", ""), 10)
  : null;
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
const safeFn   = (selectedFunction ?? "").replace(/'/g, "''");
const safeProj = (selectedProjectFilter !== "All" ? selectedProjectFilter : "").replace(/'/g, "''");

const baseWhere = [
  `is_latest = true`,
  safePkg  ? `package_name = '${safePkg}'`    : null,
  safeFn   ? `export_name  = '${safeFn}'`     : null,
  safeProj ? `project_id   = '${safeProj}'`   : null,
].filter(Boolean).join(" AND ");

const argWhere = [
  baseWhere,
  selectedArgIndex !== null           ? `arg_index  = ${selectedArgIndex}`     : null,
  valueTypeFilter !== "All"           ? `value_type = '${valueTypeFilter}'`    : null,
].filter(Boolean).join(" AND ");
```

```js
// Fleet-wide most-called functions (shown on landing before a function is selected)
const fleetRows = (!selectedFunction && selectedPackage)
  ? await db.query(
      `SELECT export_name, package_name, COUNT(*)::INTEGER AS total_calls
       FROM function_usages
       WHERE is_latest = true AND package_name = '${safePkg}'
       GROUP BY export_name, package_name
       ORDER BY total_calls DESC
       LIMIT 40`
    ).then(r => Array.from(r))
  : (!selectedFunction)
    ? await db.query(
        `SELECT export_name, package_name, COUNT(*)::INTEGER AS total_calls
         FROM function_usages
         WHERE is_latest = true
         GROUP BY export_name, package_name
         ORDER BY total_calls DESC
         LIMIT 40`
      ).then(r => Array.from(r))
    : [];
```

```js
// Run per-function queries in parallel once a function is selected
const hasSelection = !!(selectedPackage && selectedFunction);

const [projectRows, argPatternRows] = hasSelection
  ? await Promise.all([
      // Projects using this function
      db.query(
        `SELECT project_id, COUNT(*)::INTEGER AS call_count
         FROM function_usages
         WHERE ${baseWhere}
         GROUP BY project_id
         ORDER BY call_count DESC`
      ).then(r => Array.from(r)),

      // Arg pattern: value_type + raw type distribution per arg_index
      db.query(
        `SELECT arg_index, value_type, COUNT(*)::INTEGER AS n
         FROM function_arg_usages
         WHERE ${argWhere}
         GROUP BY arg_index, value_type
         ORDER BY arg_index, n DESC`
      ).then(r => Array.from(r)),
    ])
  : [[], []];
```

```js
// Source snippet rows (only when arg_index filter is active)
const snippetRows = (hasSelection && selectedArgIndex !== null)
  ? await db.query(
      `SELECT project_id, file_path, line, arg_index, value_type, value, source_snippet
       FROM function_arg_usages
       WHERE ${argWhere} AND source_snippet IS NOT NULL
       ORDER BY project_id, file_path, line
       LIMIT 200`
    ).then(r => Array.from(r))
  : [];

// Files drilldown (only when project filter is active)
const fileRows = (hasSelection && safeProj)
  ? await db.query(
      `SELECT file_path, line, arg_index, arg_name, value_type, value
       FROM function_arg_usages
       WHERE ${argWhere}
       ORDER BY file_path, line, arg_index
       LIMIT 500`
    ).then(r => Array.from(r))
  : [];
```

---

## Most called functions

```js
if (!hasSelection && fleetRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No function usage data available.</p>`);
} else if (!hasSelection) {
  display(Plot.plot({
    marginLeft: 200,
    x: { label: "calls", grid: true },
    y: { label: null },
    color: { legend: allPackages.length > 1 },
    marks: [
      Plot.barX(fleetRows, {
        x: "total_calls",
        y: "export_name",
        fill: "package_name",
        sort: { y: "-x" },
        tip: true,
      }),
      Plot.ruleX([0]),
    ],
  }));
}
```

---

## Projects using ${selectedFunction ?? "…"}

```js
if (!hasSelection) {
  display(html`<p style="color:var(--theme-foreground-muted)">Select a package and function above to explore call data.</p>`);
} else if (projectRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No projects found calling <strong>${selectedFunction}</strong> from <strong>${selectedPackage}</strong>.</p>`);
} else {
  display(Plot.plot({
    marginLeft: 220,
    x: { label: "calls", grid: true },
    y: { label: null },
    marks: [
      Plot.barX(projectRows, {
        x: "call_count",
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

## Arg pattern analysis

```js
if (hasSelection && argPatternRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No argument usage data found${selectedArgIndex !== null ? ` for Arg ${selectedArgIndex}` : ""}.</p>`);
} else if (hasSelection) {
  // Group by arg_index for individual panels
  const byArg = d3.group(argPatternRows, d => d.arg_index);

  display(html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1.5rem">${
    Array.from(byArg, ([argIdx, rows]) => {
      const total = d3.sum(rows, d => d.n);
      return html`<div style="background:var(--theme-background-alt);border:1px solid var(--theme-foreground-faintest);border-radius:8px;padding:1rem">
        <div style="font-weight:600;margin-bottom:0.5rem"><span style="cursor:pointer;text-decoration:underline dotted" onclick=${() => { argSelectEl.value = `Arg ${argIdx}`; argSelectEl.dispatchEvent(new Event("input", { bubbles: true })); }}>Arg ${argIdx}</span> <span style="font-size:0.75rem;color:var(--theme-foreground-muted)">(${total.toLocaleString()} calls)</span></div>
        ${Plot.plot({
          height: 120,
          marginLeft: 80,
          x: { label: null, grid: true },
          y: { label: null },
          color: { domain: ["static", "dynamic"], range: ["steelblue", "orange"] },
          marks: [
            Plot.barX(rows, { x: "n", y: "value_type", fill: "value_type", tip: true }),
            Plot.ruleX([0]),
          ],
        })}
      </div>`;
    })
  }</div>`);
}
```

---

## All usages

```js
// All individual usage rows with current filters (max 500)
const allUsageRows = hasSelection
  ? await db.query(
      `SELECT project_id, file_path, line, arg_index, arg_name, value_type, value
       FROM function_arg_usages
       WHERE ${argWhere}
       ORDER BY project_id, file_path, line, arg_index
       LIMIT 500`
    ).then(r => Array.from(r))
  : [];
```

```js
if (!hasSelection) {
  display(html`<p style="color:var(--theme-foreground-muted)">Select a package and function above to explore usage data.</p>`);
} else if (allUsageRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No usages found for the current filters.</p>`);
} else {
  display(Inputs.table(allUsageRows, {
    columns: ["project_id", "file_path", "line", "arg_index", "arg_name", "value_type", "value"],
    header: {
      project_id: "Project",
      file_path:  "File",
      line:       "Line",
      arg_index:  "Arg",
      arg_name:   "Name",
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
      arg_index: i => {
        const el = document.createElement("span");
        el.textContent = `Arg ${i}`;
        el.style.cssText = "cursor:pointer;color:var(--theme-blue);text-decoration:underline dotted";
        el.title = `Filter to Arg ${i}`;
        el.onclick = () => { argSelectEl.value = `Arg ${i}`; argSelectEl.dispatchEvent(new Event("input", { bubbles: true })); };
        return el;
      },
      arg_name:  n => n ?? "—",
      value:     v => v != null ? String(v).slice(0, 60) : "—",
    },
  }));
}
```

---

## Source snippets

<p style="color:var(--theme-foreground-muted);font-size:0.85rem">Shown when an arg index filter is active and source snippets are available (max 200).</p>

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
  // nothing
} else if (selectedArgIndex === null) {
  display(html`<p style="color:var(--theme-foreground-muted)">Select a specific <strong>arg index</strong> above to surface source snippets.</p>`);
} else if (snippetRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No source snippets available for the current filters.</p>`);
} else {
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
              <span style="font-size:0.75rem;color:var(--theme-foreground-muted)">${lineUrl ? html`<a href="${lineUrl}" target="_blank" rel="noopener">line ${r.line}</a>` : `line ${r.line}`} — <strong>Arg ${r.arg_index}</strong> (${r.value_type}${r.value != null ? ` = ${String(r.value).slice(0, 60)}` : ""})</span>
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
    columns: ["file_path", "line", "arg_index", "arg_name", "value_type", "value"],
    header: {
      file_path:  "File",
      line:       "Line",
      arg_index:  "Arg",
      arg_name:   "Name",
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
      arg_index: i => `Arg ${i}`,
      arg_name:  n => n ?? "—",
      value:     v => v != null ? String(v).slice(0, 60) : "—",
    },
  }));
}
```
