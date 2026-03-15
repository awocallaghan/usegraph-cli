/**
 * Unit tests for the Python source file analyzer.
 *
 * Tests the tree-sitter-based parser that extracts imports and function-call
 * usages from .py files.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromPythonSource } from '../dist/analyzer/python-file-analyzer.js';

const FAKE_PATH = '/project/src/app.py';

// ─── Helper ───────────────────────────────────────────────────────────────────

function extract(source, targets = []) {
  return extractFromPythonSource(source, FAKE_PATH, new Set(targets));
}

// ─── Import extraction ────────────────────────────────────────────────────────

describe('import extraction', () => {
  test('from X import Y records a named import', () => {
    const { imports } = extract('from fastapi import FastAPI\n');
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'fastapi');
    assert.equal(imports[0].specifiers.length, 1);
    assert.equal(imports[0].specifiers[0].imported, 'FastAPI');
    assert.equal(imports[0].specifiers[0].type, 'named');
  });

  test('from X import Y, Z records multiple named imports under one source', () => {
    const { imports } = extract('from fastapi import FastAPI, HTTPException\n');
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'fastapi');
    assert.equal(imports[0].specifiers.length, 2);
    const names = imports[0].specifiers.map(s => s.imported);
    assert.ok(names.includes('FastAPI'));
    assert.ok(names.includes('HTTPException'));
  });

  test('from X import Y as alias records correct local name', () => {
    const { imports } = extract('from flask import Flask as App\n');
    assert.equal(imports[0].specifiers[0].imported, 'Flask');
    assert.equal(imports[0].specifiers[0].local, 'App');
  });

  test('from X.Y import Z uses top-level package as source', () => {
    const { imports } = extract('from fastapi.middleware.cors import CORSMiddleware\n');
    assert.equal(imports[0].source, 'fastapi');
    assert.equal(imports[0].specifiers[0].imported, 'CORSMiddleware');
  });

  test('import X records a namespace import', () => {
    const { imports } = extract('import pandas\n');
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'pandas');
    assert.equal(imports[0].specifiers[0].type, 'namespace');
  });

  test('import X as alias records namespace import with alias', () => {
    const { imports } = extract('import pandas as pd\n');
    assert.equal(imports[0].source, 'pandas');
    assert.equal(imports[0].specifiers[0].local, 'pd');
    assert.equal(imports[0].specifiers[0].type, 'namespace');
  });

  test('import X.Y binds the top-level name X as local', () => {
    const { imports } = extract('import fastapi.routing\n');
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'fastapi');
    assert.equal(imports[0].specifiers[0].local, 'fastapi');
    assert.equal(imports[0].specifiers[0].imported, 'fastapi.routing');
    assert.equal(imports[0].specifiers[0].type, 'namespace');
  });

  test('import X.Y as alias binds the alias as local', () => {
    const { imports } = extract('import fastapi.routing as router\n');
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'fastapi');
    assert.equal(imports[0].specifiers[0].local, 'router');
    assert.equal(imports[0].specifiers[0].imported, 'fastapi.routing');
    assert.equal(imports[0].specifiers[0].type, 'namespace');
  });

  test('stdlib imports are not recorded', () => {
    const { imports } = extract('import os\nimport sys\nfrom typing import List\n');
    assert.equal(imports.length, 0);
  });

  test('relative imports are not recorded', () => {
    const { imports } = extract('from . import utils\nfrom ..models import User\n');
    assert.equal(imports.length, 0);
  });

  test('multiple from-import lines from same package are merged', () => {
    const src = 'from fastapi import FastAPI\nfrom fastapi import HTTPException\n';
    const { imports } = extract(src);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'fastapi');
    assert.equal(imports[0].specifiers.length, 2);
  });

  test('multi-line parenthesised import is parsed correctly', () => {
    const src = 'from fastapi import (\n    FastAPI,\n    HTTPException,\n    Depends,\n)\n';
    const { imports } = extract(src);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source, 'fastapi');
    const names = imports[0].specifiers.map(s => s.imported);
    assert.ok(names.includes('FastAPI'));
    assert.ok(names.includes('HTTPException'));
    assert.ok(names.includes('Depends'));
  });

  test('multi-line import: calls to imported names are captured', () => {
    const src = 'from fastapi import (\n    FastAPI,\n    HTTPException,\n)\napp = FastAPI()\nraise HTTPException(status_code=404)\n';
    const { functionCalls } = extract(src, ['fastapi']);
    const names = functionCalls.map(c => c.functionName);
    assert.ok(names.includes('FastAPI'), `Expected FastAPI, got: ${JSON.stringify(names)}`);
    assert.ok(names.includes('HTTPException'), `Expected HTTPException, got: ${JSON.stringify(names)}`);
  });

  test('backslash continuation import captures all names', () => {
    const src = 'from fastapi import FastAPI, \\\n    HTTPException, Depends\napp = FastAPI()\n';
    const { imports, functionCalls } = extract(src, ['fastapi']);
    const names = imports[0]?.specifiers.map(s => s.imported) ?? [];
    assert.ok(names.includes('FastAPI'));
    assert.ok(names.includes('HTTPException'));
    assert.ok(names.includes('Depends'));
    assert.ok(functionCalls.map(c => c.functionName).includes('FastAPI'));
  });
});

// ─── Function call detection ──────────────────────────────────────────────────

describe('function call detection', () => {
  test('direct call to imported name is captured', () => {
    const src = 'from flask import Flask\napp = Flask(__name__)\n';
    const { functionCalls } = extract(src, ['flask']);
    assert.equal(functionCalls.length, 1);
    assert.equal(functionCalls[0].functionName, 'Flask');
    assert.equal(functionCalls[0].importedFrom, 'flask');
    assert.equal(functionCalls[0].line, 2);
  });

  test('namespace call is captured (pd.DataFrame)', () => {
    const src = 'import pandas as pd\ndf = pd.DataFrame({"a": [1,2,3]})\n';
    const { functionCalls } = extract(src, ['pandas']);
    assert.equal(functionCalls.length, 1);
    assert.equal(functionCalls[0].functionName, 'pd.DataFrame');
    assert.equal(functionCalls[0].importedFrom, 'pandas');
  });

  test('import X.Y allows calling X.method() via top-level binding', () => {
    const src = 'import fastapi.routing\nroute = fastapi.APIRoute("/", handler)\n';
    const { functionCalls } = extract(src, ['fastapi']);
    assert.equal(functionCalls.length, 1);
    assert.equal(functionCalls[0].functionName, 'fastapi.APIRoute');
    assert.equal(functionCalls[0].importedFrom, 'fastapi');
  });

  test('calls to non-targeted packages are NOT captured', () => {
    const src = 'from flask import Flask\napp = Flask(__name__)\n';
    const { functionCalls } = extract(src, ['fastapi']); // wrong target
    assert.equal(functionCalls.length, 0);
  });

  test('multiple calls in same file are all captured', () => {
    const src = [
      'from fastapi import FastAPI, HTTPException',
      'app = FastAPI()',
      'raise HTTPException(status_code=404, detail="Not found")',
    ].join('\n') + '\n';
    const { functionCalls } = extract(src, ['fastapi']);
    assert.equal(functionCalls.length, 2);
    const names = functionCalls.map(c => c.functionName);
    assert.ok(names.includes('FastAPI'));
    assert.ok(names.includes('HTTPException'));
  });

  test('call inside a comment is not captured', () => {
    const src = 'from flask import Flask\n# app = Flask(__name__)\n';
    const { functionCalls } = extract(src, ['flask']);
    assert.equal(functionCalls.length, 0);
  });

  test('calls from aliased imports are captured', () => {
    const src = 'from fastapi import FastAPI as FA\napp = FA()\n';
    const { functionCalls } = extract(src, ['fastapi']);
    assert.equal(functionCalls.length, 1);
    assert.equal(functionCalls[0].functionName, 'FA');
    assert.equal(functionCalls[0].importedFrom, 'fastapi');
  });

  test('stdlib calls do not appear even if name matches', () => {
    const src = 'import os\nresult = os.path.join("a", "b")\n';
    const { functionCalls } = extract(src, ['os']);
    // os is stdlib — should not be captured
    assert.equal(functionCalls.length, 0);
  });
});

// ─── Argument parsing ─────────────────────────────────────────────────────────

describe('argument parsing', () => {
  test('string literal argument is extracted', () => {
    const src = 'from fastapi import FastAPI\napp = FastAPI(title="my-app")\n';
    const { functionCalls } = extract(src, ['fastapi']);
    const stringArgs = functionCalls[0].args.filter(a => a.type === 'string');
    assert.ok(stringArgs.length >= 1);
    assert.equal(stringArgs[0].value, 'my-app');
  });

  test('integer argument is extracted', () => {
    const src = 'from fastapi import HTTPException\nraise HTTPException(status_code=404)\n';
    const { functionCalls } = extract(src, ['fastapi']);
    const numArgs = functionCalls[0].args.filter(a => a.type === 'number');
    assert.ok(numArgs.length >= 1);
    assert.equal(numArgs[0].value, 404);
  });

  test('dynamic/expression argument is marked as expression', () => {
    const src = 'from flask import Flask\napp = Flask(__name__)\n';
    const { functionCalls } = extract(src, ['flask']);
    assert.equal(functionCalls[0].args.length, 1);
    assert.equal(functionCalls[0].args[0].type, 'expression');
  });

  test('no args call produces empty args array', () => {
    const src = 'from fastapi import FastAPI\napp = FastAPI()\n';
    const { functionCalls } = extract(src, ['fastapi']);
    assert.equal(functionCalls[0].args.length, 0);
  });
});

// ─── Named import used as module namespace ────────────────────────────────────

describe('named import used as namespace', () => {
  test('from X import models then models.Field() is captured', () => {
    const src = 'from django.db import models\nclass A(models.Model):\n    x = models.CharField(max_length=200)\n';
    const { functionCalls } = extract(src, ['django']);
    const names = functionCalls.map(c => c.functionName);
    assert.ok(names.includes('models.CharField'), `Expected models.CharField, got: ${JSON.stringify(names)}`);
  });

  test('from X import models: direct Model base ref is not a call', () => {
    // models.Model appears in class inheritance, not as a call
    const src = 'from django.db import models\nclass A(models.Model):\n    pass\n';
    const { functionCalls } = extract(src, ['django']);
    // models.Model( has no ( after it, so it won't be matched as a call
    assert.equal(functionCalls.length, 0);
  });
});

// ─── componentUsages is always empty for Python ──────────────────────────────

test('componentUsages is always an empty array for Python files', () => {
  const src = 'from fastapi import FastAPI\napp = FastAPI()\n';
  const { componentUsages } = extract(src, ['fastapi']);
  assert.deepEqual(componentUsages, []);
});

// ─── Fixture file smoke test ──────────────────────────────────────────────────

describe('fixture file content', () => {
  test('py-web main.py: detects FastAPI imports and calls', () => {
    const src = `from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="py-web", version="0.1.0")

raise HTTPException(status_code=404, detail="Item not found")
`;
    const { imports, functionCalls } = extract(src, ['fastapi']);

    const fastapiImport = imports.find(i => i.source === 'fastapi');
    assert.ok(fastapiImport, 'fastapi import should be present');
    const importedNames = fastapiImport.specifiers.map(s => s.imported);
    assert.ok(importedNames.includes('FastAPI'));
    assert.ok(importedNames.includes('CORSMiddleware'));

    const callNames = functionCalls.map(c => c.functionName);
    assert.ok(callNames.includes('FastAPI'), `Expected FastAPI in calls, got: ${JSON.stringify(callNames)}`);
    assert.ok(callNames.includes('HTTPException'), `Expected HTTPException in calls, got: ${JSON.stringify(callNames)}`);
  });

  test('py-data app.py: detects Flask imports and calls', () => {
    const src = `from flask import Flask, request, jsonify
import pandas as pd

app = Flask(__name__)
`;
    const { imports, functionCalls } = extract(src, ['flask', 'pandas']);

    const flaskImport = imports.find(i => i.source === 'flask');
    assert.ok(flaskImport, 'flask import should be present');

    const pandasImport = imports.find(i => i.source === 'pandas');
    assert.ok(pandasImport, 'pandas import should be present');

    const callNames = functionCalls.map(c => c.functionName);
    assert.ok(callNames.includes('Flask'), `Expected Flask in calls, got: ${JSON.stringify(callNames)}`);
  });
});
