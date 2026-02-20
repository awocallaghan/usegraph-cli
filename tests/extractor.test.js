/**
 * Integration tests for src/analyzer/extractor.ts.
 * Uses @swc/core to parse real TypeScript/TSX source strings, then asserts on
 * the structured data returned by extractFromAst.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('@swc/core');
const { extractFromAst } = require('../dist/analyzer/extractor');

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Parse a TypeScript/TSX source string with SWC and run extractFromAst.
 * @param {string} source
 * @param {string[]} targetPackages  - empty means "all packages"
 * @param {boolean} [tsx]
 * @returns {Promise<{ imports, componentUsages, functionCalls }>}
 */
async function extract(source, targetPackages = [], tsx = false) {
  const ast = await parse(source, {
    syntax: 'typescript',
    tsx,
    decorators: true,
    dynamicImport: true,
  });
  return extractFromAst(ast, '/test/file.tsx', source, new Set(targetPackages));
}

// ─── Import extraction ────────────────────────────────────────────────────────

test('extracts a named import', async () => {
  const { imports } = await extract("import { Button } from '@myds/button';");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, '@myds/button');
  assert.equal(imports[0].typeOnly, false);
  assert.equal(imports[0].specifiers.length, 1);
  assert.equal(imports[0].specifiers[0].local, 'Button');
  assert.equal(imports[0].specifiers[0].imported, 'Button');
  assert.equal(imports[0].specifiers[0].type, 'named');
});

test('extracts a renamed named import', async () => {
  const { imports } = await extract("import { Button as Btn } from '@myds/button';");
  assert.equal(imports[0].specifiers[0].local, 'Btn');
  assert.equal(imports[0].specifiers[0].imported, 'Button');
  assert.equal(imports[0].specifiers[0].type, 'named');
});

test('extracts a default import', async () => {
  const { imports } = await extract("import Button from '@myds/button';");
  assert.equal(imports[0].specifiers[0].local, 'Button');
  assert.equal(imports[0].specifiers[0].imported, 'default');
  assert.equal(imports[0].specifiers[0].type, 'default');
});

test('extracts a namespace import', async () => {
  const { imports } = await extract("import * as DS from '@myds/core';");
  assert.equal(imports[0].specifiers[0].local, 'DS');
  assert.equal(imports[0].specifiers[0].imported, '*');
  assert.equal(imports[0].specifiers[0].type, 'namespace');
});

test('marks type-only imports as typeOnly=true', async () => {
  const { imports } = await extract("import type { ButtonProps } from '@myds/button';");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].typeOnly, true);
});

test('extracts multiple named specifiers from one import', async () => {
  const { imports } = await extract("import { Button, Icon, Text } from '@myds/core';");
  assert.equal(imports[0].specifiers.length, 3);
  const names = imports[0].specifiers.map(s => s.local);
  assert.deepEqual(names, ['Button', 'Icon', 'Text']);
});

test('extracts multiple import declarations', async () => {
  const src = `
    import { Button } from '@myds/button';
    import { theme } from '@myds/theme';
  `;
  const { imports } = await extract(src);
  assert.equal(imports.length, 2);
  assert.equal(imports[0].source, '@myds/button');
  assert.equal(imports[1].source, '@myds/theme');
});

// ─── JSX component extraction ─────────────────────────────────────────────────

test('extracts JSX component with string prop', async () => {
  const src = `
    import { Button } from '@myds/button';
    const el = <Button variant="primary" />;
  `;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  assert.equal(componentUsages.length, 1);
  const usage = componentUsages[0];
  assert.equal(usage.componentName, 'Button');
  assert.equal(usage.importedFrom, '@myds/button');
  assert.equal(usage.selfClosing, true);
  const variantProp = usage.props.find(p => p.name === 'variant');
  assert.ok(variantProp, 'variant prop should exist');
  assert.equal(variantProp.value, 'primary');
  assert.equal(variantProp.isDynamic, false);
});

test('extracts JSX bare boolean prop (disabled)', async () => {
  const src = `
    import { Button } from '@myds/button';
    const el = <Button disabled />;
  `;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  const disabledProp = componentUsages[0].props.find(p => p.name === 'disabled');
  assert.ok(disabledProp, 'disabled prop should exist');
  assert.equal(disabledProp.value, true);
  assert.equal(disabledProp.isDynamic, false);
});

test('extracts JSX dynamic prop as isDynamic=true', async () => {
  const src = `
    import { Button } from '@myds/button';
    const el = <Button onClick={handler} />;
  `;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  const onClickProp = componentUsages[0].props.find(p => p.name === 'onClick');
  assert.ok(onClickProp, 'onClick prop should exist');
  assert.equal(onClickProp.isDynamic, true);
});

test('extracts JSX numeric literal prop', async () => {
  const src = `
    import { Grid } from '@myds/layout';
    const el = <Grid columns={3} />;
  `;
  const { componentUsages } = await extract(src, ['@myds/layout'], true);
  const colsProp = componentUsages[0].props.find(p => p.name === 'columns');
  assert.ok(colsProp, 'columns prop should exist');
  assert.equal(colsProp.value, 3);
  assert.equal(colsProp.isDynamic, false);
});

test('extracts namespace JSX member: <DS.Button />', async () => {
  const src = `
    import * as DS from '@myds/core';
    const el = <DS.Button variant="large" />;
  `;
  const { componentUsages } = await extract(src, ['@myds/core'], true);
  assert.equal(componentUsages.length, 1);
  assert.equal(componentUsages[0].componentName, 'DS.Button');
  assert.equal(componentUsages[0].importedFrom, '@myds/core');
});

test('does not extract JSX from non-target packages', async () => {
  const src = `
    import { Button } from 'other-lib';
    const el = <Button variant="primary" />;
  `;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  assert.equal(componentUsages.length, 0);
});

test('records line number for JSX usage', async () => {
  const src = `import { Button } from '@myds/button';
const el = <Button />;`;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  // Button JSX is on line 2
  assert.equal(componentUsages[0].line, 2);
});

// ─── Function call extraction ─────────────────────────────────────────────────

test('extracts a function call with a string argument', async () => {
  const src = `
    import { createTheme } from '@myds/core';
    createTheme('dark');
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls.length, 1);
  const call = functionCalls[0];
  assert.equal(call.functionName, 'createTheme');
  assert.equal(call.importedFrom, '@myds/core');
  assert.equal(call.args.length, 1);
  assert.equal(call.args[0].type, 'string');
  assert.equal(call.args[0].value, 'dark');
  assert.equal(call.args[0].isSpread, false);
});

test('extracts a function call with a numeric argument', async () => {
  const src = `
    import { setFontSize } from '@myds/core';
    setFontSize(16);
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls[0].args[0].type, 'number');
  assert.equal(functionCalls[0].args[0].value, 16);
});

test('extracts a function call with a boolean argument', async () => {
  const src = `
    import { configure } from '@myds/core';
    configure(true);
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls[0].args[0].type, 'boolean');
  assert.equal(functionCalls[0].args[0].value, true);
});

test('extracts a function call with an object argument', async () => {
  const src = `
    import { createTheme } from '@myds/core';
    createTheme({ mode: 'dark', primary: '#000' });
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls[0].args[0].type, 'object');
});

test('extracts a function call with an array argument', async () => {
  const src = `
    import { setColors } from '@myds/core';
    setColors(['red', 'blue']);
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls[0].args[0].type, 'array');
});

test('extracts namespace member function call: DS.createTheme()', async () => {
  const src = `
    import * as DS from '@myds/core';
    DS.createTheme({ mode: 'dark' });
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'DS.createTheme');
  assert.equal(functionCalls[0].importedFrom, '@myds/core');
  assert.equal(functionCalls[0].args[0].type, 'object');
});

test('does not extract calls from non-target packages', async () => {
  const src = `
    import { foo } from 'other-lib';
    foo('hello');
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls.length, 0);
});

// ─── Package filtering ────────────────────────────────────────────────────────

test('empty targetPackages tracks all imported symbols', async () => {
  const src = `
    import { foo } from 'lib-a';
    import { bar } from 'lib-b';
    foo();
    bar();
  `;
  const { functionCalls } = await extract(src, []);
  assert.equal(functionCalls.length, 2);
});

test('targetPackages filters to only matching packages', async () => {
  const src = `
    import { foo } from 'lib-a';
    import { bar } from 'lib-b';
    foo();
    bar();
  `;
  const { functionCalls } = await extract(src, ['lib-a']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'foo');
});

test('subpath imports match parent package in targetPackages', async () => {
  const src = `
    import { Icon } from '@myds/icons/outlined';
    Icon();
  `;
  const { functionCalls } = await extract(src, ['@myds/icons']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'Icon');
  assert.equal(functionCalls[0].importedFrom, '@myds/icons/outlined');
});

// ─── Type-only imports not tracked for usage ──────────────────────────────────

test('type-only imports are not tracked in importMap (no usage)', async () => {
  // Even if ButtonProps is used as a JSX component name somehow, type imports
  // must not appear in importMap, so no componentUsages should be emitted.
  const src = `
    import type { Button } from '@myds/button';
    const el = <Button />;
  `;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  // Type-only import should not register Button in the import map
  assert.equal(componentUsages.length, 0);
});

// ─── Multiple usages in one file ─────────────────────────────────────────────

test('collects multiple JSX usages in one file', async () => {
  const src = `
    import { Button, Icon } from '@myds/button';
    const a = <Button variant="primary" />;
    const b = <Icon name="check" />;
    const c = <Button size="sm" />;
  `;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  assert.equal(componentUsages.length, 3);
  assert.equal(componentUsages.filter(u => u.componentName === 'Button').length, 2);
  assert.equal(componentUsages.filter(u => u.componentName === 'Icon').length, 1);
});

test('collects multiple function calls in one file', async () => {
  const src = `
    import { createTheme, createTokens } from '@myds/core';
    createTheme('light');
    createTheme('dark');
    createTokens({ spacing: 4 });
  `;
  const { functionCalls } = await extract(src, ['@myds/core']);
  assert.equal(functionCalls.length, 3);
  assert.equal(functionCalls.filter(c => c.functionName === 'createTheme').length, 2);
  assert.equal(functionCalls.filter(c => c.functionName === 'createTokens').length, 1);
});
