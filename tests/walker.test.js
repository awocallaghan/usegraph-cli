/**
 * Unit tests for src/analyzer/walker.ts (compiled to dist/analyzer/walker.js).
 * Tests the generic SWC AST walker: node visiting, tree pruning, array handling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkAst } from '../dist/analyzer/walker.js';

test('visits the root node itself', () => {
  const ast = { type: 'Module', body: [] };
  const visited = [];
  walkAst(ast, (node) => { visited.push(node.type); });
  assert.deepEqual(visited, ['Module']);
});

test('visits all descendant nodes depth-first', () => {
  const ast = {
    type: 'Module',
    body: [
      {
        type: 'ExpressionStatement',
        expression: { type: 'Identifier' },
      },
    ],
  };
  const visited = [];
  walkAst(ast, (node) => { visited.push(node.type); });
  assert.deepEqual(visited, ['Module', 'ExpressionStatement', 'Identifier']);
});

test('prunes subtree when visitor returns false', () => {
  const ast = {
    type: 'Module',
    child: {
      type: 'ImportDeclaration',
      source: { type: 'StringLiteral', value: 'react' },
    },
  };
  const visited = [];
  walkAst(ast, (node) => {
    visited.push(node.type);
    if (node.type === 'ImportDeclaration') return false;
  });
  assert.ok(visited.includes('Module'));
  assert.ok(visited.includes('ImportDeclaration'));
  // StringLiteral inside ImportDeclaration should be pruned
  assert.ok(!visited.includes('StringLiteral'));
});

test('visits items in arrays', () => {
  const ast = {
    type: 'Root',
    items: [
      { type: 'NodeA' },
      { type: 'NodeB' },
      { type: 'NodeC' },
    ],
  };
  const visited = [];
  walkAst(ast, (node) => { visited.push(node.type); });
  assert.deepEqual(visited, ['Root', 'NodeA', 'NodeB', 'NodeC']);
});

test('skips null and primitive values without error', () => {
  const ast = {
    type: 'Module',
    value: null,
    count: 42,
    name: 'test',
    flag: true,
  };
  const visited = [];
  assert.doesNotThrow(() => {
    walkAst(ast, (node) => { visited.push(node.type); });
  });
  assert.deepEqual(visited, ['Module']);
});

test('skips nodes without a type field', () => {
  const ast = {
    type: 'Module',
    meta: { version: '1.0' }, // no 'type' field, should be silently skipped
  };
  const visited = [];
  walkAst(ast, (node) => { visited.push(node.type); });
  assert.deepEqual(visited, ['Module']);
});

test('handles deeply nested trees', () => {
  const ast = {
    type: 'A',
    child: {
      type: 'B',
      child: {
        type: 'C',
        child: { type: 'D' },
      },
    },
  };
  const visited = [];
  walkAst(ast, (node) => { visited.push(node.type); });
  assert.deepEqual(visited, ['A', 'B', 'C', 'D']);
});

test('handles root as array', () => {
  // walkAst accepts unknown root; array root should iterate items
  const ast = [
    { type: 'NodeA' },
    { type: 'NodeB' },
  ];
  const visited = [];
  walkAst(ast, (node) => { visited.push(node.type); });
  assert.deepEqual(visited, ['NodeA', 'NodeB']);
});

test('does not visit span/value/raw/type fields as child nodes', () => {
  // These are scalar-skip keys - they should not be walked as children
  const ast = {
    type: 'Literal',
    span: { type: 'SHOULD_NOT_VISIT_SPAN' },
    value: { type: 'SHOULD_NOT_VISIT_VALUE' },
    raw: { type: 'SHOULD_NOT_VISIT_RAW' },
  };
  const visited = [];
  walkAst(ast, (node) => { visited.push(node.type); });
  assert.deepEqual(visited, ['Literal']);
});
