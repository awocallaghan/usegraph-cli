/**
 * Analyzes a single source file using SWC (JS/TS) or the tree-sitter Python
 * parser and returns a FileAnalysis.
 *
 * The Python analyzer is loaded lazily (dynamic import) so that tree-sitter
 * native modules are only resolved when a .py/.pyw file is encountered,
 * avoiding startup failures on platforms where the native bindings are absent.
 */
import { parse } from '@swc/core';
import { readFile } from 'fs/promises';
import { relative } from 'path';
import { extractFromAst } from './extractor.js';
import type { AstNode } from './walker.js';
import type { FileAnalysis } from '../types.js';

// Extensions that may contain JSX
const JSX_EXTENSIONS = new Set(['.tsx', '.jsx', '.js', '.mjs']);
// TypeScript extensions
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
// Python extensions
const PYTHON_EXTENSIONS = new Set(['.py', '.pyw']);

export async function analyzeFile(
  filePath: string,
  projectRoot: string,
  targetPackages: Set<string>,
  knownPackages?: Set<string>,
): Promise<FileAnalysis> {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (PYTHON_EXTENSIONS.has(ext)) {
    const { analyzePythonFile } = await import('./python-file-analyzer.js');
    return analyzePythonFile(filePath, projectRoot, targetPackages);
  }
  const relativePath = relative(projectRoot, filePath);
  const errors: string[] = [];

  const isTypeScript = TS_EXTENSIONS.has(ext);
  const hasJsx = JSX_EXTENSIONS.has(ext);

  let source = '';
  try {
    source = await readFile(filePath, 'utf-8');
  } catch (err) {
    errors.push(`Read error: ${String(err)}`);
    return { filePath, relativePath, imports: [], componentUsages: [], functionCalls: [], errors };
  }

  try {
    const parseOptions = isTypeScript
      ? ({
          syntax: 'typescript' as const,
          tsx: hasJsx,
          decorators: true,
          dynamicImport: true,
        } as const)
      : ({
          syntax: 'ecmascript' as const,
          jsx: hasJsx,
          importAssertions: true,
          exportDefaultFrom: true,
          dynamicImport: true,
        } as const);

    const ast = await parse(source, parseOptions);
    const { imports, componentUsages, functionCalls } = extractFromAst(
      ast as unknown as AstNode,
      filePath,
      source,
      targetPackages,
      knownPackages,
    );

    return { filePath, relativePath, imports, componentUsages, functionCalls, errors };
  } catch (err) {
    // SWC parse errors are common (unsupported syntax, etc.) – record and continue
    errors.push(`Parse error: ${String(err)}`);
    return { filePath, relativePath, imports: [], componentUsages: [], functionCalls: [], errors };
  }
}
