/**
 * Python source file analyzer.
 *
 * Extracts import declarations and usages of tracked packages from `.py`
 * files using a regex-based parser (no Python runtime required).
 *
 * Handles:
 *  - Named imports:     from fastapi import FastAPI, HTTPException
 *  - Aliased imports:   from fastapi import FastAPI as App
 *  - Namespace imports: import pandas as pd
 *  - Module imports:    import os.path  (top-level package = os)
 *  - Function calls:    Flask(__name__)
 *  - Namespace calls:   pd.DataFrame(data)
 *  - Method chains:     router.get("/")
 */
import { readFile } from 'fs/promises';
import { relative } from 'path';
import type {
  FileAnalysis,
  ImportInfo,
  ImportSpecifierInfo,
  FunctionCallInfo,
  ArgInfo,
} from '../types.js';

// ─── Internal import tracking ─────────────────────────────────────────────────

interface NameEntry {
  /** Top-level package name (e.g. "fastapi" from "from fastapi.routing import ...") */
  source: string;
  /** Original exported name */
  imported: string;
  type: ImportSpecifierInfo['type'];
}

type ImportMap = Map<string, NameEntry>;   // localName → entry
type NamespaceMap = Map<string, string>;   // localAlias → packageSource

// ─── Regex patterns ───────────────────────────────────────────────────────────

// Match: import X, import X.Y, import X as Y, import X.Y as Z
const SIMPLE_IMPORT_RE = /^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?[ \t]*(?:#.*)?$/gm;

// Match: from X import Y  or  from X import Y, Z  or  from X import (Y, Z)
// The import list is captured as a raw string (may span to next line for parenthesised form;
// we only handle single-line for now — covers the vast majority of real-world usage).
const FROM_IMPORT_RE = /^[ \t]*from\s+([\w.]+)\s+import\s+([^\\#\n]+)/gm;

// Match individual names in the import list: Name or Name as alias
const NAME_ALIAS_RE = /(\w+)(?:\s+as\s+(\w+))?/g;

// ─── Source pre-processing ─────────────────────────────────────────────────────

/**
 * Normalise multi-line parenthesised imports onto a single line so that
 * FROM_IMPORT_RE can match them without needing to span newlines.
 *
 * Example:
 *   from fastapi import (   →   from fastapi import FastAPI, HTTPException
 *       FastAPI,
 *       HTTPException,
 *   )
 *
 * Only rewrites `from X import (...)` blocks; leaves everything else intact.
 */
function normalizeMultiLineImports(source: string): string {
  return source.replace(
    /^([ \t]*from\s+[\w.]+\s+import\s*)\(\s*\n([\s\S]*?)\)/gm,
    (_, prefix: string, body: string) => {
      // Flatten the body: strip leading whitespace + trailing commas/comments
      const names = body
        .split('\n')
        .map((l: string) => l.replace(/#.*$/, '').trim().replace(/,\s*$/, ''))
        .filter((l: string) => l.length > 0)
        .join(', ');
      return `${prefix}${names}`;
    },
  );
}

// Match function/class calls: Identifier(  or  identifier.Identifier(
// We capture line positions by scanning the source line-by-line.
const CALL_RE = /\b([\w]+)\s*\(/g;
const MEMBER_CALL_RE = /\b([\w]+)\.([\w]+)\s*\(/g;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the top-level package name from a dotted module path. */
function topLevelPackage(modulePath: string): string {
  return modulePath.split('.')[0];
}

/** Check whether a module path refers to an external (third-party) package. */
function isExternalModule(modulePath: string): boolean {
  // Skip relative imports (from . import foo, from .. import foo)
  if (modulePath.startsWith('.')) return false;
  // Skip well-known stdlib top-level names (non-exhaustive but covers the most common)
  const stdlib = new Set([
    'abc', 'ast', 'asyncio', 'base64', 'builtins', 'collections', 'contextlib',
    'copy', 'csv', 'dataclasses', 'datetime', 'decimal', 'email', 'enum',
    'errno', 'functools', 'gc', 'glob', 'hashlib', 'http', 'importlib',
    'inspect', 'io', 'itertools', 'json', 'logging', 'math', 'multiprocessing',
    'operator', 'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue',
    're', 'shutil', 'signal', 'socket', 'sqlite3', 'ssl', 'stat', 'string',
    'struct', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading', 'time',
    'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib',
    'uuid', 'warnings', 'weakref', 'xml', 'xmlrpc', 'zipfile',
    // Python 3 extras
    'zoneinfo', 'tomllib', 'graphlib',
    // Private/internal convention
    '__future__',
  ]);
  return !stdlib.has(topLevelPackage(modulePath));
}

/** Check whether the given package name is in the set of target packages. */
function isTarget(packageName: string, targets: Set<string>): boolean {
  return targets.has(packageName);
}

/**
 * Build a map from line index (0-based) to character offset where the line starts.
 * Used to convert absolute character offsets to line/column numbers.
 */
function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Convert an absolute character offset to 1-based line/col. */
function offsetToLineCol(offset: number, lineStarts: number[]): { line: number; col: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
}

/** Extract ~5 lines of context centred around a 1-based line number. */
function extractSnippet(sourceLines: string[], line: number): string {
  const start = Math.max(0, line - 2);
  const end = Math.min(sourceLines.length, line + 3);
  return sourceLines.slice(start, end).join('\n');
}

/**
 * Parse a Python argument list string (the text inside the outermost parens)
 * into a list of ArgInfo entries.
 *
 * This is intentionally simple — we only recognise static literals and
 * mark everything else as 'expression'.  Nested parens/brackets are handled
 * by counting depth so we split on top-level commas only.
 */
function parseArgs(argsText: string, line: number, sourceLines: string[]): ArgInfo[] {
  const parts = splitTopLevel(argsText);
  const args: ArgInfo[] = [];

  for (let i = 0; i < parts.length; i++) {
    let raw = parts[i].trim();
    if (!raw) continue;

    // Strip keyword argument prefix: `name=value` → `value`
    // But don't strip if it's a comparison expression (rare in call sites)
    const kwMatch = raw.match(/^\w+\s*=\s*(?!=)/);
    if (kwMatch) raw = raw.slice(kwMatch[0].length).trim();

    // Spread (*args, **kwargs)
    if (raw.startsWith('*')) {
      args.push({ index: i, type: 'spread', isSpread: true, sourceSnippet: null });
      continue;
    }

    // String literal  (single- or double-quoted, including triple-quoted start)
    const strMatch = raw.match(/^(?:f?r?b?|b?r?f?)(['"])(.*)\1$/s);
    if (strMatch) {
      args.push({ index: i, type: 'string', value: strMatch[2], isSpread: false, sourceSnippet: null });
      continue;
    }

    // Integer or float literal
    const numMatch = raw.match(/^-?\d+(?:\.\d+)?$/);
    if (numMatch) {
      args.push({ index: i, type: 'number', value: Number(raw), isSpread: false, sourceSnippet: null });
      continue;
    }

    // Boolean / None
    if (raw === 'True') { args.push({ index: i, type: 'boolean', value: true, isSpread: false, sourceSnippet: null }); continue; }
    if (raw === 'False') { args.push({ index: i, type: 'boolean', value: false, isSpread: false, sourceSnippet: null }); continue; }
    if (raw === 'None') { args.push({ index: i, type: 'null', isSpread: false, sourceSnippet: null }); continue; }

    // Everything else: dynamic expression
    const snippet = extractSnippet(sourceLines, line);
    args.push({ index: i, type: 'expression', isSpread: false, sourceSnippet: snippet });
  }

  return args;
}

/**
 * Split a string on top-level commas (ignoring commas inside brackets/parens/strings).
 */
function splitTopLevel(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }

    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }

    if (ch === ',' && depth === 0) {
      result.push(text.slice(start, i));
      start = i + 1;
    }
  }

  result.push(text.slice(start));
  return result;
}

/**
 * Given a source string and a position just after `(`, scan forward to find
 * the matching `)`, respecting nesting, strings, and comments.
 * Returns the text inside the parens (or null if not found within a reasonable limit).
 */
function extractArgText(source: string, openParenPos: number): string | null {
  let depth = 1;
  let inStr: string | null = null;
  const LIMIT = 2000; // bail out for very long argument lists

  for (let i = openParenPos; i < Math.min(source.length, openParenPos + LIMIT); i++) {
    const ch = source[i];

    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }

    if (ch === '#') {
      // Skip to end of line
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenPos, i);
    }
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyse a single Python source file and return a FileAnalysis.
 *
 * Targets packages listed in `targetPackages`; only function calls that
 * originate from those packages are recorded as `functionCalls`.
 */
export async function analyzePythonFile(
  filePath: string,
  projectRoot: string,
  targetPackages: Set<string>,
): Promise<FileAnalysis> {
  const relativePath = relative(projectRoot, filePath);
  const errors: string[] = [];

  let source = '';
  try {
    source = await readFile(filePath, 'utf-8');
  } catch (err) {
    errors.push(`Read error: ${String(err)}`);
    return { filePath, relativePath, imports: [], componentUsages: [], functionCalls: [], errors };
  }

  try {
    const result = extractFromPythonSource(source, filePath, targetPackages);
    return { filePath, relativePath, ...result, errors };
  } catch (err) {
    errors.push(`Parse error: ${String(err)}`);
    return { filePath, relativePath, imports: [], componentUsages: [], functionCalls: [], errors };
  }
}

// ─── Core extraction logic ────────────────────────────────────────────────────

export interface PythonExtractionResult {
  imports: ImportInfo[];
  componentUsages: never[];
  functionCalls: FunctionCallInfo[];
}

export function extractFromPythonSource(
  source: string,
  filePath: string,
  targetPackages: Set<string>,
): PythonExtractionResult {
  const imports: ImportInfo[] = [];
  const functionCalls: FunctionCallInfo[] = [];

  const importMap: ImportMap = new Map();
  const namespaceMap: NamespaceMap = new Map();

  // Normalise multi-line parenthesised imports before regex scanning.
  // We keep the original source for line/column calculations and snippets
  // so that reported positions stay accurate.
  const normalizedSource = normalizeMultiLineImports(source);

  const lineStarts = buildLineStarts(source);
  const sourceLines = source.split('\n');

  // ── Pass 1: collect imports ────────────────────────────────────────────────

  // a) `import X` / `import X.Y` / `import X as alias`
  {
    let m: RegExpExecArray | null;
    SIMPLE_IMPORT_RE.lastIndex = 0;
    while ((m = SIMPLE_IMPORT_RE.exec(normalizedSource)) !== null) {
      const modulePath = m[1];
      const alias = m[2] ?? null;
      if (!isExternalModule(modulePath)) continue;

      const pkg = topLevelPackage(modulePath);
      const localName = alias ?? modulePath; // `import pandas as pd` → local = "pd"

      // For dotted imports without alias, the local name is the full dotted path
      // (e.g. `import os.path` gives us `os.path` as local, but usage is `os.path.join()`)
      // We track the top-level package as the source.

      namespaceMap.set(localName, pkg);

      // Record in importMap as well so we can emit ImportInfo
      importMap.set(localName, { source: pkg, imported: modulePath, type: 'namespace' });

      // Build ImportInfo
      const existing = imports.find((i) => i.source === pkg);
      const specifier: ImportSpecifierInfo = {
        local: localName,
        imported: modulePath,
        type: 'namespace',
      };
      if (existing) {
        existing.specifiers.push(specifier);
      } else {
        imports.push({ source: pkg, specifiers: [specifier], typeOnly: false });
      }
    }
  }

  // b) `from X import Y, Z` / `from X.Y import Z`
  {
    let m: RegExpExecArray | null;
    FROM_IMPORT_RE.lastIndex = 0;
    while ((m = FROM_IMPORT_RE.exec(normalizedSource)) !== null) {
      const modulePath = m[1];
      const nameList = m[2].trim().replace(/^\(|\)$/g, ''); // strip optional parens
      if (!isExternalModule(modulePath)) continue;

      const pkg = topLevelPackage(modulePath);

      // Parse the name list
      let nm: RegExpExecArray | null;
      NAME_ALIAS_RE.lastIndex = 0;
      const specifiers: ImportSpecifierInfo[] = [];

      while ((nm = NAME_ALIAS_RE.exec(nameList)) !== null) {
        const imported = nm[1];
        const localAlias = nm[2] ?? imported;

        if (imported === '*') {
          // Wildcard: `from X import *` — we can't track names; skip
          continue;
        }

        const specifier: ImportSpecifierInfo = {
          local: localAlias,
          imported,
          type: 'named',
        };
        specifiers.push(specifier);
        importMap.set(localAlias, { source: pkg, imported, type: 'named' });
        // Also register in namespaceMap so `models.Field()` style calls are captured
        // when a named import (e.g. `from django.db import models`) is used as a module.
        namespaceMap.set(localAlias, pkg);
      }

      if (specifiers.length === 0) continue;

      const existing = imports.find((i) => i.source === pkg);
      if (existing) {
        for (const s of specifiers) existing.specifiers.push(s);
      } else {
        imports.push({ source: pkg, specifiers, typeOnly: false });
      }
    }
  }

  // ── Pass 2: find function/class calls ─────────────────────────────────────

  // We scan for two patterns:
  //   (A) SimpleCall:  `FuncName(`    where FuncName is in importMap → named import
  //   (B) MemberCall:  `alias.Method(`  where alias is in namespaceMap

  // To avoid double-counting, we do a single pass over the source looking
  // for both patterns, then resolve each match.

  // Build a combined regex that matches both patterns in one pass.
  // Group 1: simple identifier before (  (may be a member call prefix)
  // Group 2: (optional) .MethodName before (
  const combinedRe = /\b([\w]+)(?:\.([\w]+))?\s*\(/g;

  let cm: RegExpExecArray | null;
  combinedRe.lastIndex = 0;

  while ((cm = combinedRe.exec(source)) !== null) {
    const prefix = cm[1];
    const method = cm[2] ?? null;
    const matchStart = cm.index;

    // Skip if inside a string or comment (simple heuristic: check if the
    // character before the match is inside a string — we do a lightweight
    // check by scanning the line from its start)
    const { line, col } = offsetToLineCol(matchStart, lineStarts);
    const lineText = sourceLines[line - 1] ?? '';

    // Skip matches that appear after a '#' on the same line
    const commentIdx = lineText.indexOf('#');
    if (commentIdx !== -1 && col - 1 >= commentIdx) continue;

    // Skip decorator lines (lines starting with @)
    const trimmed = lineText.trimStart();
    if (trimmed.startsWith('@')) continue;

    let packageSource: string | null = null;
    let functionName: string;

    if (method !== null) {
      // Pattern B: `alias.Method(`
      // The regex matched "alias.Method("
      const aliasSource = namespaceMap.get(prefix);
      if (aliasSource && isTarget(aliasSource, targetPackages)) {
        packageSource = aliasSource;
        functionName = `${prefix}.${method}`;
      } else {
        continue;
      }
    } else {
      // Pattern A: `FuncName(`
      const entry = importMap.get(prefix);
      if (entry && isTarget(entry.source, targetPackages)) {
        packageSource = entry.source;
        functionName = prefix;
      } else {
        continue;
      }
    }

    // Extract argument text
    const openParenOffset = cm.index + cm[0].length - 1; // offset of '('
    const argsText = extractArgText(source, openParenOffset + 1);
    const args = argsText !== null
      ? parseArgs(argsText, line, sourceLines)
      : [];

    const callInfo: FunctionCallInfo = {
      file: filePath,
      line,
      column: col,
      functionName,
      importedFrom: packageSource,
      args,
      packageVersionResolved: null,
      packageVersionMajor: null,
      packageVersionMinor: null,
      packageVersionPatch: null,
      packageVersionPrerelease: null,
      packageVersionIsPrerelease: null,
    };

    functionCalls.push(callInfo);
  }

  return { imports, componentUsages: [], functionCalls };
}
