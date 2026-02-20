/**
 * Extracts import declarations and usage of tracked packages from a parsed
 * SWC AST.  Handles:
 *  - Named imports:     import { Button } from 'pkg'
 *  - Default imports:   import Button from 'pkg'
 *  - Namespace imports: import * as DS from 'pkg'
 *  - JSX components:    <Button variant="primary" />
 *  - Member JSX:        <DS.Button variant="primary" />
 *  - Function calls:    createTheme({ ... })
 *  - Member calls:      DS.createTheme({ ... })
 */
import { walkAst, type AstNode } from './walker';
import type {
  ImportInfo,
  ImportSpecifierInfo,
  ComponentUsage,
  FunctionCallInfo,
  PropInfo,
  ArgInfo,
} from '../types';

// Map: localName -> { source, imported, type }
type ImportMap = Map<string, { source: string; imported: string; type: ImportSpecifierInfo['type'] }>;

// For namespace imports: namespaceName -> source
type NamespaceMap = Map<string, string>;

export interface ExtractionResult {
  imports: ImportInfo[];
  componentUsages: ComponentUsage[];
  functionCalls: FunctionCallInfo[];
}

export function extractFromAst(
  ast: AstNode,
  filePath: string,
  source: string,
  targetPackages: Set<string>,
): ExtractionResult {
  const imports: ImportInfo[] = [];
  const componentUsages: ComponentUsage[] = [];
  const functionCalls: FunctionCallInfo[] = [];

  const importMap: ImportMap = new Map();
  const namespaceMap: NamespaceMap = new Map();

  // Line/col helper: SWC span offsets are byte positions in the source
  const lineStarts = buildLineStartIndex(source);
  const getPos = (offset: number) => spanToLineCol(offset, lineStarts);

  // ----------------------------------------------------------------
  // Pass 1: collect all imports
  // ----------------------------------------------------------------
  walkAst(ast, (node) => {
    if (node.type !== 'ImportDeclaration') return;

    const importSource = getStringValue(node['source']);
    if (!importSource) return;

    const typeOnly = !!(node['typeOnly'] as boolean);
    const specifierNodes = (node['specifiers'] as AstNode[]) ?? [];
    const specifiers: ImportSpecifierInfo[] = [];

    for (const spec of specifierNodes) {
      switch (spec.type) {
        case 'ImportDefaultSpecifier': {
          const local = getIdentifierValue(spec['local']);
          if (local) {
            specifiers.push({ local, imported: 'default', type: 'default' });
            if (!typeOnly && isTargetPackage(importSource, targetPackages)) {
              importMap.set(local, { source: importSource, imported: 'default', type: 'default' });
            }
          }
          break;
        }
        case 'ImportNamespaceSpecifier': {
          const local = getIdentifierValue(spec['local']);
          if (local) {
            specifiers.push({ local, imported: '*', type: 'namespace' });
            if (!typeOnly && isTargetPackage(importSource, targetPackages)) {
              namespaceMap.set(local, importSource);
            }
          }
          break;
        }
        case 'ImportSpecifier': {
          const local = getIdentifierValue(spec['local']);
          const importedNode = spec['imported'] as AstNode | null;
          const imported = importedNode
            ? (getStringValue(importedNode) ?? getIdentifierValue(importedNode) ?? local ?? '')
            : local ?? '';
          const isTypeOnly = !!(spec['isTypeOnly'] as boolean);
          if (local) {
            specifiers.push({ local, imported, type: 'named' });
            if (!typeOnly && !isTypeOnly && isTargetPackage(importSource, targetPackages)) {
              importMap.set(local, { source: importSource, imported, type: 'named' });
            }
          }
          break;
        }
      }
    }

    imports.push({ source: importSource, specifiers, typeOnly });

    // Do not descend into import declarations further
    return false;
  });

  // ----------------------------------------------------------------
  // Pass 2: collect JSX component usages and function calls
  // ----------------------------------------------------------------
  walkAst(ast, (node) => {
    // --- JSX opening elements ----------------------------------------
    if (node.type === 'JSXOpeningElement') {
      const nameNode = node['name'] as AstNode | undefined;
      if (!nameNode) return;

      const { componentName, packageSource } = resolveJsxName(nameNode, importMap, namespaceMap);
      if (!componentName || !packageSource) return;

      const span = node['span'] as { start: number } | undefined;
      const { line, column } = span ? getPos(span.start) : { line: 0, column: 0 };

      const attributes = (node['attributes'] as AstNode[]) ?? [];
      const props: PropInfo[] = extractJsxProps(attributes);

      componentUsages.push({
        file: filePath,
        line,
        column,
        componentName,
        importedFrom: packageSource,
        props,
        selfClosing: !!(node['selfClosing'] as boolean),
      });

      return false; // don't descend into JSX attributes to avoid double-counting
    }

    // --- Call expressions --------------------------------------------
    if (node.type === 'CallExpression') {
      const callee = node['callee'] as AstNode | undefined;
      if (!callee) return;

      const { funcName, packageSource } = resolveCallee(callee, importMap, namespaceMap);
      if (!funcName || !packageSource) return;

      const span = node['span'] as { start: number } | undefined;
      const { line, column } = span ? getPos(span.start) : { line: 0, column: 0 };

      const argNodes = (node['arguments'] as AstNode[]) ?? [];
      const args: ArgInfo[] = argNodes.map((a, i) => extractArg(a, i));

      functionCalls.push({
        file: filePath,
        line,
        column,
        functionName: funcName,
        importedFrom: packageSource,
        args,
      });
    }
  });

  return { imports, componentUsages, functionCalls };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function isTargetPackage(source: string, targets: Set<string>): boolean {
  if (targets.size === 0) return true; // no filter → track everything
  for (const target of targets) {
    if (source === target || source.startsWith(target + '/')) return true;
  }
  return false;
}

function getStringValue(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as Record<string, unknown>;
  if (n['type'] === 'StringLiteral') return n['value'] as string;
  if (typeof n['value'] === 'string') return n['value'];
  return undefined;
}

function getIdentifierValue(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as Record<string, unknown>;
  if (n['type'] === 'Identifier') return n['value'] as string;
  return undefined;
}

/** Resolve a JSXElementName to (componentName, packageSource) or nulls */
function resolveJsxName(
  nameNode: AstNode,
  importMap: ImportMap,
  namespaceMap: NamespaceMap,
): { componentName: string | null; packageSource: string | null } {
  // Simple identifier: <Button>
  if (nameNode.type === 'Identifier') {
    const name = nameNode['value'] as string;
    const entry = importMap.get(name);
    if (entry) return { componentName: name, packageSource: entry.source };
    return { componentName: null, packageSource: null };
  }

  // Member expression: <DS.Button>
  if (nameNode.type === 'JSXMemberExpression') {
    const obj = nameNode['object'] as AstNode;
    const prop = nameNode['property'] as AstNode;
    const objName = obj?.type === 'Identifier' ? (obj['value'] as string) : undefined;
    const propName = prop?.type === 'Identifier' ? (prop['value'] as string) : undefined;
    if (objName && propName) {
      const ns = namespaceMap.get(objName);
      if (ns) return { componentName: `${objName}.${propName}`, packageSource: ns };
    }
    return { componentName: null, packageSource: null };
  }

  return { componentName: null, packageSource: null };
}

/** Resolve a CallExpression callee to (funcName, packageSource) or nulls */
function resolveCallee(
  callee: AstNode,
  importMap: ImportMap,
  namespaceMap: NamespaceMap,
): { funcName: string | null; packageSource: string | null } {
  // Direct call: someFunc()
  if (callee.type === 'Identifier') {
    const name = callee['value'] as string;
    const entry = importMap.get(name);
    if (entry) return { funcName: name, packageSource: entry.source };
    return { funcName: null, packageSource: null };
  }

  // Member call: DS.someFunc() or obj.method()
  if (callee.type === 'MemberExpression') {
    const obj = callee['object'] as AstNode;
    const prop = callee['property'] as AstNode;
    const objName = obj?.type === 'Identifier' ? (obj['value'] as string) : undefined;
    const propName =
      prop?.type === 'Identifier'
        ? (prop['value'] as string)
        : prop?.type === 'StringLiteral'
          ? (prop['value'] as string)
          : undefined;

    if (objName && propName) {
      const ns = namespaceMap.get(objName);
      if (ns) return { funcName: `${objName}.${propName}`, packageSource: ns };
    }
    return { funcName: null, packageSource: null };
  }

  return { funcName: null, packageSource: null };
}

/** Extract JSX attribute list into PropInfo[] */
function extractJsxProps(attributes: AstNode[]): PropInfo[] {
  const props: PropInfo[] = [];
  for (const attr of attributes) {
    if (attr.type !== 'JSXAttribute') continue;

    const nameNode = attr['name'] as AstNode;
    const propName =
      nameNode?.type === 'Identifier'
        ? (nameNode['value'] as string)
        : nameNode?.type === 'JSXNamespacedName'
          ? `${getIdentifierValue(nameNode['namespace'])}:${getIdentifierValue(nameNode['name'])}`
          : undefined;

    if (!propName) continue;

    const valueNode = attr['value'] as AstNode | null;
    const { value, isDynamic } = extractJsxAttrValue(valueNode);
    props.push({ name: propName, value, isDynamic });
  }
  return props;
}

function extractJsxAttrValue(valueNode: AstNode | null): { value: PropInfo['value']; isDynamic: boolean } {
  if (valueNode === null) {
    // Bare prop: <Comp disabled /> → value = true
    return { value: true, isDynamic: false };
  }

  switch (valueNode.type) {
    case 'StringLiteral':
      return { value: valueNode['value'] as string, isDynamic: false };

    case 'JSXExpressionContainer': {
      const expr = valueNode['expression'] as AstNode;
      if (!expr) return { value: null, isDynamic: true };
      return extractExpressionValue(expr);
    }

    case 'JSXElement':
    case 'JSXFragment':
      return { value: '[jsx]', isDynamic: true };

    default:
      return { value: null, isDynamic: true };
  }
}

function extractExpressionValue(expr: AstNode): { value: PropInfo['value']; isDynamic: boolean } {
  switch (expr.type) {
    case 'StringLiteral':
      return { value: expr['value'] as string, isDynamic: false };
    case 'NumericLiteral':
      return { value: expr['value'] as number, isDynamic: false };
    case 'BooleanLiteral':
      return { value: expr['value'] as boolean, isDynamic: false };
    case 'NullLiteral':
      return { value: null, isDynamic: false };
    case 'Identifier':
      if (expr['value'] === 'undefined') return { value: null, isDynamic: false };
      return { value: `[${expr['value']}]`, isDynamic: true };
    default:
      return { value: `[${expr.type}]`, isDynamic: true };
  }
}

/** Extract a single function call argument */
function extractArg(argNode: AstNode, index: number): ArgInfo {
  const isSpread = !!(argNode['spread'] as unknown);
  const expr = argNode['expression'] as AstNode | undefined;

  if (!expr) return { index, type: 'unknown', isSpread };

  switch (expr.type) {
    case 'StringLiteral':
      return { index, type: 'string', value: expr['value'] as string, isSpread };
    case 'NumericLiteral':
      return { index, type: 'number', value: expr['value'] as number, isSpread };
    case 'BooleanLiteral':
      return { index, type: 'boolean', value: expr['value'] as boolean, isSpread };
    case 'NullLiteral':
      return { index, type: 'null', isSpread };
    case 'Identifier':
      if (expr['value'] === 'undefined') return { index, type: 'undefined', isSpread };
      return { index, type: 'identifier', value: expr['value'] as string, isSpread };
    case 'ObjectExpression':
      return { index, type: 'object', isSpread };
    case 'ArrayExpression':
      return { index, type: 'array', isSpread };
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return { index, type: 'function', isSpread };
    case 'TemplateLiteral':
      return { index, type: 'template', isSpread };
    default:
      return { index, type: expr.type, isSpread };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Line/column conversion
// ────────────────────────────────────────────────────────────────────────────

function buildLineStartIndex(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function spanToLineCol(offset: number, lineStarts: number[]): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}
