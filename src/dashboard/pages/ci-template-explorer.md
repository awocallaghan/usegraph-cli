---
title: CI Template Explorer
---

# CI Template Explorer

<div id="ci-loading-indicator" style="display:flex;align-items:center;gap:10px;padding:1.25rem 0;color:var(--theme-foreground-muted)"><div style="flex-shrink:0;width:18px;height:18px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>Loading CI usage data…<style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>

```js
const _dbStart = performance.now();
const db = await DuckDBClient.of({
  ci_template_usages: FileAttachment("data/ci_template_usages.parquet"),
  ci_template_inputs: FileAttachment("data/ci_template_inputs.parquet"),
});
console.log(`[usegraph] DuckDB init: ${Math.round(performance.now() - _dbStart)}ms`);
```

```js
// Build distinct source list for the selector
const allSources = await db.query(
  `SELECT DISTINCT source FROM ci_template_usages WHERE is_latest = true ORDER BY source`
).then(r => Array.from(r).map(d => d.source));
console.log(`[usegraph] ci-explorer ready: ${Math.round(performance.now() - _dbStart)}ms total`);
```

```js
// Remove loading indicator once data is ready
{
  void allSources;
  document.getElementById("ci-loading-indicator")?.remove();
}
```

```js
// Pre-select from URL params
const urlSource = new URLSearchParams(location.search).get("source");
const urlProvider = new URLSearchParams(location.search).get("provider");

const selectedSource = view(
  allSources.length > 0
    ? Inputs.select(allSources, {
        label: "Template source",
        value: urlSource && allSources.includes(urlSource) ? urlSource : allSources[0],
      })
    : Inputs.text({ label: "Template source", placeholder: "No CI data available", disabled: true })
);
```

```js
// Provider filter
const allProviders = selectedSource
  ? await db.query(
      `SELECT DISTINCT provider FROM ci_template_usages
       WHERE is_latest = true AND source = '${selectedSource.replace(/'/g, "''")}'
       ORDER BY provider`
    ).then(r => Array.from(r).map(d => d.provider))
  : [];
```

```js
const providerEl = allProviders.length > 1
  ? Inputs.select(["All", ...allProviders], {
      label: "Provider",
      value: (urlProvider && allProviders.includes(urlProvider)) ? urlProvider : "All",
    })
  : Inputs.text({ label: "Provider", placeholder: allProviders[0] ?? "—", disabled: true });
const selectedProvider = view(providerEl);
```

```js
// Build WHERE clause
const safeSrc = (selectedSource ?? "").replace(/'/g, "''");
const safeProv = (selectedProvider !== "All" ? selectedProvider : "").replace(/'/g, "''");

const baseWhere = [
  `is_latest = true`,
  safeSrc  ? `source = '${safeSrc}'`       : null,
  safeProv ? `provider = '${safeProv}'`    : null,
].filter(Boolean).join(" AND ");
```

```js
// Query data in parallel
const hasSource = !!selectedSource;

const [projectRows, versionRows, inputRows] = hasSource
  ? await Promise.all([
      // Projects using this template
      db.query(
        `SELECT project_id, provider, template_type, version, file_path, line
         FROM ci_template_usages
         WHERE ${baseWhere}
         ORDER BY project_id, file_path, line`
      ).then(r => Array.from(r)),

      // Version breakdown
      db.query(
        `SELECT version, COUNT(DISTINCT project_id)::INTEGER AS project_count
         FROM ci_template_usages
         WHERE ${baseWhere}
         GROUP BY version
         ORDER BY project_count DESC`
      ).then(r => Array.from(r)),

      // Input values
      db.query(
        `SELECT input_name, value_type, value, COUNT(DISTINCT project_id)::INTEGER AS project_count
         FROM ci_template_inputs
         WHERE ${baseWhere}
         GROUP BY input_name, value_type, value
         ORDER BY input_name, project_count DESC
         LIMIT 200`
      ).then(r => Array.from(r)),
    ])
  : [[], [], []];
```

---

## Projects using ${selectedSource ?? "…"}

```js
function buildFileUrl(projectId, filePath, line) {
  if (!projectId || !filePath) return null;
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
if (!hasSource) {
  display(html`<p style="color:var(--theme-foreground-muted)">Select a template source above to explore usage data.</p>`);
} else if (projectRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No projects found using <strong>${selectedSource}</strong>.</p>`);
} else {
  // Count usages per project for bar chart
  const byProject = d3.rollup(projectRows, v => v.length, d => d.project_id);
  const projectCounts = Array.from(byProject, ([project_id, count]) => ({ project_id, count }))
    .sort((a, b) => b.count - a.count);

  display(Plot.plot({
    marginLeft: 220,
    x: { label: "usages", grid: true },
    y: { label: null },
    marks: [
      Plot.barX(projectCounts, { x: "count", y: "project_id", sort: { y: "-x" }, tip: true }),
      Plot.ruleX([0]),
    ],
  }));
}
```

---

## Version breakdown

```js
if (hasSource && versionRows.length > 0) {
  display(Inputs.table(versionRows, {
    columns: ["version", "project_count"],
    header: { version: "Version / ref", project_count: "Projects" },
    format: { version: v => v ?? html`<em style="color:var(--theme-foreground-muted)">unspecified</em>` },
  }));
} else if (hasSource) {
  display(html`<p style="color:var(--theme-foreground-muted)">No version data available.</p>`);
}
```

---

## Input configuration

```js
if (hasSource && inputRows.length > 0) {
  display(Inputs.table(inputRows, {
    columns: ["input_name", "value_type", "value", "project_count"],
    header: {
      input_name: "Input",
      value_type: "Type",
      value: "Value",
      project_count: "Projects",
    },
    format: {
      value: v => v != null ? String(v).slice(0, 80) : html`<em style="color:var(--theme-foreground-muted)">dynamic</em>`,
    },
  }));
} else if (hasSource) {
  display(html`<p style="color:var(--theme-foreground-muted)">No input data recorded for this template.</p>`);
}
```

---

## All usage sites

```js
if (!hasSource) {
  // nothing — hint shown above
} else if (projectRows.length === 0) {
  display(html`<p style="color:var(--theme-foreground-muted)">No usage sites found.</p>`);
} else {
  const thStyle = "text-align:left;padding:0.5rem 0.75rem;border-bottom:2px solid var(--theme-foreground-faintest);white-space:nowrap";
  const tdStyle = "padding:0.4rem 0.75rem;border-bottom:1px solid var(--theme-foreground-faintest);vertical-align:top";
  display(html`<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:0.875rem">
    <thead><tr>
      <th style="${thStyle}">Project</th>
      <th style="${thStyle}">Version</th>
      <th style="${thStyle}">File</th>
      <th style="${thStyle}">Line</th>
    </tr></thead>
    <tbody>${projectRows.map(d => {
      const url = buildFileUrl(d.project_id, d.file_path, d.line);
      return html`<tr>
        <td style="${tdStyle}"><a href="./project-detail?project=${encodeURIComponent(d.project_id)}">${d.project_id}</a></td>
        <td style="${tdStyle}">${d.version ?? html`<em style="color:var(--theme-foreground-muted)">unspecified</em>`}</td>
        <td style="${tdStyle}">${url ? html`<a href="${url}" target="_blank" rel="noopener">${d.file_path}</a>` : d.file_path}</td>
        <td style="${tdStyle}">${url ? html`<a href="${url}" target="_blank" rel="noopener">${d.line}</a>` : d.line}</td>
      </tr>`;
    })}</tbody>
  </table></div>`);
}
```
