/**
 * Meta-analyzer: reads package.json and detects tooling configuration files.
 *
 * This implements the STRETCH goal of collecting dependency/tooling information
 * for organisation-wide tech-stack reporting.
 *
 * All operations are synchronous-safe (uses readFileSync) since this runs once
 * per project before the file scan begins.
 */
import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import type { DependencyEntry, ProjectMeta, ToolingInfo } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Tooling detection table
// Each entry defines: display name, candidate config file names (in priority
// order), and optionally which top-level JSON keys to extract as settings.
// ─────────────────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  /** Config filenames to check, in order of priority */
  candidates: string[];
  /** For JSON configs: which top-level keys to extract (undefined = all) */
  jsonKeys?: string[];
}

const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'TypeScript',
    candidates: ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json'],
    jsonKeys: ['compilerOptions'],
  },
  {
    name: 'ESLint',
    candidates: [
      'eslint.config.js',
      'eslint.config.ts',
      'eslint.config.mjs',
      '.eslintrc.json',
      '.eslintrc.js',
      '.eslintrc.yml',
      '.eslintrc.yaml',
      '.eslintrc',
    ],
    jsonKeys: ['root', 'parser', 'extends', 'plugins', 'rules'],
  },
  {
    name: 'Prettier',
    candidates: [
      'prettier.config.js',
      'prettier.config.ts',
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.yml',
      '.prettierrc.yaml',
      '.prettierrc.js',
    ],
    jsonKeys: ['semi', 'singleQuote', 'tabWidth', 'trailingComma', 'printWidth'],
  },
  {
    name: 'Babel',
    candidates: ['babel.config.json', 'babel.config.js', 'babel.config.ts', '.babelrc', '.babelrc.json'],
    jsonKeys: ['presets', 'plugins'],
  },
  {
    name: 'Jest',
    candidates: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json'],
    jsonKeys: ['testEnvironment', 'transform', 'moduleNameMapper', 'setupFilesAfterFramework'],
  },
  {
    name: 'Vitest',
    candidates: ['vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs'],
  },
  {
    name: 'Vite',
    candidates: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'],
  },
  {
    name: 'Webpack',
    candidates: ['webpack.config.js', 'webpack.config.ts', 'webpack.config.mjs', 'webpack.config.cjs'],
  },
  {
    name: 'Rollup',
    candidates: ['rollup.config.js', 'rollup.config.ts', 'rollup.config.mjs'],
  },
  {
    name: 'esbuild',
    candidates: ['esbuild.config.js', 'esbuild.config.ts', 'esbuild.config.mjs'],
  },
  {
    name: 'PostCSS',
    candidates: ['postcss.config.js', 'postcss.config.ts', 'postcss.config.cjs', '.postcssrc', '.postcssrc.json'],
    jsonKeys: ['plugins'],
  },
  {
    name: 'Tailwind CSS',
    candidates: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs', 'tailwind.config.cjs'],
  },
  {
    name: 'Next.js',
    candidates: ['next.config.js', 'next.config.ts', 'next.config.mjs', 'next.config.cjs'],
  },
  {
    name: 'Nuxt',
    candidates: ['nuxt.config.js', 'nuxt.config.ts', 'nuxt.config.mjs'],
  },
  {
    name: 'Astro',
    candidates: ['astro.config.js', 'astro.config.ts', 'astro.config.mjs'],
  },
  {
    name: 'SvelteKit',
    candidates: ['svelte.config.js', 'svelte.config.ts'],
  },
  {
    name: 'Remix',
    candidates: ['remix.config.js', 'remix.config.ts'],
  },
  {
    name: 'Playwright',
    candidates: ['playwright.config.js', 'playwright.config.ts', 'playwright.config.mjs'],
  },
  {
    name: 'Cypress',
    candidates: ['cypress.config.js', 'cypress.config.ts', 'cypress.config.mjs'],
    jsonKeys: ['e2e', 'component'],
  },
  {
    name: 'Storybook',
    candidates: ['.storybook/main.js', '.storybook/main.ts', '.storybook/main.mjs'],
  },
  {
    name: 'Docker',
    candidates: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
  },
  {
    name: 'Turborepo',
    candidates: ['turbo.json'],
    jsonKeys: ['pipeline', 'tasks'],
  },
  {
    name: 'Nx',
    candidates: ['nx.json'],
    jsonKeys: ['tasksRunnerOptions', 'targetDefaults'],
  },
  {
    name: 'Lerna',
    candidates: ['lerna.json'],
    jsonKeys: ['version', 'packages', 'npmClient'],
  },
  {
    name: 'pnpm workspaces',
    candidates: ['pnpm-workspace.yaml'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function analyzeProjectMeta(projectPath: string): ProjectMeta {
  const packageJsonPath = join(projectPath, 'package.json');
  let packageName = '';
  let packageVersion = '';
  const dependencies: DependencyEntry[] = [];
  let parsedPkg: Record<string, unknown> | null = null;

  if (existsSync(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      parsedPkg = JSON.parse(raw) as Record<string, unknown>;

      packageName = typeof parsedPkg['name'] === 'string' ? parsedPkg['name'] : '';
      packageVersion = typeof parsedPkg['version'] === 'string' ? parsedPkg['version'] : '';

      const sections: Array<DependencyEntry['section']> = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ];

      for (const section of sections) {
        const block = parsedPkg[section];
        if (block && typeof block === 'object') {
          for (const [name, version] of Object.entries(block as Record<string, string>)) {
            dependencies.push({ name, versionRange: version, section });
          }
        }
      }
    } catch {
      // package.json unreadable/invalid — continue with empty data
    }
  }

  const tooling = detectTooling(projectPath);

  // Check package.json inline config sections (jest, eslintConfig, prettier, workspaces)
  if (parsedPkg) {
    const extraTooling = detectToolingFromPackageJson(parsedPkg, projectPath);
    for (const t of extraTooling) {
      if (!tooling.some((existing) => existing.name === t.name)) {
        tooling.push(t);
      }
    }
  }

  return { packageName, packageVersion, dependencies, tooling };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooling detection
// ─────────────────────────────────────────────────────────────────────────────

function detectTooling(projectPath: string): ToolingInfo[] {
  const found: ToolingInfo[] = [];

  for (const tool of TOOL_DEFINITIONS) {
    for (const candidate of tool.candidates) {
      const fullPath = join(projectPath, candidate);
      if (existsSync(fullPath)) {
        const configFile = relative(projectPath, fullPath);
        const settings = tryExtractJsonSettings(fullPath, tool.jsonKeys);
        found.push({ name: tool.name, configFile, settings });
        break; // only record first matching config file per tool
      }
    }
  }

  return found;
}

/**
 * Detect additional tooling by inspecting package.json fields:
 * - `jest` key → Jest configured inline
 * - `eslintConfig` key → ESLint configured inline
 * - `prettier` key → Prettier configured inline
 * - `engines` key → Node/npm requirements
 * - `workspaces` key → npm/yarn workspaces
 */
function detectToolingFromPackageJson(
  pkg: Record<string, unknown>,
  projectPath: string,
): ToolingInfo[] {
  const found: ToolingInfo[] = [];

  if (pkg['jest'] && typeof pkg['jest'] === 'object') {
    const settings = pickKeys(pkg['jest'] as Record<string, unknown>, [
      'testEnvironment',
      'transform',
      'moduleNameMapper',
    ]);
    found.push({ name: 'Jest', configFile: 'package.json#jest', settings });
  }

  if (pkg['eslintConfig'] && typeof pkg['eslintConfig'] === 'object') {
    const settings = pickKeys(pkg['eslintConfig'] as Record<string, unknown>, [
      'root',
      'parser',
      'extends',
      'plugins',
    ]);
    found.push({ name: 'ESLint', configFile: 'package.json#eslintConfig', settings });
  }

  if (pkg['prettier'] && typeof pkg['prettier'] === 'object') {
    found.push({
      name: 'Prettier',
      configFile: 'package.json#prettier',
      settings: pkg['prettier'] as Record<string, unknown>,
    });
  }

  if (pkg['workspaces']) {
    const manager = existsSync(join(projectPath, 'yarn.lock'))
      ? 'Yarn workspaces'
      : 'npm workspaces';
    found.push({
      name: manager,
      configFile: 'package.json#workspaces',
      settings: Array.isArray(pkg['workspaces'])
        ? { packages: pkg['workspaces'] }
        : (pkg['workspaces'] as Record<string, unknown>),
    });
  }

  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

function tryExtractJsonSettings(
  filePath: string,
  keys: string[] | undefined,
): Record<string, unknown> | null {
  const filenameStart = filePath.lastIndexOf('/') + 1;
  const filename = filePath.slice(filenameStart);
  const dotInName = filename.indexOf('.', filename.startsWith('.') ? 1 : 0);
  const ext = dotInName >= 0 ? filename.slice(dotInName) : '';

  // Attempt JSON parsing for .json, .jsonc, files with no extension,
  // and dotfiles without a secondary extension (e.g. .eslintrc, .babelrc)
  const jsonExtensions = new Set(['.json', '.jsonc', '']);
  const isDotfileNoExt = filename.startsWith('.') && !filename.includes('.', 1);
  if (!jsonExtensions.has(ext) && !isDotfileNoExt) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (keys && keys.length > 0) {
      return pickKeys(parsed, keys);
    }
    return parsed;
  } catch {
    return null;
  }
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
}
