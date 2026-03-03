/**
 * Integration tests for src/analyzer/extractor.ts.
 * Uses @swc/core to parse real TypeScript/TSX source strings, then asserts on
 * the structured data returned by extractFromAst.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@swc/core';
import { extractFromAst } from '../dist/analyzer/extractor.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Parse a TypeScript/TSX source string with SWC and run extractFromAst.
 * @param {string} source
 * @param {string[]} targetPackages  - empty means "all packages"
 * @param {boolean} [tsx]
 * @param {string[]} [knownPackages] - package names from package.json deps
 * @returns {Promise<{ imports, componentUsages, functionCalls }>}
 */
async function extract(source, targetPackages = [], tsx = false, knownPackages = undefined) {
  const ast = await parse(source, {
    syntax: 'typescript',
    tsx,
    decorators: true,
    dynamicImport: true,
  });
  return extractFromAst(ast, '/test/file.tsx', source, new Set(targetPackages), knownPackages ? new Set(knownPackages) : undefined);
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

// ─── sourceSnippet ────────────────────────────────────────────────────────────

test('dynamic JSX prop gets a non-null sourceSnippet containing the source line', async () => {
  const src = `import { Button } from '@myds/button';
const handler = () => {};
const el = <Button onClick={handler} />;
`;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  const onClickProp = componentUsages[0].props.find(p => p.name === 'onClick');
  assert.ok(onClickProp, 'onClick prop should exist');
  assert.equal(onClickProp.isDynamic, true);
  assert.ok(onClickProp.sourceSnippet !== null, 'sourceSnippet should be set for dynamic prop');
  assert.ok(
    onClickProp.sourceSnippet.includes('onClick'),
    'sourceSnippet should contain the prop name',
  );
});

test('static JSX prop has sourceSnippet: null', async () => {
  const src = `import { Button } from '@myds/button';
const el = <Button variant="primary" />;
`;
  const { componentUsages } = await extract(src, ['@myds/button'], true);
  const variantProp = componentUsages[0].props.find(p => p.name === 'variant');
  assert.ok(variantProp, 'variant prop should exist');
  assert.equal(variantProp.isDynamic, false);
  assert.equal(variantProp.sourceSnippet, null);
});

test('dynamic function arg gets a non-null sourceSnippet', async () => {
  const src = `import { createTheme } from '@myds/core';
const opts = { mode: 'dark' };
createTheme(opts);
`;
  const { functionCalls } = await extract(src, ['@myds/core']);
  const arg = functionCalls[0].args[0];
  assert.equal(arg.type, 'identifier');
  assert.ok(arg.sourceSnippet !== null, 'sourceSnippet should be set for identifier arg');
  assert.ok(
    arg.sourceSnippet.includes('createTheme'),
    'sourceSnippet should contain the call site',
  );
});

test('static string function arg has sourceSnippet: null', async () => {
  const src = `import { createTheme } from '@myds/core';
createTheme('light');
`;
  const { functionCalls } = await extract(src, ['@myds/core']);
  const arg = functionCalls[0].args[0];
  assert.equal(arg.type, 'string');
  assert.equal(arg.sourceSnippet, null);
});

test('sourceSnippet for dynamic prop includes up to 5 surrounding lines', async () => {
  // Build a source with clear context lines above and below the dynamic prop
  const src = `import { Card } from '@myds/card';
// line 2
// line 3
const el = <Card title={someTitle} />;
// line 5
// line 6
`;
  const { componentUsages } = await extract(src, ['@myds/card'], true);
  const titleProp = componentUsages[0].props.find(p => p.name === 'title');
  assert.ok(titleProp, 'title prop should exist');
  assert.ok(titleProp.sourceSnippet !== null, 'sourceSnippet should be set');
  const lines = titleProp.sourceSnippet.split('\n');
  // Should have at most 5 lines (2 before + target + 2 after)
  assert.ok(lines.length <= 5, `expected ≤5 lines in snippet, got ${lines.length}`);
  // The snippet must include the line with the prop usage
  assert.ok(
    titleProp.sourceSnippet.includes('someTitle'),
    'snippet should include the dynamic value',
  );
});

// ─── Default import method calls ─────────────────────────────────────────────

test('tracks method call on a default import (e.g. theme.spacing())', async () => {
  const src = `import theme from '@myds/tokens';
theme.spacing(2);
`;
  const { functionCalls } = await extract(src, ['@myds/tokens']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'theme.spacing');
  assert.equal(functionCalls[0].importedFrom, '@myds/tokens');
  assert.equal(functionCalls[0].args[0].type, 'number');
  assert.equal(functionCalls[0].args[0].value, 2);
});

test('tracks method call on a named import used as an object', async () => {
  const src = `import { colors } from '@myds/tokens';
colors.primary();
`;
  const { functionCalls } = await extract(src, ['@myds/tokens']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'colors.primary');
  assert.equal(functionCalls[0].importedFrom, '@myds/tokens');
});

// ─── Nested object property function calls ────────────────────────────────────

test('detects nested call on default import: ui.api.functionCall()', async () => {
  const src = `
    import ui from '@acme/ui';
    ui.api.functionCall('test');
  `;
  const { functionCalls } = await extract(src, ['@acme/ui']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'api.functionCall');
  assert.equal(functionCalls[0].importedFrom, '@acme/ui');
  assert.equal(functionCalls[0].args[0].type, 'string');
  assert.equal(functionCalls[0].args[0].value, 'test');
});

test('nested default import call normalises to same funcName as named import call', async () => {
  const src1 = `
    import ui from '@acme/ui';
    ui.api.functionCall('test');
  `;
  const src2 = `
    import { api } from '@acme/ui';
    api.functionCall('test');
  `;
  const result1 = await extract(src1, ['@acme/ui']);
  const result2 = await extract(src2, ['@acme/ui']);
  assert.equal(result1.functionCalls[0].functionName, result2.functionCalls[0].functionName,
    'nested default import call should produce same functionName as named import call');
  assert.equal(result1.functionCalls[0].importedFrom, result2.functionCalls[0].importedFrom,
    'both calls should resolve to the same package');
});

test('detects nested call on named import used as an object: lib.sub.fn()', async () => {
  const src = `
    import { lib } from '@acme/ui';
    lib.sub.fn(42);
  `;
  const { functionCalls } = await extract(src, ['@acme/ui']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'sub.fn');
  assert.equal(functionCalls[0].importedFrom, '@acme/ui');
  assert.equal(functionCalls[0].args[0].value, 42);
});

test('detects nested call on namespace import: DS.api.fn()', async () => {
  const src = `
    import * as DS from '@acme/ui';
    DS.api.fn('hello');
  `;
  const { functionCalls } = await extract(src, ['@acme/ui']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'DS.api.fn');
  assert.equal(functionCalls[0].importedFrom, '@acme/ui');
});

test('does not detect nested call when outermost object is not an import', async () => {
  const src = `
    import ui from '@acme/ui';
    someOther.api.functionCall('test');
  `;
  const { functionCalls } = await extract(src, ['@acme/ui']);
  assert.equal(functionCalls.length, 0);
});

// ─── NewExpression tracking ───────────────────────────────────────────────────

test('tracks new expression for a named constructor import', async () => {
  const src = `import { Command } from 'commander';
const program = new Command();
`;
  const { functionCalls } = await extract(src, ['commander']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'new Command');
  assert.equal(functionCalls[0].importedFrom, 'commander');
  assert.equal(functionCalls[0].args.length, 0);
});

test('tracks new expression with arguments', async () => {
  const src = `import { MyClass } from 'my-lib';
const x = new MyClass('arg1', 42);
`;
  const { functionCalls } = await extract(src, ['my-lib']);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].functionName, 'new MyClass');
  assert.equal(functionCalls[0].args.length, 2);
  assert.equal(functionCalls[0].args[0].value, 'arg1');
  assert.equal(functionCalls[0].args[1].value, 42);
});

// ─── Internal import filtering ────────────────────────────────────────────────

test('relative import (./foo) is not included in imports[]', async () => {
  const { imports } = await extract("import { foo } from './utils';");
  assert.equal(imports.length, 0);
});

test('parent-relative import (../foo) is not included in imports[]', async () => {
  const { imports } = await extract("import { bar } from '../lib/helpers';");
  assert.equal(imports.length, 0);
});

test('@/ aliased import is not included in imports[]', async () => {
  const { imports } = await extract("import { api } from '@/services/api';");
  assert.equal(imports.length, 0);
});

test('~/ aliased import is not included in imports[]', async () => {
  const { imports } = await extract("import { cfg } from '~/config';");
  assert.equal(imports.length, 0);
});

test('absolute path import is not included in imports[]', async () => {
  const { imports } = await extract("import { x } from '/absolute/path';");
  assert.equal(imports.length, 0);
});

test('bare package import is included in imports[]', async () => {
  const { imports } = await extract("import { useState } from 'react';");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, 'react');
});

test('scoped package import is included in imports[]', async () => {
  const { imports } = await extract("import { Button } from '@acme/ui';");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, '@acme/ui');
});

test('subpath import from external package is included in imports[]', async () => {
  const { imports } = await extract("import { Icon } from '@acme/ui/icons';");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, '@acme/ui/icons');
});

test('relative import does not produce component usage even with empty targetPackages', async () => {
  const src = `
    import { LocalBtn } from './components/Button';
    const el = <LocalBtn variant="primary" />;
  `;
  const { componentUsages, imports } = await extract(src, [], true);
  assert.equal(imports.length, 0, 'internal import should not appear in imports');
  assert.equal(componentUsages.length, 0, 'local component should not be tracked');
});

test('@/ aliased import does not produce function call usage even with empty targetPackages', async () => {
  const src = `
    import { fetchUser } from '@/api/users';
    fetchUser('123');
  `;
  const { functionCalls, imports } = await extract(src, []);
  assert.equal(imports.length, 0, 'aliased import should not appear in imports');
  assert.equal(functionCalls.length, 0, 'aliased function should not be tracked');
});

test('mix of internal and external imports: only external appear in imports[]', async () => {
  const src = `
    import { Button } from '@acme/ui';
    import { helper } from './utils';
    import { api } from '@/services/api';
    import { formatDate } from '@acme/utils';
  `;
  const { imports } = await extract(src);
  assert.equal(imports.length, 2);
  assert.deepEqual(imports.map(i => i.source).sort(), ['@acme/ui', '@acme/utils']);
});

// ─── knownPackages: alias vs dependency filtering ────────────────────────────

test('excludes alias import when not in knownPackages', async () => {
  // @components is a webpack/Vite alias, not an npm package
  const src = `import { Button } from '@components/Button';`;
  const { imports } = await extract(src, [], false, ['react', '@acme/ui']);
  assert.equal(imports.length, 0, 'alias import should be excluded when not in knownPackages');
});

test('real package import is included when it is in knownPackages', async () => {
  const src = `import { Button } from '@acme/ui';`;
  const { imports } = await extract(src, [], false, ['react', '@acme/ui']);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, '@acme/ui');
});

test('subpath import is included when parent package is in knownPackages', async () => {
  const src = `import { Icon } from '@acme/ui/icons';`;
  const { imports } = await extract(src, [], false, ['react', '@acme/ui']);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, '@acme/ui/icons');
});

test('unscoped package subpath import is included when parent package is in knownPackages', async () => {
  const src = `import { createPortal } from 'react-dom/client';`;
  const { imports } = await extract(src, [], false, ['react', 'react-dom']);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].source, 'react-dom/client');
});

test('alias import does not produce component usage when knownPackages is provided', async () => {
  const src = `
    import { Card } from '@components/Card';
    const el = <Card title="hello" />;
  `;
  const { componentUsages, imports } = await extract(src, [], true, ['react', '@acme/ui']);
  assert.equal(imports.length, 0, 'alias import should not appear in imports');
  assert.equal(componentUsages.length, 0, 'alias component should not be tracked');
});

test('alias import does not produce function call usage when knownPackages is provided', async () => {
  const src = `
    import { fetchUser } from '@api/users';
    fetchUser('123');
  `;
  const { functionCalls, imports } = await extract(src, [], false, ['react', '@acme/utils']);
  assert.equal(imports.length, 0, 'alias import should not appear in imports');
  assert.equal(functionCalls.length, 0, 'alias function should not be tracked');
});

test('without knownPackages, alias-looking imports are still treated as external (backward compat)', async () => {
  // When knownPackages is not provided, fall back to old behavior
  const src = `import { Button } from '@components/Button';`;
  const { imports } = await extract(src);
  assert.equal(imports.length, 1, 'without knownPackages, all non-relative imports are treated as external');
  assert.equal(imports[0].source, '@components/Button');
});

test('mix of known packages and aliases: only known packages included', async () => {
  const src = `
    import { Button } from '@acme/ui';
    import { Card } from '@components/Card';
    import { useState } from 'react';
    import { helper } from '@utils/helper';
  `;
  const { imports } = await extract(src, [], false, ['react', '@acme/ui']);
  assert.equal(imports.length, 2);
  assert.deepEqual(imports.map(i => i.source).sort(), ['@acme/ui', 'react']);
});
