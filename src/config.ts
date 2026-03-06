import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { UsegraphConfig } from './types.js';

const CONFIG_FILENAMES = [
  'usegraph.config.json',
  '.usegraphrc',
  '.usegraphrc.json',
];

export const DEFAULT_CONFIG: UsegraphConfig = {
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
    include: overrides.include ?? defaults.include,
    exclude: overrides.exclude ?? defaults.exclude,
  };
}

export function writeDefaultConfig(projectPath: string): void {
  const configPath = join(projectPath, 'usegraph.config.json');
  const config = {
    include: [...DEFAULT_CONFIG.include],
    exclude: [...DEFAULT_CONFIG.exclude],
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
