/**
 * Analyzes a single source file using SWC and returns a FileAnalysis.
 */
import { parse } from '@swc/core';
import { readFile } from 'fs/promises';
import { relative } from 'path';
import { extractFromAst, type AstNode } from './extractor';
import type { FileAnalysis } from '../types';

// Extensions that may contain JSX
const JSX_EXTENSIONS = new Set(['.tsx', '.jsx', '.js', '.mjs']);
// TypeScript extensions
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export async function analyzeFile(
  filePath: string,
  projectRoot: string,
  targetPackages: Set<string>,
): Promise<FileAnalysis> {
  const relativePath = relative(projectRoot, filePath);
  const errors: string[] = [];

  const ext = filePath.slice(filePath.lastIndexOf('.'));
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
    );

    return { filePath, relativePath, imports, componentUsages, functionCalls, errors };
  } catch (err) {
    // SWC parse errors are common (unsupported syntax, etc.) – record and continue
    errors.push(`Parse error: ${String(err)}`);
    return { filePath, relativePath, imports: [], componentUsages: [], functionCalls: [], errors };
  }
}
