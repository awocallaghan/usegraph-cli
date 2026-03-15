/**
 * Prompt template for the monthly_package_digest MCP prompt.
 *
 * Instructs an LLM how to interpret a PackageHealthResult JSON blob into a
 * readable monthly digest for a library team.
 */

export const MONTHLY_PACKAGE_DIGEST_PROMPT = `
You are analysing structured usage data for an npm or Python package across a fleet of consumer projects.
The data is provided as a JSON object conforming to the PackageHealthResult schema.

Your task is to write a **monthly package digest** for the library team. Follow these rules strictly:

## Structure

1. **Executive Summary** (1 paragraph, ~3–5 sentences)
   - State the package name and period covered.
   - Summarise the adoption trend (is usage growing, flat, or declining?).
   - Call out the most significant usage-level change in one sentence.
   - Flag any coverage warning if present — do NOT treat partial data as complete.

2. **Adoption Changes**
   - Report start, end, and delta counts for the stable corpus.
   - Name every new adopter and every churned project explicitly.
   - If addedProjects or removedProjects are non-empty, mention them separately
     and note they are excluded from delta calculations (not the same as adoption churn).

3. **Component & Function Usage Changes**
   - Treat component changes and function call changes as equally important.
   - For each entry in componentChanges.deltas:
     - State whether it is a component or function.
     - List added call sites with their project and file.
     - List removed call sites with their project and file.
     - Note stable count.
   - For function call sites, **highlight argument pattern changes** where args data is present.
     For example, if a function was previously called with fewer arguments and now has more
     across multiple projects, that is a meaningful API-usage signal.
   - Flag components or functions with **significant churn**, defined as:
     * added or removed count >= 3, OR
     * (added + removed) / (stable + added + removed) > 10%
   - List unchanged components/functions briefly at the end of this section.

4. **Version Distribution**
   - Show the version spread from versions.distribution.
   - Call out any lagging projects (more than 1 major behind) by name.
   - Call out any projects on prerelease builds (alpha/beta/rc) by name.

5. **Coverage**
   - State projectsCovered / projectsExpected.
   - If a warning is present in coverage.warning, reproduce it verbatim and
     explicitly note that findings may be incomplete.
   - List any gap projects by name.

## Tone and style

- Be specific: name projects, files, and functions — do not generalise away detail that is in the data.
- Do NOT invent conclusions not supported by the data. If something is ambiguous, say so.
- Keep total length **under 500 words** unless the number of deltas is large (> 10 changed
  components/functions), in which case you may go longer to preserve accuracy.
- Use plain markdown (headers, bullet lists). No tables required.
- Do not repeat the raw JSON or schema field names in the output.

## Input format

The user will provide a JSON object. Parse it and write the digest above.
`.trim();
