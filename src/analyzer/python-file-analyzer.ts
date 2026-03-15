/**
 * Python source file analyzer — tree-sitter based.
 *
 * Extracts import declarations and usages of tracked packages from `.py`
 * files using the tree-sitter parser for correctness and robustness.
 *
 * Handles:
 *  - Named imports:     from fastapi import FastAPI, HTTPException
 *  - Aliased imports:   from fastapi import FastAPI as App
 *  - Namespace imports: import pandas as pd
 *  - Module imports:    import os.path  (top-level package = os)
 *  - Multi-line imports: parenthesised and backslash-continued
 *  - Function calls:    Flask(__name__)
 *  - Namespace calls:   pd.DataFrame(data)
 *  - Named-import-as-namespace: from django.db import models → models.CharField()
 */
import { readFile } from 'fs/promises';
import { relative } from 'path';
import { createRequire } from 'module';
import type {
  FileAnalysis,
  ImportInfo,
  ImportSpecifierInfo,
  FunctionCallInfo,
  ArgInfo,
} from '../types.js';

// tree-sitter is a native CJS module — load via createRequire from ESM
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Parser = _require('tree-sitter');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Python = _require('tree-sitter-python');

// Singleton parser instance (Parser.parse() is synchronous and not thread-safe,
// but Node.js is single-threaded so a module-level instance is safe).
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
const _parser = new Parser();
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
_parser.setLanguage(Python);

// ─── Minimal tree-sitter type helpers ────────────────────────────────────────

interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TSNode[];
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
  childrenForFieldName(name: string): TSNode[];
}

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

// ─── Stdlib filter ────────────────────────────────────────────────────────────

const STDLIB_MODULES = new Set([
  'abc', 'ast', 'asyncio', 'base64', 'builtins', 'collections', 'contextlib',
  'copy', 'csv', 'dataclasses', 'datetime', 'decimal', 'email', 'enum',
  'errno', 'functools', 'gc', 'glob', 'graphlib', 'hashlib', 'http', 'importlib',
  'inspect', 'io', 'itertools', 'json', 'logging', 'math', 'multiprocessing',
  'operator', 'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue',
  're', 'shutil', 'signal', 'socket', 'sqlite3', 'ssl', 'stat', 'string',
  'struct', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading', 'time',
  'tomllib', 'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib',
  'uuid', 'warnings', 'weakref', 'xml', 'xmlrpc', 'zipfile', 'zoneinfo',
  '__future__',
]);

function topLevelPackage(modulePath: string): string {
  return modulePath.split('.')[0];
}

function isExternalModule(modulePath: string): boolean {
  if (modulePath.startsWith('.')) return false;
  return !STDLIB_MODULES.has(topLevelPackage(modulePath));
}

// ─── String value extraction ──────────────────────────────────────────────────

/** Extract the value of a tree-sitter `string` node (strips quotes/prefix). */
function extractStringValue(node: TSNode): string {
  // Find the string_content child (may not exist for empty strings)
  const contentNode = node.namedChildren.find((c) => c.type === 'string_content');
  return contentNode ? contentNode.text : '';
}

// ─── Source snippet helper ────────────────────────────────────────────────────

function extractSnippet(sourceLines: string[], oneBased: number): string {
  const start = Math.max(0, oneBased - 2);
  const end = Math.min(sourceLines.length, oneBased + 3);
  return sourceLines.slice(start, end).join('\n');
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgNode(argNode: TSNode, index: number, sourceLines: string[]): ArgInfo {
  const line = argNode.startPosition.row + 1; // 1-based

  switch (argNode.type) {
    case 'string':
      return { index, type: 'string', value: extractStringValue(argNode), isSpread: false, sourceSnippet: null };

    case 'integer': {
      const v = Number(argNode.text);
      return { index, type: 'number', value: isNaN(v) ? 0 : v, isSpread: false, sourceSnippet: null };
    }

    case 'float': {
      const v = Number(argNode.text);
      return { index, type: 'number', value: isNaN(v) ? 0 : v, isSpread: false, sourceSnippet: null };
    }

    case 'true':
      return { index, type: 'boolean', value: true, isSpread: false, sourceSnippet: null };

    case 'false':
      return { index, type: 'boolean', value: false, isSpread: false, sourceSnippet: null };

    case 'none':
      return { index, type: 'null', isSpread: false, sourceSnippet: null };

    case 'list_splat':
    case 'dictionary_splat':
      return { index, type: 'spread', isSpread: true, sourceSnippet: null };

    default: {
      const snippet = extractSnippet(sourceLines, line);
      return { index, type: 'expression', isSpread: false, sourceSnippet: snippet };
    }
  }
}

/**
 * Parse an `argument_list` tree-sitter node into ArgInfo[].
 * Keyword arguments are unwrapped to their value; positional args are used directly.
 */
function parseArgList(argListNode: TSNode, sourceLines: string[]): ArgInfo[] {
  const args: ArgInfo[] = [];
  let index = 0;

  for (const child of argListNode.namedChildren) {
    if (child.type === 'keyword_argument') {
      const valueNode = child.childForFieldName('value');
      if (valueNode) {
        args.push(parseArgNode(valueNode, index, sourceLines));
        index++;
      }
    } else if (child.type === 'comment') {
      // skip
    } else {
      args.push(parseArgNode(child, index, sourceLines));
      index++;
    }
  }

  return args;
}

// ─── Import collection pass ────────────────────────────────────────────────────

function collectImports(
  rootNode: TSNode,
  imports: ImportInfo[],
  importMap: ImportMap,
  namespaceMap: NamespaceMap,
): void {
  for (const stmt of rootNode.children) {
    if (stmt.type === 'import_from_statement') {
      collectFromImport(stmt, imports, importMap, namespaceMap);
    } else if (stmt.type === 'import_statement') {
      collectSimpleImport(stmt, imports, importMap, namespaceMap);
    }
    // We only look at top-level statements for imports (standard Python practice)
  }
}

function collectFromImport(
  node: TSNode,
  imports: ImportInfo[],
  importMap: ImportMap,
  namespaceMap: NamespaceMap,
): void {
  const moduleNameNode = node.childForFieldName('module_name');
  if (!moduleNameNode) return;
  const modulePath = moduleNameNode.text;
  if (!isExternalModule(modulePath)) return;

  const pkg = topLevelPackage(modulePath);
  const nameNodes = node.childrenForFieldName('name');
  const specifiers: ImportSpecifierInfo[] = [];

  for (const nameNode of nameNodes) {
    if (nameNode.type === 'wildcard_import') {
      // `from X import *` — skip
      continue;
    }

    let imported: string;
    let local: string;

    if (nameNode.type === 'aliased_import') {
      const nameField = nameNode.childForFieldName('name');
      const aliasField = nameNode.childForFieldName('alias');
      imported = nameField ? nameField.text : nameNode.text;
      local = aliasField ? aliasField.text : imported;
    } else {
      // dotted_name
      imported = nameNode.text;
      local = imported;
    }

    const specifier: ImportSpecifierInfo = { local, imported, type: 'named' };
    specifiers.push(specifier);
    importMap.set(local, { source: pkg, imported, type: 'named' });
    // Also register as namespace so `models.Field()` style calls work
    namespaceMap.set(local, pkg);
  }

  if (specifiers.length === 0) return;

  const existing = imports.find((i) => i.source === pkg);
  if (existing) {
    for (const s of specifiers) existing.specifiers.push(s);
  } else {
    imports.push({ source: pkg, specifiers, typeOnly: false });
  }
}

function collectSimpleImport(
  node: TSNode,
  imports: ImportInfo[],
  importMap: ImportMap,
  namespaceMap: NamespaceMap,
): void {
  const nameNodes = node.childrenForFieldName('name');

  for (const nameNode of nameNodes) {
    let modulePath: string;
    let local: string;

    if (nameNode.type === 'aliased_import') {
      const nameField = nameNode.childForFieldName('name');
      const aliasField = nameNode.childForFieldName('alias');
      modulePath = nameField ? nameField.text : nameNode.text;
      local = aliasField ? aliasField.text : modulePath;
    } else {
      modulePath = nameNode.text;
      // `import X.Y` binds the top-level name X in the local namespace
      local = modulePath.split('.')[0];
    }

    if (!isExternalModule(modulePath)) continue;

    const pkg = topLevelPackage(modulePath);
    namespaceMap.set(local, pkg);
    importMap.set(local, { source: pkg, imported: modulePath, type: 'namespace' });

    const specifier: ImportSpecifierInfo = { local, imported: modulePath, type: 'namespace' };
    const existing = imports.find((i) => i.source === pkg);
    if (existing) {
      existing.specifiers.push(specifier);
    } else {
      imports.push({ source: pkg, specifiers: [specifier], typeOnly: false });
    }
  }
}

// ─── Call collection pass ─────────────────────────────────────────────────────

function collectCalls(
  node: TSNode,
  functionCalls: FunctionCallInfo[],
  importMap: ImportMap,
  namespaceMap: NamespaceMap,
  targetPackages: Set<string>,
  filePath: string,
  sourceLines: string[],
): void {
  if (node.type === 'call') {
    processCandidateCall(node, functionCalls, importMap, namespaceMap, targetPackages, filePath, sourceLines);
  }

  for (const child of node.children) {
    collectCalls(child, functionCalls, importMap, namespaceMap, targetPackages, filePath, sourceLines);
  }
}

function processCandidateCall(
  callNode: TSNode,
  functionCalls: FunctionCallInfo[],
  importMap: ImportMap,
  namespaceMap: NamespaceMap,
  targetPackages: Set<string>,
  filePath: string,
  sourceLines: string[],
): void {
  const funcNode = callNode.childForFieldName('function');
  if (!funcNode) return;

  let packageSource: string | null = null;
  let functionName: string;

  if (funcNode.type === 'identifier') {
    const localName = funcNode.text;
    const entry = importMap.get(localName);
    if (!entry || !targetPackages.has(entry.source)) return;
    packageSource = entry.source;
    functionName = localName;
  } else if (funcNode.type === 'attribute') {
    const objectNode = funcNode.childForFieldName('object');
    const attrNode = funcNode.childForFieldName('attribute');
    if (!objectNode || !attrNode) return;

    // Only handle single-level namespace: `alias.method(`
    // Deeper chains (a.b.c) are not tracked
    if (objectNode.type !== 'identifier') return;

    const prefix = objectNode.text;
    const method = attrNode.text;
    const aliasSource = namespaceMap.get(prefix);
    if (!aliasSource || !targetPackages.has(aliasSource)) return;
    packageSource = aliasSource;
    functionName = `${prefix}.${method}`;
  } else {
    return;
  }

  const line = callNode.startPosition.row + 1; // 1-based
  const column = callNode.startPosition.column + 1;

  const argListNode = callNode.childForFieldName('arguments');
  const args = argListNode ? parseArgList(argListNode, sourceLines) : [];

  const callInfo: FunctionCallInfo = {
    file: filePath,
    line,
    column,
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

// ─── Public API ───────────────────────────────────────────────────────────────

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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const tree = _parser.parse(source) as { rootNode: TSNode };
  const rootNode = tree.rootNode;

  const imports: ImportInfo[] = [];
  const functionCalls: FunctionCallInfo[] = [];
  const importMap: ImportMap = new Map();
  const namespaceMap: NamespaceMap = new Map();
  const sourceLines = source.split('\n');

  // Pass 1: collect imports
  collectImports(rootNode, imports, importMap, namespaceMap);

  // Pass 2: collect function/class calls referencing tracked packages
  if (targetPackages.size > 0) {
    collectCalls(rootNode, functionCalls, importMap, namespaceMap, targetPackages, filePath, sourceLines);
  }

  return { imports, componentUsages: [], functionCalls };
}

/**
 * Analyse a single Python source file and return a FileAnalysis.
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
