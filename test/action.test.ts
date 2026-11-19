import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_PATHS } from '../src/inputs';

const root = join(__dirname, '..');

/** Parses a YAML file the same way GitHub reads action.yml and workflows. */
const loadYaml = (file: string): Record<string, unknown> => parse(readFileSync(file, 'utf8'));

describe('action.yml', () => {
  it('parses and declares the documented inputs and outputs', () => {
    const action = loadYaml(join(root, 'action.yml'));

    expect(Object.keys(action.inputs as object)).toEqual([
      'api-key',
      'paths',
      'changed-only',
      'fail-below',
      'fail-on',
      'comment',
      'fail-on-quota',
      'github-token',
      'api-url',
      'timeout-minutes',
    ]);
    expect(Object.keys(action.outputs as object)).toEqual(['results', 'failed']);
    expect((action.inputs as Record<string, { default?: string }>).paths!.default).toBe(DEFAULT_PATHS);
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.js' });
  });

  it.each(readdirSync(join(root, '.github', 'workflows')))('workflow %s parses', (file) => {
    expect(loadYaml(join(root, '.github', 'workflows', file))).toHaveProperty('jobs');
  });
});
