import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { UsegraphConfig } from './types.js';

const CONFIG_FILENAMES = [
  'usegraph.config.json',
  '.usegraphrc',
  '.usegraphrc.json',
];

export const DEFAULT_CONFIG: UsegraphConfig = {
  targetPackages: [],
  internalPackages: [],
  include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/*.d.ts',
    '**/*.test.*',
    '**/*.spec.*',
    '**/coverage/**',
    '**/.next/**',
    '**/.nuxt/**',
  ],
  // Empty string means "use the global ~/.usegraph/<slug> store".
  // A non-empty value (e.g. ".usegraph") overrides to a project-local directory.
  outputDir: '',
};

export function loadConfig(projectPath: string): UsegraphConfig {
  for (const name of CONFIG_FILENAMES) {
    const configPath = join(projectPath, name);
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<UsegraphConfig>;
        return mergeConfig(DEFAULT_CONFIG, parsed);
      } catch (err) {
        process.stderr.write(
          `Warning: Failed to parse config file ${configPath}: ${String(err)}\n` +
          `         Falling back to default configuration.\n`,
        );
        // Fall through to defaults
      }
    }
  }
  return { ...DEFAULT_CONFIG };
}

function mergeConfig(defaults: UsegraphConfig, overrides: Partial<UsegraphConfig>): UsegraphConfig {
  return {
    targetPackages: overrides.targetPackages ?? defaults.targetPackages,
    internalPackages: overrides.internalPackages ?? defaults.internalPackages,
    include: overrides.include ?? defaults.include,
    exclude: overrides.exclude ?? defaults.exclude,
    outputDir: overrides.outputDir ?? defaults.outputDir,
  };
}

export function writeDefaultConfig(projectPath: string): void {
  const configPath = join(projectPath, 'usegraph.config.json');
  // Omit outputDir so the global ~/.usegraph/<slug> store is used by default.
  // Users can add "outputDir": ".usegraph" to opt into project-local storage.
  const config = {
    targetPackages: ['your-package-name'],
    include: [...DEFAULT_CONFIG.include],
    exclude: [...DEFAULT_CONFIG.exclude],
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
