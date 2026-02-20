/**
 * Generic SWC AST walker.
 * Recursively visits every node in the tree and invokes a callback.
 * The callback receives each node; return `false` to skip children.
 */
export type VisitorFn = (node: AstNode) => boolean | void;

export type AstNode = Record<string, unknown> & { type: string };

/**
 * Walk an SWC AST node, calling `visitor` for every object with a `type` field.
 * Children are walked depth-first; returning `false` from `visitor` prunes that
 * subtree.
 */
export function walkAst(root: unknown, visitor: VisitorFn): void {
  walk(root, visitor);
}

function walk(value: unknown, visitor: VisitorFn): void {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor);
    return;
  }

  const node = value as Record<string, unknown>;

  if (typeof node['type'] === 'string') {
    const shouldDescend = visitor(node as AstNode);
    if (shouldDescend === false) return;
  }

  for (const key of Object.keys(node)) {
    // Skip scalar-only fields to avoid unnecessary recursion
    if (key === 'type' || key === 'span' || key === 'value' || key === 'raw') continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      walk(child, visitor);
    }
  }
}
